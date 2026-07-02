import "server-only";

import pino from "pino";

import { getBrainSettings, isEmbeddingConfigured } from "./settings";

import { MaisterError } from "@/lib/errors";
import { stripEnvPrefix } from "@/lib/mcp/projection";

// Project Brain (ADR-122) OpenAI-compatible client. Symmetric embed + complete
// over one HTTP module. Config comes from `platform_runtime_settings`; the API
// key is resolved from process.env via the `env:NAME` ref. Failure taxonomy:
// transient (timeout / 429 / 5xx / network / malformed 200 body) → bounded
// retry → `EMBEDDING_UNAVAILABLE`; deterministic provider 4xx (bad key, unknown
// model, wrong base URL, rejected input) → `CONFIG` — retrying cannot fix it.
// The key and request/response bodies are NEVER logged or included in a thrown
// message (E-10).

const log = pino({
  name: "brain:openai-compatible",
  level: process.env.LOG_LEVEL ?? "info",
});

// The generation key stamped onto brain_embeddings.embedding_version — changes
// exactly when the model OR the dimensions change (D4).
export function embeddingVersion(model: string, dimensions: number): string {
  return `${model}@${dimensions}`;
}

export interface EmbeddingClientConfig {
  baseUrl: string;
  embeddingModel: string;
  embeddingDimensions: number;
  apiKeyRef: string | null;
  distillModel: string | null;
  maxRetries?: number;
  retryDelayMs?: number;
  // Per-attempt deadline. Without it a provider that accepts the connection then
  // stalls would hang recall/retain routes and the harvest/reindex sweeps
  // indefinitely — the "timeout" half of the bounded-retry contract. An abort is
  // classified transient (retried, then EMBEDDING_UNAVAILABLE).
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface OpenAiCompatibleClient {
  readonly provider: "openai_compatible";
  readonly model: string;
  readonly dimensions: number;
  readonly version: string;
  embed(texts: string[]): Promise<number[][]>;
  complete(
    prompt: string,
    opts?: { json?: boolean; maxTokens?: number },
  ): Promise<string>;
}

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function makeEmbeddingClient(
  cfg: EmbeddingClientConfig,
): OpenAiCompatibleClient {
  const maxRetries = cfg.maxRetries ?? 2;
  const retryDelayMs = cfg.retryDelayMs ?? 250;
  const timeoutMs = cfg.timeoutMs ?? 30_000;
  const doFetch = cfg.fetchImpl ?? globalThis.fetch;
  const base = cfg.baseUrl.replace(/\/+$/, "");
  // Log the origin only — a base URL with embedded userinfo credentials must
  // never reach the logs (E-10).
  let logBase: string;

  try {
    logBase = new URL(base).origin;
  } catch {
    logBase = "<invalid base url>";
  }

  function authHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    const key = cfg.apiKeyRef
      ? process.env[stripEnvPrefix(cfg.apiKeyRef)]
      : undefined;

    if (key) headers.authorization = `Bearer ${key}`;

    return headers;
  }

