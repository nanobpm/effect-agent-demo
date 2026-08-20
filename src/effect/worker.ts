import { Duration, Effect, ManagedRuntime, Schedule } from "effect";
import type { Layer, Scope } from "effect";
import type { ActivatedJob, JsonObject, NanoSdkClient } from "@nanobpm/workflow";
import { isTransient } from "./errors.ts";
import type { AgentError } from "./errors.ts";

/**
 * The Effect job-worker surface (S2). The published target is
 * `@camunda8/orchestration-cluster-api/effect` (#438): `activateJobs → handle →
 * complete/fail` as Effect, with `Stream`/`Layer`/`TestClock`. Until that ships,
 * this module implements the same shape over the Promise-based nano-sdk job
 * worker that `@nanobpm/workflow`'s `WorkflowClient` exposes — swap the internals
 * of `serveAgents` for the published surface when it lands; the agent handlers
 * and `handleJob` core are unchanged.
 */

/** A job as delivered to an Effect agent handler — the engine payload only. */
export interface EffectJob {
  readonly jobKey: string;
  readonly type: string;
  readonly variables: JsonObject;
}

/** An agent worker: a job in, an Effect producing the completion variables. `R`
 *  is the agent's environment (e.g. the `Llm` service), satisfied by a `Layer`. */
export type AgentHandler<R = never> = (job: EffectJob) => Effect.Effect<JsonObject, AgentError, R>;

/** A registered agent: which job type it serves and how it retries. */
export interface AgentSpec<R = never> {
  readonly jobType: string;
  readonly handler: AgentHandler<R>;
  /** Transient-failure retries attempted in-worker before the engine sees a
   *  failure. Default 3. */
  readonly maxRetries?: number;
  /** Base delay of the exponential backoff. Default 200ms. Expressed as an
   *  Effect sleep, so it is virtual (instant + deterministic) under `TestClock`. */
  readonly baseBackoff?: Duration.Duration;
}

/** The engine acknowledgement actions, abstracted so `handleJob` is testable
 *  without a live engine. */
export interface JobActions {
  readonly complete: (variables: JsonObject) => Effect.Effect<void>;
  readonly fail: (errorMessage: string, retries: number) => Effect.Effect<void>;
}

/** What became of a single job — surfaced to tests and observers. */
export type JobOutcome =
  | { readonly _tag: "completed"; readonly jobType: string; readonly jobKey: string; readonly variables: JsonObject }
  | { readonly _tag: "failed"; readonly jobType: string; readonly jobKey: string; readonly reason: string; readonly retries: number };

/**
 * The deterministic retry policy for an agent: an exponential backoff, capped at
 * `maxRetries`, that only retries *transient* failures — a `PermanentAgentError`
 * short-circuits immediately (no wasted attempts, fast incident).
 */
export const retrySchedule = (spec: Pick<AgentSpec, "baseBackoff" | "maxRetries">) =>
  Schedule.exponential(spec.baseBackoff ?? Duration.millis(200)).pipe(
    Schedule.compose(Schedule.recurs(spec.maxRetries ?? 3)),
  );

/**
 * Run one activated job through its agent, translating the Effect's outcome into
 * an engine acknowledgement. Never fails: a transient error is retried on the
 * backoff and, if still failing, fails the job with `retries: 0` (raise an
 * incident); a permanent error fails it immediately. Returns the `JobOutcome`.
 */
export const handleJob = <R>(
  spec: AgentSpec<R>,
  job: EffectJob,
  actions: JobActions,
): Effect.Effect<JobOutcome, never, R> =>
  spec.handler(job).pipe(
    Effect.retry({ schedule: retrySchedule(spec), while: isTransient }),
    Effect.matchEffect({
      onSuccess: (variables) =>
        actions.complete(variables).pipe(
          Effect.as<JobOutcome>({ _tag: "completed", jobType: spec.jobType, jobKey: job.jobKey, variables }),
        ),
      onFailure: (error: AgentError) =>
        actions.fail(error.reason, 0).pipe(
          Effect.as<JobOutcome>({ _tag: "failed", jobType: spec.jobType, jobKey: job.jobKey, reason: error.reason, retries: 0 }),
        ),
    }),
  );

const actionsForActivatedJob = (job: ActivatedJob): JobActions => ({
  complete: (variables) => Effect.promise(() => job.complete(variables)).pipe(Effect.asVoid),
  fail: (errorMessage, retries) => Effect.promise(() => job.fail({ errorMessage, retries })).pipe(Effect.asVoid),
});

/** An observer of every job outcome (metrics, logs, test assertions). */
export type OnOutcome = (outcome: JobOutcome) => void;

/**
 * Serve a set of agents against a live engine. Each agent gets a `Scope`d job
 * lease (`acquireRelease` starts the nano-sdk worker and guarantees it is stopped
 * when the scope closes), and each activated job is driven through `handleJob` on
 * a `ManagedRuntime` built from the agent environment `Layer`. Returns a scoped
 * Effect — keep the scope open (e.g. `Effect.never`) to keep serving.
 */
export const serveAgents = <R, RErr>(
  sdk: NanoSdkClient,
  layer: Layer.Layer<R, RErr>,
  specs: ReadonlyArray<AgentSpec<R>>,
  onOutcome?: OnOutcome,
): Effect.Effect<void, never, Scope.Scope> =>
  Effect.gen(function* () {
    const runtime = ManagedRuntime.make(layer);
    yield* Effect.acquireRelease(
      Effect.sync(() => runtime),
      (rt) => Effect.promise(() => rt.dispose()),
    );

    yield* Effect.forEach(
      specs,
      (spec) =>
        Effect.acquireRelease(
          Effect.sync(() => {
            const worker = sdk.createJobWorker({
              jobType: spec.jobType,
              autoStart: false,
              jobHandler: async (job) => {
                // Observer failures (logging/metrics) must never be mistaken for a
                // job defect: the job outcome is already decided, so swallow any
                // throw here rather than let it fail the job or escape as an
                // unhandled rejection.
                const notify = (outcome: JobOutcome) => {
                  try {
                    onOutcome?.(outcome);
                  } catch {
                    /* ignore observer errors */
                  }
                };
                try {
                  const outcome = await runtime.runPromise(
                    handleJob(spec, { jobKey: job.jobKey, type: job.type, variables: job.variables }, actionsForActivatedJob(job)),
                  );
                  notify(outcome);
                } catch (cause) {
                  // `handleJob` never fails in its typed channel, so a rejection here
                  // means an unexpected runtime/layer defect. Fail the job
                  // deterministically (raise an incident) rather than let the
                  // rejection escape the nano-sdk callback as an unhandled rejection.
                  const reason = cause instanceof Error ? cause.message : String(cause);
                  await job.fail({ errorMessage: `worker defect (${spec.jobType}): ${reason}`, retries: 0 }).catch(() => {});
                  notify({ _tag: "failed", jobType: spec.jobType, jobKey: job.jobKey, reason, retries: 0 });
                }
              },
            });
            worker.start();
            return worker;
          }),
          (worker) =>
            Effect.promise(async () => {
              if (worker.stopGracefully) await worker.stopGracefully();
              else await worker.stop();
            }),
        ),
      { discard: true },
    );
  });
