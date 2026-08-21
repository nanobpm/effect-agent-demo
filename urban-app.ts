// Urban human-surface app for the research-agent demo.
//
//   node --experimental-transform-types urban-app.ts
//
// Mounts Urban's batteries-included `taskInbox` surface (ADR 0026) against the SAME
// Nano engine the Effect runtime deploys to, and deploys the `research-review` form
// (declared in nano.app.json `models.forms`) so the review user task renders. The
// Effect runtime (`npm run deploy`) still owns flow deployment, agent-job serving and
// instance start; this process is purely the human front-end that lets a reviewer
// approve / request a revision, converging the review loop.
//
// It embeds in the Nano console at /console/app-view/research-agent/tasks (ADR 0057).
//
// Env:
//   CAMUNDA_REST_ADDRESS  base URL of the engine (default http://localhost:8080). A
//                         `/v2` suffix is appended if absent — the SDK engine client
//                         takes the versioned base, unlike WorkflowClient.
//   CAMUNDA_TOKEN         bearer token, if the gateway requires one
//   PORT                  HTTP port for the surface (default 8090)
import { runFromEnv, selectHost } from "@nanobpm/urban";

const raw = process.env.CAMUNDA_REST_ADDRESS ?? "http://localhost:8080";
const restAddress = /\/v2\/?$/.test(raw) ? raw : `${raw.replace(/\/+$/, "")}/v2`;

// Thin human surface: no app-local DB, no in-process workers/triggers/instance
// tracking. Only the form deploy (`models.forms`) and the taskInbox surface mount.
const app = await runFromEnv({
  host: selectHost(),
  restAddress,
  root: import.meta.dirname ?? ".",
  mount: { data: false, workers: false, triggers: false, instanceTracking: false },
});

const info = app.inspect();
app.log.info("research-agent human surface started", {
  httpPort: info.httpPort ?? null,
  tasks: info.httpPort ? `http://localhost:${info.httpPort}/tasks` : "/tasks",
  engine: restAddress,
});
