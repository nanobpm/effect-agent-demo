import { Effect } from "effect";
import { WorkflowClient } from "@nanobpm/workflow";
import type { DeclarativeFlow, DeployResult, JsonObject, StartResult, Workflow, WorkflowClientOptions } from "@nanobpm/workflow";
import { PermanentAgentError } from "./errors.ts";

/**
 * The Effect client surface (S1). The published target is
 * `@camunda8/orchestration-cluster-api/effect` (#437) — a first-class `./effect`
 * subpath over the C8 SDK. Until it ships, this wraps `@nanobpm/workflow`'s
 * Promise-based `WorkflowClient` so the demo drives deploy/start/signal as
 * Effect. Swap the internals when `./effect` lands; call sites are unchanged.
 */
export class EffectClient {
  private constructor(private readonly client: WorkflowClient) {}

  /** The underlying nano-sdk client, so the worker runtime can serve jobs over
   *  the same transport. */
  get sdk() {
    return this.client.sdk;
  }

  static make(opts: WorkflowClientOptions): EffectClient {
    return new EffectClient(new WorkflowClient(opts));
  }

  /** Deploy a workflow's derived BPMN (with auto-generated DI). */
  deploy(wf: Workflow): Effect.Effect<DeployResult, PermanentAgentError> {
    return Effect.tryPromise({
      try: () => this.client.deploy(wf),
      catch: (cause) => new PermanentAgentError({ agent: "client", reason: "deploy failed", cause }),
    });
  }

  /** Start a workflow instance. */
  start(wf: Workflow, input?: JsonObject): Effect.Effect<StartResult, PermanentAgentError> {
    return Effect.tryPromise({
      try: () => this.client.start(wf, input),
      catch: (cause) => new PermanentAgentError({ agent: "client", reason: "start failed", cause }),
    });
  }

  /** Correlate a signal to a parked declarative `signal` step. */
  signal(
    flow: DeclarativeFlow,
    signalName: string,
    correlationKey: string,
    variables?: JsonObject,
  ): Effect.Effect<JsonObject, PermanentAgentError> {
    return Effect.tryPromise({
      try: () => this.client.signal(flow, signalName, correlationKey, variables),
      catch: (cause) => new PermanentAgentError({ agent: "client", reason: `signal '${signalName}' failed`, cause }),
    });
  }
}
