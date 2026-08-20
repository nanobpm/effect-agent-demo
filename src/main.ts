import { Config, Effect, Layer } from "effect";
import { EffectClient } from "./effect/client.ts";
import { LlmDeterministic, LlmLive } from "./effect/Llm.ts";
import type { Llm } from "./effect/Llm.ts";
import { serveAgents } from "./effect/worker.ts";
import { agentSpecs } from "./agents/index.ts";
import { researchAgentFlow } from "./model/research-agent.ts";

/**
 * Deploy + run the demo against a Camunda 8 engine.
 *
 *   node --experimental-strip-types src/main.ts
 *
 * Env:
 *   CAMUNDA_REST_ADDRESS  base URL of the C8 / nanobpmn gateway (default localhost:8080)
 *   CAMUNDA_TOKEN         bearer token, if the gateway requires one
 *   CAMUNDA_TRANSPORT     "auto" | "falcon" | "rest" (default "auto"). Against a
 *                         Nano gateway "auto" selects the Falcon push transport.
 *   LLM_API_KEY           when set, the agents use the real `LlmLive`; otherwise
 *                         the deterministic stand-in (so the demo runs offline)
 *
 * The whole thing is one scoped Effect: deploy → lease the agent workers →
 * start an instance → serve until interrupted (each worker's lease is released
 * on scope close).
 */

const baseUrl = process.env.CAMUNDA_REST_ADDRESS ?? "http://localhost:8080";
const token = process.env.CAMUNDA_TOKEN;
const transport = (process.env.CAMUNDA_TRANSPORT ?? "auto") as "auto" | "falcon" | "rest";

const llmLayer: Layer.Layer<Llm, Config.ConfigError> = process.env.LLM_API_KEY ? LlmLive : LlmDeterministic;

const program = Effect.gen(function* () {
  const flow = researchAgentFlow();
  const client = EffectClient.make(token ? { baseUrl, token, transport } : { baseUrl, transport });

  yield* Effect.log(`deploying 'research-agent' to ${baseUrl}`);
  yield* client.deploy(flow);

  yield* serveAgents(client.sdk, llmLayer, agentSpecs, (o) =>
    Effect.runSync(Effect.log(`job ${o.jobType} ${o._tag}`)),
  );
  yield* Effect.log(`serving ${agentSpecs.length} agents (${process.env.LLM_API_KEY ? "LlmLive" : "LlmDeterministic"})`);

  const started = yield* client.start(flow, {
    question: process.env.QUESTION ?? "How does Effect's TestClock make agent orchestration deterministic?",
    requesterId: "demo-requester",
    reviewerId: "demo-reviewer",
    synthesizeSla: "PT30S",
    // Reserved for the reviewer-nudge boundary on the `review` task (timed nudge
    // if the reviewer hasn't acted). It is intentionally not wired to a timer yet:
    // a correct reviewer nudge must be fire-and-forget, but `@nanobpm/workflow`'s
    // boundary body always converges into the host continuation. Kept as forward-
    // looking config pending the upstream fire-and-forget boundary body (issue #3).
    reviewNudgeSla: "PT2H",
  });
  yield* Effect.log(`started instance ${JSON.stringify(started)}`);

  yield* Effect.log("agents running — Ctrl-C to stop");
  yield* Effect.never;
});

Effect.runFork(Effect.scoped(program));
