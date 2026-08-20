import { Effect } from "effect";
import { Llm } from "../effect/Llm.ts";
import type { AgentHandler } from "../effect/worker.ts";
import { requireString } from "./util.ts";

/**
 * The `publish` agent — runs on the loop's `approve` branch. Turns the approved
 * `finalAnswer` into a short published announcement.
 */
export const publish: AgentHandler<Llm> = (job) =>
  Effect.gen(function* () {
    const finalAnswer = yield* requireString("publish", job.variables, "finalAnswer");
    const llm = yield* Llm;

    const announcement = yield* llm.complete({
      agent: "publish",
      prompt: `Write a one-sentence publication note announcing this answer is live:\n\n${finalAnswer}`,
    });

    return { published: true, announcement };
  });
