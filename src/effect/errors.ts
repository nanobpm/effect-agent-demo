import { Data } from "effect";

/**
 * The typed failure channel for agent workers.
 *
 * The whole point of modelling an agent as an `Effect` is that its failure modes
 * are *values in the type*, not thrown surprises. A worker fails with one of
 * these; the worker runtime (see `worker.ts`) translates them into the engine
 * acknowledgement:
 *
 *  - `TransientAgentError` — a retryable blip (a flaky model call, a 5xx, a rate
 *    limit). The runtime retries it on a `Schedule` backoff; only if the backoff
 *    is exhausted does it fail the job — like a permanent error, with
 *    `retries: 0` — so the engine raises an incident rather than redelivering.
 *  - `PermanentAgentError` — a non-retryable fault (a malformed prompt, a policy
 *    refusal, invalid input). The runtime fails the job with `retries: 0` so the
 *    engine raises an incident immediately rather than redelivering.
 */

export class TransientAgentError extends Data.TaggedError("TransientAgentError")<{
  readonly agent: string;
  readonly reason: string;
  readonly cause?: unknown;
}> {}

export class PermanentAgentError extends Data.TaggedError("PermanentAgentError")<{
  readonly agent: string;
  readonly reason: string;
  readonly cause?: unknown;
}> {}

export type AgentError = TransientAgentError | PermanentAgentError;

/** A `Schedule.while`-friendly predicate: retry transient failures only. */
export const isTransient = (e: AgentError): boolean => e._tag === "TransientAgentError";
