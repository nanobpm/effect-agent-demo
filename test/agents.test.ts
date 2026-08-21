import assert from "node:assert/strict";
import { test } from "node:test";
import type { JsonObject } from "@nanobpm/workflow";
import { Duration, Effect, Fiber, Layer } from "effect";
import { TestClock } from "effect/testing";
import { classify } from "../src/agents/classify.ts";
import { synthesize } from "../src/agents/synthesize.ts";
import { TransientAgentError } from "../src/effect/errors.ts";
import { Llm, LlmDeterministic } from "../src/effect/Llm.ts";
import type { EffectJob } from "../src/effect/worker.ts";

const jobOf = (variables: JsonObject): EffectJob => ({ jobKey: "j", type: "t", variables });

const runDeterministic = (effect: Effect.Effect<JsonObject, unknown, Llm>): Promise<JsonObject> =>
  Effect.runPromise(effect.pipe(Effect.provide(LlmDeterministic)));

test("classify is deterministic and produces a valid difficulty", async () => {
  const job = jobOf({ question: "What is structured concurrency?" });
  const a = await runDeterministic(classify(job));
  const b = await runDeterministic(classify(job));

  assert.deepEqual(a, b, "same input → same output");
  assert.ok(["easy", "moderate", "hard"].includes(a.difficulty as string));
  assert.equal(typeof a.topic, "string");
});

test("classify fails permanently on missing input (no LLM call)", async () => {
  const exit = await Effect.runPromiseExit(classify(jobOf({})).pipe(Effect.provide(LlmDeterministic)));
  assert.equal(exit._tag, "Failure");
});

test("synthesize carries the convergence-loop round forward", async () => {
  const out = await runDeterministic(synthesize(jobOf({ webFindings: "- a", kbFindings: "- b", round: 2 })));
  assert.equal(out.round, 2);
  assert.equal(typeof out.finalAnswer, "string");
});

/**
 * The per-call deadline (the shape `LlmLive` uses: `Effect.timeoutOrElse`) is a
 * virtual sleep under `TestClock`. A slow model call that exceeds the deadline
 * fails transiently at *exactly* the deadline in virtual time — no real waiting,
 * no flakiness. This is the class of test the epic says Effect's `TestClock`
 * categorically unlocks.
 */
const SlowLlm = (respondAfter: Duration.Duration, deadline: Duration.Duration): Layer.Layer<Llm> =>
  Layer.succeed(Llm, {
    complete: ({ agent }) =>
      Effect.sleep(respondAfter).pipe(
        Effect.as("slow answer"),
        Effect.timeoutOrElse({
          duration: deadline,
          onTimeout: () => Effect.fail(new TransientAgentError({ agent, reason: "deadline exceeded" })),
        }),
      ),
  });

test("an over-deadline LLM call times out deterministically under TestClock", async () => {
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      // model responds after 20s but the deadline is 5s → it must time out
      const fiber = yield* Effect.forkChild(
        classify(jobOf({ question: "slow one" })).pipe(
          Effect.provide(SlowLlm(Duration.seconds(20), Duration.seconds(5))),
          Effect.exit,
        ),
      );
      yield* TestClock.adjust(Duration.seconds(6));
      return yield* Fiber.join(fiber);
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  );

  assert.equal(result._tag, "Failure");
});

test("a within-deadline LLM call succeeds under TestClock", async () => {
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(
        classify(jobOf({ question: "fast one" })).pipe(
          Effect.provide(SlowLlm(Duration.seconds(2), Duration.seconds(5))),
          Effect.exit,
        ),
      );
      yield* TestClock.adjust(Duration.seconds(3));
      return yield* Fiber.join(fiber);
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  );

  assert.equal(result._tag, "Success");
});
