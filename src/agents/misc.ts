import { Effect } from "effect";
import type { AgentHandler } from "../effect/worker.ts";
import { optionalNumber } from "./util.ts";

/**
 * The pure (non-LLM) agents. They have no `Llm` dependency (`R = never`), so they
 * are total, instant, and trivially deterministic — but they still run through
 * the same Effect worker runtime (typed errors, retries, Scope'd lease) as their
 * LLM siblings, which is the point: an agent is uniformly "a job in, an Effect
 * out", whether or not it calls a model.
 */

/** Fired by the non-interrupting SLA boundary — pings the reviewer, leaving the
 *  synthesis job running. */
export const nudge: AgentHandler = () => Effect.succeed({ nudged: true });

/** Fired on the loop's "needs revision" branch. Records the round bump the model
 *  applied so the next `synthesize` pass knows it is a revision. */
export const recordRevision: AgentHandler = (job) =>
  Effect.succeed({ recordedRound: optionalNumber(job.variables, "round") });

/** Bookkeeping after the loop leaves via `break`. */
export const archive: AgentHandler = () => Effect.succeed({ archived: true });
