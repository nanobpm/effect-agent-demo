import { Effect } from "effect";
import { Llm } from "../effect/Llm.ts";
import type { AgentHandler } from "../effect/worker.ts";
import { requireString } from "./util.ts";

/**
 * The `classify` agent — an idiomatic Effect program. Reads the intake question,
 * asks the LLM to classify it, and derives a coarse `topic`/`difficulty` the rest
 * of the flow branches on. Depends on the `Llm` service (injected by a `Layer`),
 * fails in the typed `AgentError` channel, and is retried by the worker runtime.
 */
export const classify: AgentHandler<Llm> = (job) =>
  Effect.gen(function* () {
    const question = yield* requireString("classify", job.variables, "question");
    const llm = yield* Llm;

    const answer = yield* llm.complete({
      agent: "classify",
      prompt: `Classify this research question. Reply as "<topic> | <easy|moderate|hard>".\n\nQuestion: ${question}`,
    });

    const [topicRaw, difficultyRaw] = answer.split("|");
    const topic = (topicRaw ?? question).trim().slice(0, 120) || "general";
    const difficulty = normaliseDifficulty(difficultyRaw);

    return { topic, difficulty };
  });

const normaliseDifficulty = (raw: string | undefined): "easy" | "moderate" | "hard" => {
  const v = (raw ?? "").toLowerCase();
  if (v.includes("hard")) return "hard";
  if (v.includes("easy")) return "easy";
  return "moderate";
};
