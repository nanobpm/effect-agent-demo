import { test } from "node:test";
import assert from "node:assert/strict";
import { Duration, Effect, Fiber, Ref } from "effect";
import { TestClock } from "effect/testing";
import type { JsonObject } from "@nanobpm/workflow";
import { handleJob } from "../src/effect/worker.ts";
import type { AgentHandler, EffectJob, JobActions, JobOutcome } from "../src/effect/worker.ts";
import { PermanentAgentError, TransientAgentError } from "../src/effect/errors.ts";

/**
 * The Effect job-worker core (the S2 `handle → complete/fail` step) under
 * `TestClock`. Every retry backoff is an Effect sleep, so virtual time makes the
 * behaviour instant AND deterministic — the categorical win the epic is about:
 * time-bounded agent behaviour that is reproducible under test.
 */

const job: EffectJob = { jobKey: "j1", type: "agent:test", variables: {} };

const recorder = () => {
  const completes: JsonObject[] = [];
  const fails: Array<{ message: string; retries: number }> = [];
  const actions: JobActions = {
    complete: (variables) => Effect.sync(() => void completes.push(variables)),
    fail: (message, retries) => Effect.sync(() => void fails.push({ message, retries })),
  };
  return { completes, fails, actions };
};

/** Fork the effect, advance virtual time to release all pending backoff sleeps,
 *  then join — the canonical TestClock testing shape. */
const runVirtual = <A>(effect: Effect.Effect<A>, advance = Duration.seconds(60)): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(effect);
        yield* TestClock.adjust(advance);
        return yield* Fiber.join(fiber);
      }),
    ).pipe(Effect.provide(TestClock.layer())),
  );

const flaky = (attempts: Ref.Ref<number>, failFor: number): AgentHandler => (j) =>
  Effect.gen(function* () {
    const n = yield* Ref.updateAndGet(attempts, (x) => x + 1);
    if (n <= failFor) return yield* Effect.fail(new TransientAgentError({ agent: "flaky", reason: `blip ${n}` }));
    return { ok: true, attempt: n } satisfies JsonObject;
  });

test("a succeeding agent completes the job with its variables", async () => {
  const { completes, fails, actions } = recorder();
  const handler: AgentHandler = () => Effect.succeed({ topic: "effect", difficulty: "easy" });
  const outcome = await runVirtual(handleJob({ jobType: "agent:test", handler }, job, actions));

  assert.equal(outcome._tag, "completed");
  assert.deepEqual(completes, [{ topic: "effect", difficulty: "easy" }]);
  assert.deepEqual(fails, []);
});

test("a transient failure is retried on the backoff, then completes — deterministically", async () => {
  const { completes, fails, actions } = await Effect.runPromise(
    Effect.gen(function* () {
      const attempts = yield* Ref.make(0);
      const rec = recorder();
      const outcome = yield* Effect.forkChild(
        handleJob({ jobType: "agent:test", handler: flaky(attempts, 2), baseBackoff: Duration.millis(200) }, job, rec.actions),
      );
      yield* TestClock.adjust(Duration.seconds(5));
      const result = yield* Fiber.join(outcome);
      const tries = yield* Ref.get(attempts);
      return { ...rec, result, tries };
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  );

  // failed twice, third attempt succeeded → exactly one completion, no failures
  assert.deepEqual(fails, []);
  assert.equal(completes.length, 1);
});

test("a permanent failure fails the job immediately with retries: 0 (no retries)", async () => {
  const attempts = await Effect.runPromise(
    Effect.gen(function* () {
      const count = yield* Ref.make(0);
      const rec = recorder();
      const handler: AgentHandler = () =>
        Effect.gen(function* () {
          yield* Ref.update(count, (x) => x + 1);
          return yield* Effect.fail(new PermanentAgentError({ agent: "bad", reason: "malformed input" }));
        });
      const fiber = yield* Effect.forkChild(handleJob({ jobType: "agent:test", handler }, job, rec.actions));
      yield* TestClock.adjust(Duration.seconds(10));
      const outcome = (yield* Fiber.join(fiber)) as JobOutcome;
      const n = yield* Ref.get(count);
      assert.equal(outcome._tag, "failed");
      assert.deepEqual(rec.fails, [{ message: "malformed input", retries: 0 }]);
      return n;
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  );

  // a PermanentAgentError short-circuits the retry schedule: the handler ran once
  assert.equal(attempts, 1);
});

test("retry backoff exhaustion raises an incident (retries: 0)", async () => {
  const { fails } = recorder();
  const attempts = await Effect.runPromise(
    Effect.gen(function* () {
      const count = yield* Ref.make(0);
      const rec = recorder();
      // always-transient handler with maxRetries 2 → 3 attempts total, then fail
      const handler: AgentHandler = () =>
        Effect.gen(function* () {
          const n = yield* Ref.updateAndGet(count, (x) => x + 1);
          return yield* Effect.fail(new TransientAgentError({ agent: "down", reason: `still down ${n}` }));
        });
      const fiber = yield* Effect.forkChild(
        handleJob({ jobType: "agent:test", handler, maxRetries: 2, baseBackoff: Duration.millis(100) }, job, rec.actions),
      );
      yield* TestClock.adjust(Duration.seconds(30));
      const outcome = (yield* Fiber.join(fiber)) as JobOutcome;
      assert.equal(outcome._tag, "failed");
      assert.equal(rec.fails.length, 1);
      assert.equal(rec.fails[0]?.retries, 0);
      return yield* Ref.get(count);
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  );

  assert.equal(attempts, 3);
  assert.deepEqual(fails, []);
});
