import { defineFlow, envelope } from "@nanobpm/workflow";
import type { DeclarativeFlow } from "@nanobpm/workflow";

/**
 * The agent-orchestration model — authored code-first with `@nanobpm/workflow`
 * `defineFlow`, which derives the Zeebe/C8-flavoured BPMN we deploy to Camunda 8.
 *
 * Shape (block-structured, single-entry / single-exit — the expressible subset):
 *
 *   classify                       — an LLM agent classifies the incoming question
 *   parallel(search-web, search-kb) — two retrieval agents run concurrently (AND fork/join)
 *   loop:                           — a durable agent convergence loop
 *     synthesize                    — an LLM agent drafts an answer from the findings
 *     human(review)                 — a reviewer approves / asks for a revision
 *       boundary(nudge SLA)         — a NON-interrupting timer SLA pings the reviewer, leaving the task running
 *                                     (converges into `review` today — a fire-and-forget reviewer nudge on
 *                                      `review` timed by `reviewNudgeSla` awaits upstream support, see #3)
 *     switch(verdict):
 *       approve  -> publish; break  — publish the answer and leave the loop
 *       default  -> record-revision — bump the round and loop back to re-synthesize
 *   archive                         — bookkeeping after the loop
 *
 * Every service task is `w.task` (an EXTERNAL worker) so the agents are hosted by
 * the Effect worker runtime in `src/effect` (the S2 surface), not by an in-process
 * `Worker`. The LLM agent tasks additionally bind a prompt resource
 * (`zeebe:linkedResource … linkName="prompt"`) — the shape the nano-workforce
 * agent pools consume.
 */

/** The agent capability tokens (`zeebe:taskDefinition type`) the Effect workers poll. */
export const JobTypes = {
  classify: "agent:classify",
  searchWeb: "agent:search-web",
  searchKb: "agent:search-kb",
  synthesize: "agent:synthesize",
  nudge: "agent:nudge",
  publish: "agent:publish",
  recordRevision: "agent:record-revision",
  archive: "agent:archive",
} as const;

export type JobType = (typeof JobTypes)[keyof typeof JobTypes];

// Typed data envelopes — lifted into the emitted model as `nano:shape` +
// `io.nanobpm.dataEnvelope.*`, so the derived .bpmn stays ejectable to the
// modeller with its contracts intact, and the handlers are typed from them.
export const Intake = envelope("Intake", {
  question: "string",
  requesterId: "string",
  reviewerId: "string",
});
export const Classified = envelope("Classified", {
  topic: "string",
  difficulty: "string",
});
export const Findings = envelope("Findings", {
  findings: "string",
  sourceCount: "number",
});
export const Draft = envelope("Draft", {
  finalAnswer: "string",
  round: "number",
});

/**
 * Build the research-agent flow. Kept as a factory so tests can derive a fresh
 * instance without shared mutable state.
 */
export function researchAgentFlow(): DeclarativeFlow {
  return defineFlow(
    "research-agent",
    {
      classify: { in: Intake, out: Classified },
      "search-web": { out: Findings },
      "search-kb": { out: Findings },
      synthesize: { out: Draft },
    },
    (w) => {
      w.task("classify", {
        jobType: JobTypes.classify,
        prompt: { resourceId: "classify.md", bindingType: "latest" },
      });

      w.parallel([
        (b) =>
          b.task("search-web", {
            jobType: JobTypes.searchWeb,
            prompt: { resourceId: "search-web.md", bindingType: "latest", append: "=topic" },
            io: { output: [{ source: "=findings", target: "webFindings" }] },
          }),
        (b) =>
          b.task("search-kb", {
            jobType: JobTypes.searchKb,
            prompt: { resourceId: "search-kb.md", bindingType: "latest", append: "=topic" },
            io: { output: [{ source: "=findings", target: "kbFindings" }] },
          }),
      ]);

      w.loop((b) => {
        b.task("synthesize", {
          jobType: JobTypes.synthesize,
          prompt: { resourceId: "synthesize.md", bindingType: "latest" },
          io: {
            input: [
              { source: "=webFindings", target: "webFindings" },
              { source: "=kbFindings", target: "kbFindings" },
              { source: "=if (is defined(round)) then round else 0", target: "round" },
              { source: "=if (is defined(revisionNotes)) then revisionNotes else null", target: "revisionNotes" },
            ],
          },
        });

        // A NON-interrupting SLA on the synthesis agent: if the draft is not
        // produced within the window, ping the reviewer via the `nudge` agent
        // while the synthesis job keeps running (cancelActivity="false").
        //
        // KNOWN LIMITATION (tracked in #3): `@nanobpm/workflow`'s `boundary(...)`
        // always CONVERGES its `onTimeout` danglers back into the host activity's
        // continuation (see `dist/nodes/boundary.js` → `[...incoming, ...escOut]`);
        // it has no end/terminate node for a fire-and-forget boundary body. So this
        // nudge path merges into `review`, and a fired SLA can create a second
        // `review` instance once `synthesize` later completes. The intended shape is
        // a fire-and-forget reviewer nudge on the `review` task, timed by
        // `reviewNudgeSla` — kept as reserved start-input config in `main.ts` — and
        // awaits the upstream fire-and-forget/end-event boundary body (#3). Until
        // that lands we keep this single nudge as-is rather than move the spurious
        // token into the `verdict` gateway.
        b.boundary({
          timer: "=synthesizeSla",
          interrupting: false,
          name: "nudge-reviewer",
          onTimeout: (g) => g.task("nudge", { jobType: JobTypes.nudge }),
        });

        b.human("review", {
          form: "research-review",
          assignee: "=reviewerId",
          candidateGroups: "researchers",
          io: {
            output: [
              { source: "=verdict", target: "verdict" },
              { source: "=if (is defined(finalAnswer)) then finalAnswer else null", target: "finalAnswer" },
              { source: "=if (is defined(revisionNotes)) then revisionNotes else null", target: "revisionNotes" },
            ],
          },
        });

        b.switch("verdict", {
          approve: (c) => {
            c.task("publish", {
              jobType: JobTypes.publish,
              prompt: { resourceId: "publish.md", bindingType: "latest" },
            });
            c.break();
          },
          default: (c) =>
            c.task("record-revision", {
              jobType: JobTypes.recordRevision,
              io: { output: [{ source: "=round + 1", target: "round" }] },
            }),
        });
      });

      w.task("archive", { jobType: JobTypes.archive });
    },
  );
}