  // One request with bounded retry. `op` labels the call for logs (never the
  // key/payload). Transient failures (network / timeout / retryable status /
  // malformed 200 body) retry then throw EMBEDDING_UNAVAILABLE; a deterministic
  // non-retryable 4xx throws CONFIG immediately — a bad key / unknown model /
  // wrong base URL / rejected input cannot be fixed by retrying.
  async function request(
    path: string,
    body: unknown,
    op: string,
  ): Promise<unknown> {
    let lastStatus: number | undefined;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      let res: Response;

      try {
        res = await doFetch(`${base}${path}`, {
          method: "POST",
          headers: authHeaders(),
          body: JSON.stringify(body),
          // Per-attempt deadline — a stalled provider aborts here instead of
          // hanging the caller forever.
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        // Network / timeout abort — transient. Never log the error body (may echo
        // the request), only the shape.
        lastStatus = undefined;
        const timedOut =
          err instanceof Error &&
          (err.name === "TimeoutError" || err.name === "AbortError");

        log.warn(
          {
            op,
            attempt,
            model: cfg.embeddingModel,
            baseUrl: logBase,
            kind: timedOut ? "timeout" : "network",
          },
          "embedding request failed, retrying",
        );
        if (attempt < maxRetries) {
          await sleep(retryDelayMs * 2 ** attempt);
          continue;
        }
        break;
      }

      if (res.ok) {
        try {
          return await res.json();
        } catch {
          // A 200 with a non-JSON body (an HTML-returning proxy) is an infra
          // fault, not a provider verdict — classify transient, never let a raw
          // SyntaxError escape the taxonomy.
          lastStatus = undefined;
          log.warn(
            {
              op,
              attempt,
              model: cfg.embeddingModel,
              baseUrl: logBase,
              kind: "malformed-body",
            },
            "embedding request failed, retrying",
          );
          if (attempt < maxRetries) {
            await sleep(retryDelayMs * 2 ** attempt);
            continue;
          }
          break;
        }
      }

      lastStatus = res.status;

      if (RETRYABLE_STATUS.has(res.status) && attempt < maxRetries) {
        log.warn(
          {
            op,
            attempt,
            status: res.status,
            model: cfg.embeddingModel,
            baseUrl: logBase,
          },
          "embedding request failed, retrying",
        );
        await sleep(retryDelayMs * 2 ** attempt);
        continue;
      }

      // Deterministic non-retryable 4xx → CONFIG (422 at the ext boundary; the
      // harvest consumer holds the cursor as a config problem, not an outage).
      if (
        res.status >= 400 &&
        res.status < 500 &&
        !RETRYABLE_STATUS.has(res.status)
      ) {
        throw new MaisterError(
          "CONFIG",
          `embedding provider rejected ${op} (status ${res.status}) — check the embedding provider configuration/input`,
        );
      }

      // Retries exhausted on a retryable status.
      break;
    }

    throw new MaisterError(
      "EMBEDDING_UNAVAILABLE",
      `embedding provider ${op} failed after ${maxRetries + 1} attempt(s)` +
        (lastStatus ? ` (last status ${lastStatus})` : " (network error)"),
    );
  }

  return {
    provider: "openai_compatible",
    model: cfg.embeddingModel,
    dimensions: cfg.embeddingDimensions,
    version: embeddingVersion(cfg.embeddingModel, cfg.embeddingDimensions),

    async embed(texts: string[]): Promise<number[][]> {
      if (texts.length === 0) return [];

      const json = (await request(
        "/embeddings",
        { model: cfg.embeddingModel, input: texts },
        "embed",
      )) as { data?: Array<{ embedding?: number[]; index?: number }> };

      // The OpenAI contract carries `data[].index`; a parallelizing gateway may
      // return batches out of order — trusting array order would silently store
      // the WRONG vector per text. Sort by index when present.
      const data = [...(json.data ?? [])].sort(
        (a, b) => (a.index ?? 0) - (b.index ?? 0),
      );
      const vectors = data.map((d) => d.embedding ?? []);

      if (vectors.length !== texts.length) {
        throw new MaisterError(
          "EMBEDDING_UNAVAILABLE",
          `embedding provider returned ${vectors.length} vectors for ${texts.length} inputs`,
        );
      }

      for (const v of vectors) {
        if (v.length !== cfg.embeddingDimensions) {
          throw new MaisterError(
            "CONFIG",
            `embedding dimension mismatch: provider returned ${v.length}, configured ${cfg.embeddingDimensions}`,
          );
        }
        for (const x of v) {
          if (typeof x !== "number" || !Number.isFinite(x)) {
            throw new MaisterError(
              "CONFIG",
              "embedding provider returned a non-numeric vector component",
            );
          }
        }
      }

      return vectors;
    },

    async complete(
      prompt: string,
      opts?: { json?: boolean; maxTokens?: number },
    ): Promise<string> {
      if (!cfg.distillModel) {
        throw new MaisterError(
          "CONFIG",
          "distill_model is not configured — harvest distillation cannot run",
        );
      }

      const json = (await request(
        "/chat/completions",
        {
          model: cfg.distillModel,
          messages: [{ role: "user", content: prompt }],
          ...(opts?.json ? { response_format: { type: "json_object" } } : {}),
          // Cost bound — a runaway model must not emit unbounded output.
          ...(opts?.maxTokens ? { max_tokens: opts.maxTokens } : {}),
        },
        "complete",
      )) as { choices?: Array<{ message?: { content?: string } }> };

      return json.choices?.[0]?.message?.content ?? "";
    },
  };
}

// Load settings and build the client. Throws CONFIG when the embedding config is
// missing (unreachable in steady state given the T5.2 enable-gate; on the
// harvest path a cleared config is treated as transient → cursor holds).
export async function getBrainEmbeddingClient(
  db?: Parameters<typeof getBrainSettings>[0],
): Promise<OpenAiCompatibleClient> {
  const s = await getBrainSettings(db);

  if (!isEmbeddingConfigured(s)) {
    throw new MaisterError(
      "CONFIG",
      "Project Brain embedding provider is not configured (base URL / model / dimensions)",
    );
  }

  return makeEmbeddingClient({
    baseUrl: s.embeddingBaseUrl as string,
    embeddingModel: s.embeddingModel as string,
    embeddingDimensions: s.embeddingDimensions as number,
    apiKeyRef: s.embeddingApiKeyRef,
    distillModel: s.distillModel,
  });
}
