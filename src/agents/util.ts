import type { JsonObject } from "@nanobpm/workflow";
import { Effect } from "effect";
import { PermanentAgentError } from "../effect/errors.ts";

/** Read a required string job variable, failing PERMANENTLY when it is missing
 *  or the wrong type — bad input is not something a retry can fix. */
export const requireString = (
  agent: string,
  vars: JsonObject,
  key: string,
): Effect.Effect<string, PermanentAgentError> => {
  const value = vars[key];
  return typeof value === "string" && value.length > 0
    ? Effect.succeed(value)
    : Effect.fail(new PermanentAgentError({ agent, reason: `missing required string variable '${key}'` }));
};

/** Read an optional string, falling back to a default. */
export const optionalString = (vars: JsonObject, key: string, fallback = ""): string => {
  const value = vars[key];
  return typeof value === "string" ? value : fallback;
};

/** Read an optional number, falling back to a default. */
export const optionalNumber = (vars: JsonObject, key: string, fallback = 0): number => {
  const value = vars[key];
  return typeof value === "number" ? value : fallback;
};
