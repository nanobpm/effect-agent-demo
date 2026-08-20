# effect-agent-demo

**Code-first agent orchestration in Effect** — the companion repo to the demo video.

Agent workflows authored code-first with [`@nanobpm/workflow`](https://www.npmjs.com/package/@nanobpm/workflow)
`defineFlow`, deployed to and run on **Camunda 8**, with each agent worker written as an idiomatic
[**Effect**](https://effect.website) program — typed errors, `Schedule` retries, `Layer` DI, and
`TestClock`-deterministic time.

## The stack

| Layer | Piece |
| ----- | ----- |
| **Model** | `@nanobpm/workflow` `defineFlow` — code-first, derives Zeebe/C8 BPMN |
| **Transport / client** | `@camunda8/orchestration-cluster-api/effect` — Effect surface over the C8 SDK ([S1](https://github.com/camunda/orchestration-cluster-api-js/issues/437)) |
| **Agents** | Effect job workers — `activateJobs → handle → complete/fail` as Effect ([S2](https://github.com/camunda/orchestration-cluster-api-js/issues/438)) |

Effect is an **optional** layer at every level — the demo opts in; it is never forced on the
Promise-based Camunda 8 SDK.

## Why Effect

`Schedule` retries, `Layer` dependency injection, structured concurrency, and typed error
boundaries for agent workers — plus `TestClock`, which makes the orchestration's time-bounded
behaviour (activation intervals, timeouts, eventual consistency) deterministic under test.

## Status

🚧 Scaffolding. Tracked by the epic **[nanobpm/nano-ide#412](https://github.com/nanobpm/nano-ide/issues/412)** (S3).

## License

Apache-2.0
