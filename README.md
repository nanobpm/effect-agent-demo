# effect-agent-demo

**Code-first agent orchestration in Effect** — the companion repo to the demo video.

Agent workflows authored code-first with [`@nanobpm/workflow`](https://www.npmjs.com/package/@nanobpm/workflow)
`defineFlow`, deployed to and run on **Camunda 8**, with each agent worker written as an idiomatic
[**Effect**](https://effect.website) program — typed errors, `Schedule` retries, `Layer` DI, and
`TestClock`-deterministic time.

## The stack

| Layer | Piece | In this repo |
| ----- | ----- | ------------ |
| **Model** | `@nanobpm/workflow` `defineFlow` — code-first, derives Zeebe/C8 BPMN | [`src/model/research-agent.ts`](src/model/research-agent.ts) |
| **Transport / client** | Effect surface over the C8 SDK ([S1 #437](https://github.com/camunda/orchestration-cluster-api-js/issues/437)) | [`src/effect/client.ts`](src/effect/client.ts) |
| **Agent runtime** | Effect job workers — `activate → handle → complete/fail` ([S2 #438](https://github.com/camunda/orchestration-cluster-api-js/issues/438)) | [`src/effect/worker.ts`](src/effect/worker.ts) |
| **Agents** | one `Effect` program per capability | [`src/agents/`](src/agents/) |
| **Human front-end** | an [`@nanobpm/urban`](https://www.npmjs.com/package/@nanobpm/urban) app reusing the built-in `taskInbox` surface to act on the `review` task | [`urban-app.ts`](urban-app.ts), [`nano.app.json`](nano.app.json) |

Effect is an **optional** layer at every SDK level — the demo opts in; it is never forced on the
Promise-based Camunda 8 SDK. It targets **Effect v4** (beta), pinned deliberately.

> **Transport note.** The published transport target is
> `@camunda8/orchestration-cluster-api/effect` (S1 #437 + S2 #438). Until that subpath ships, the
> demo drives the engine through `@nanobpm/workflow`'s Promise-based `WorkflowClient` behind the
> thin Effect surface in [`src/effect/`](src/effect/). When `./effect` publishes, swap the internals
> of `client.ts` / `worker.ts` — the model and the agents are unchanged.

## The model — an agent convergence loop

Authored code-first and kept inside `defineFlow`'s block-structured, single-entry/single-exit
subset:

```
classify                              — an LLM agent classifies the question (prompt-bound task)
parallel(search-web, search-kb)       — two retrieval agents run concurrently (AND fork/join)
loop:                                 — a durable agent convergence loop
  synthesize                          — an LLM agent drafts an answer from the findings
    boundary(SLA, non-interrupting)   — a timer SLA pings the reviewer, leaving synthesis running
  human(review)                       — a reviewer approves / requests a revision
  switch(verdict):
    approve  -> publish; break        — publish and leave the loop
    default  -> record-revision       — bump the round and loop back to re-synthesize
archive                               — bookkeeping after the loop
```

The LLM agent tasks bind a prompt resource (`zeebe:linkedResource … linkName="prompt"`, see
[`prompts/`](prompts/)) — the shape nano-workforce agent pools consume. Emit the derived, deployable
BPMN (with diagram interchange) to inspect it in a modeller / Operate:

```sh
npm run model:emit   # writes bpmn/research-agent.bpmn
```

## The agents — Effect all the way down

Each agent is `(job) => Effect<variables, AgentError, R>`:

- **Typed errors** — `TransientAgentError` (retryable) vs `PermanentAgentError` (incident), a real
  failure channel instead of thrown surprises ([`src/effect/errors.ts`](src/effect/errors.ts)).
- **`Schedule` retries** — the worker retries transient failures on an exponential backoff and
  short-circuits permanent ones ([`src/effect/worker.ts`](src/effect/worker.ts)).
- **`Layer` DI** — agents depend on an `Llm` service; the demo injects a deterministic stand-in and
  can swap in a real OpenAI-compatible `LlmLive` ([`src/effect/Llm.ts`](src/effect/Llm.ts)).
- **`Scope`d job lease** — each worker is acquired/released with `Effect.acquireRelease`, so leases
  are always returned when the runtime shuts down.

## Why Effect — the `TestClock` hook

`Schedule` retries, `Layer` DI, structured concurrency, and typed error boundaries for agent
workers — plus **`TestClock`**, which makes the orchestration's time-bounded behaviour (retry
backoff, per-call deadlines, activation intervals) deterministic under test. Every backoff and
deadline is an Effect sleep against a virtual clock, so the tests advance time explicitly and assert
exact outcomes — no real waiting, no flakiness. See [`test/worker.test.ts`](test/worker.test.ts) and
[`test/agents.test.ts`](test/agents.test.ts).

## Run it

Prereqs: **Node ≥ 22.6** (uses `--experimental-transform-types` to run TypeScript directly).

```sh
npm install
npm run typecheck     # tsc --noEmit
npm run lint          # biome check (lint + format); `npm run lint:fix` to apply
npm test              # node --test, all deterministic (no engine, no network)
```

Deploy + run against a Camunda 8 / nanobpmn engine:

```sh
export CAMUNDA_REST_ADDRESS=http://localhost:8080   # your gateway
export CAMUNDA_TOKEN=...                             # if required
export LLM_API_KEY=...                               # optional; omit to use the deterministic LLM
npm run deploy
```

`npm run deploy` deploys the model, leases the eight agent workers, starts one instance, and serves
until interrupted.

## The human front-end — acting on the `review` task

The `human(review)` step parks each instance on a user task until a reviewer approves the draft or
asks for a revision — nothing in `npm run deploy` completes it. Rather than build a bespoke reviewer
UI, the demo mounts [`@nanobpm/urban`](https://www.npmjs.com/package/@nanobpm/urban)'s
batteries-included **`taskInbox` surface** (ADR 0026): it lists the open `review` tasks, renders their
linked form, and completes them.

- [`nano.app.json`](nano.app.json) — the Urban app manifest: enables `surfaces.taskInbox` and declares
  the form under `models.forms`.
- [`resources/forms/research-review.form`](resources/forms/research-review.form) — the form-js schema:
  read-only `question` + drafted `finalAnswer`, a required `verdict` (approve / revise), and
  conditional `revisionNotes`. Its field keys match the `review` task's I/O.
- [`urban-app.ts`](urban-app.ts) — a thin entrypoint: `runFromEnv` deploys the form and mounts the
  surface against the **same** engine `npm run deploy` targets (no embedded engine, no duplicated
  workers).

Run it alongside the deploy process:

```sh
npm run deploy      # terminal 1 — deploys the flow, serves agents, starts an instance
npm run app         # terminal 2 — deploys the form, serves the task inbox (default :8090/tasks)
```

Open [`http://localhost:8090/tasks`](http://localhost:8090/tasks), complete the `review` task, and the
loop converges: **approve** → `publish` → `archive`; **revise** → `record-revision` → re-`synthesize`
→ a fresh `review`. The app also embeds in the Nano console at `/console/app-view/research-agent/tasks`
(ADR 0057).

## License

Apache-2.0
