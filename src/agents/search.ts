import { Effect } from "effect";
import { Llm } from "../effect/Llm.ts";
import type { AgentHandler } from "../effect/worker.ts";
import { requireString } from "./util.ts";

/**
 * The retrieval agents. `search-web` and `search-kb` run concurrently in the
 * model's `parallel` fork; each asks the LLM for findings on the classified
 * `topic` and reports a `sourceCount`. They are the same program parameterised by
 * a source label — a small demonstration that an Effect agent is just a value.
 */
const makeSearch =
  (source: "web" | "kb"): AgentHandler<Llm> =>
  (job) =>
    Effect.gen(function* () {
      const topic = yield* requireString(`search-${source}`, job.variables, "topic");
      const llm = yield* Llm;

      const findings = yield* llm.complete({
        agent: `search-${source}`,
        prompt: `Search the ${source === "web" ? "public web" : "internal knowledge base"} for material on: ${topic}. Summarise the key findings in 3 bullet points.`,
      });

      return {
        findings,
        sourceCount: countBullets(findings),
      };
    });

const countBullets = (text: string): number => {
  const matches = text.match(/^\s*[-*•]/gm);
  return matches ? matches.length : 1;
};

export const searchWeb = makeSearch("web");
export const searchKb = makeSearch("kb");
