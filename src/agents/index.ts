import { JobTypes } from "../model/research-agent.ts";
import type { Llm } from "../effect/Llm.ts";
import type { AgentSpec } from "../effect/worker.ts";
import { classify } from "./classify.ts";
import { searchKb, searchWeb } from "./search.ts";
import { synthesize } from "./synthesize.ts";
import { publish } from "./publish.ts";
import { archive, nudge, recordRevision } from "./misc.ts";

/**
 * The agent registry — every derived job type in the model wired to the Effect
 * program that services it. `serveAgents` leases one Scope'd worker per entry.
 * The environment is `Llm`; the pure agents simply don't use it.
 */
export const agentSpecs: ReadonlyArray<AgentSpec<Llm>> = [
  { jobType: JobTypes.classify, handler: classify },
  { jobType: JobTypes.searchWeb, handler: searchWeb },
  { jobType: JobTypes.searchKb, handler: searchKb },
  { jobType: JobTypes.synthesize, handler: synthesize },
  { jobType: JobTypes.nudge, handler: nudge },
  { jobType: JobTypes.publish, handler: publish },
  { jobType: JobTypes.recordRevision, handler: recordRevision },
  { jobType: JobTypes.archive, handler: archive },
];
