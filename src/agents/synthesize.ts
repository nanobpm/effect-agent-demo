import { Effect } from "effect";
import { Llm } from "../effect/Llm.ts";
import type { AgentHandler } from "../effect/worker.ts";
import { optionalNumber, optionalString } from "./util.ts";

/**
 * The `synthesize` agent — merges the parallel retrieval findings into a draft
 * answer. Carries the convergence-loop `round` forward so the reviewer (and the
 * model's `switch`) can bound how many revisions are allowed. On a later round it
 * folds in the reviewer's `revisionNotes` — the "addressed" path of the loop.
 */
export const synthesize: AgentHandler<Llm> = (job) =>
  Effect.gen(function* () {
    const web = optionalString(job.variables, "webFindings");
    const kb = optionalString(job.variables, "kbFindings");
    const round = optionalNumber(job.variables, "round");
    const notes = optionalString(job.variables, "revisionNotes");
    const llm = yield* Llm;

    const revisionClause = notes ? `\n\nAddress this reviewer feedback: ${notes}` : "";
    const finalAnswer = yield* llm.complete({
      agent: "synthesize",
      prompt: `Synthesise a single answer from these findings.${revisionClause}\n\nWeb:\n${web}\n\nKB:\n${kb}`,
    });

    return { finalAnswer, round };
  });
