import { Config, Duration, Effect, Layer, Redacted, ServiceMap } from "effect";
import { PermanentAgentError, TransientAgentError } from "./errors.ts";

/**
 * The LLM capability the agents depend on — injected as an Effect `Layer`, so an
 * agent program never reaches for a global client. Two layers satisfy it:
 *
 *  - `LlmDeterministic` — a pure, seeded stand-in used by the test suite and the
 *    default demo run: same input → same output, so the orchestration is
 *    reproducible and its time-bounded behaviour is testable under `TestClock`.
 *  - `LlmLive` — a real OpenAI-compatible call, wrapped with a per-call
 *    `Effect.timeout` deadline (a transient failure when it elapses) and a typed
 *    failure channel. Reads its endpoint/key/model/timeout from `Config`.
 */

export interface LlmRequest {
  /** The agent making the call (for error attribution). */
  readonly agent: string;
  /** The fully-composed prompt. */
  readonly prompt: string;
}

export class Llm extends ServiceMap.Service<
  Llm,
  {
    readonly complete: (req: LlmRequest) => Effect.Effect<string, TransientAgentError | PermanentAgentError>;
  }
>()("Llm") {}

/**
 * A deterministic, dependency-free implementation. It hashes the prompt into a
 * stable pseudo-response so tests and demos are reproducible without a network.
 */
export const LlmDeterministic = Layer.succeed(Llm, {
  complete: ({ prompt }) =>
    Effect.sync(() => {
      let h = 2166136261;
      for (let i = 0; i < prompt.length; i++) {
        h ^= prompt.charCodeAt(i);
        h = Math.imul(h, 16777619);
      }
      const digest = (h >>> 0).toString(16).padStart(8, "0");
      // Return only the stable digest — do NOT echo the prompt. Echoing prompt
      // text leaked it into logs/variables and could inject downstream parsing
      // delimiters (e.g. `classify` splits its response on `|`), making the
      // deterministic run produce unstable/incorrect structured outputs.
      return `[deterministic:${digest}]`;
    }),
});

interface LlmConfig {
  readonly endpoint: string;
  readonly apiKey: Redacted.Redacted<string>;
  readonly model: string;
  readonly timeout: Duration.Duration;
}

const llmConfig: Config.Config<LlmConfig> = Config.all({
  endpoint: Config.string("LLM_ENDPOINT").pipe(Config.withDefault(() => "https://api.openai.com/v1/chat/completions")),
  apiKey: Config.redacted("LLM_API_KEY"),
  model: Config.string("LLM_MODEL").pipe(Config.withDefault(() => "gpt-4o-mini")),
  timeout: Config.duration("LLM_TIMEOUT").pipe(Config.withDefault(() => Duration.seconds(30))),
});

/**
 * A real OpenAI-compatible chat completion. `Effect.timeout` bounds the call;
 * when it elapses the effect fails with a `TransientAgentError` so the worker's
 * retry `Schedule` gets a chance before the engine sees a failure. Because the
 * deadline is expressed as an Effect sleep, it is virtual under `TestClock`.
 */
export const LlmLive = Layer.effect(
  Llm,
  Effect.gen(function* () {
    const cfg = yield* llmConfig;
    return {
      complete: ({ agent, prompt }) =>
        Effect.tryPromise({
          try: (signal) =>
            fetch(cfg.endpoint, {
              method: "POST",
              signal,
              headers: {
                "content-type": "application/json",
                authorization: `Bearer ${Redacted.value(cfg.apiKey)}`,
              },
              body: JSON.stringify({
                model: cfg.model,
                messages: [{ role: "user", content: prompt }],
              }),
            }).then(async (res) => {
              if (!res.ok) {
                // Clip + normalize the response body: it can be large/noisy
                // (even HTML), which makes incidents and logs hard to read.
                const raw = await res.text().catch(() => "");
                const detail = raw.replace(/\s+/g, " ").trim().slice(0, 500);
                const reason = `LLM HTTP ${res.status}: ${detail}`;
                // 429 (rate limit) and 5xx (server) are retryable; every other
                // non-OK status (4xx: bad key, malformed request, …) is permanent.
                if (res.status === 429 || res.status >= 500) {
                  throw new TransientAgentError({ agent, reason });
                }
                throw new PermanentAgentError({ agent, reason });
              }
              const json = (await res.json()) as {
                choices?: ReadonlyArray<{ message?: { content?: string } }>;
              };
              const text = json.choices?.[0]?.message?.content;
              if (typeof text !== "string") throw new Error("LLM response missing choices[0].message.content");
              return text;
            }),
          catch: (cause) =>
            // Pass already-typed agent errors through unchanged; only wrap the
            // rest (network faults, JSON/shape errors) as a transient blip.
            cause instanceof TransientAgentError || cause instanceof PermanentAgentError
              ? cause
              : new TransientAgentError({ agent, reason: "llm call failed", cause }),
        }).pipe(
          Effect.timeoutOrElse({
            duration: cfg.timeout,
            onTimeout: () =>
              Effect.fail(
                new TransientAgentError({ agent, reason: `llm call exceeded ${Duration.format(cfg.timeout)}` }),
              ),
          }),
        ),
    };
  }),
);
