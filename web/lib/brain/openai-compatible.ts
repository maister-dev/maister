import "server-only";

import pino from "pino";

import { getBrainSettings, isEmbeddingConfigured } from "./settings";

import { MaisterError } from "@/lib/errors";

// Project Brain (ADR-122) OpenAI-compatible client. Symmetric embed + complete
// over one HTTP module. Config comes from `platform_runtime_settings`; the API
// key is resolved from process.env via the `env:NAME` ref (mirrors
// web/lib/mcp/projection.ts). Bounded retry on transient failures
// (timeout/429/5xx) → then `EMBEDDING_UNAVAILABLE`. The key and request/response
// bodies are NEVER logged or included in a thrown message (E-10).

const log = pino({
  name: "brain:openai-compatible",
  level: process.env.LOG_LEVEL ?? "info",
});

// Mirror of web/lib/mcp/projection.ts `stripEnvPrefix` (one-liner, kept local to
// avoid importing a server-only MCP module into the brain module).
function stripEnvPrefix(ref: string): string {
  return ref.startsWith("env:") ? ref.slice(4) : ref;
}

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
  complete(prompt: string, opts?: { json?: boolean }): Promise<string>;
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
  // key/payload). Retries on network error / retryable status; other HTTP
  // errors and exhausted retries throw EMBEDDING_UNAVAILABLE.
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
            baseUrl: base,
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

      if (res.ok) return await res.json();

      lastStatus = res.status;

      if (RETRYABLE_STATUS.has(res.status) && attempt < maxRetries) {
        log.warn(
          {
            op,
            attempt,
            status: res.status,
            model: cfg.embeddingModel,
            baseUrl: base,
          },
          "embedding request failed, retrying",
        );
        await sleep(retryDelayMs * 2 ** attempt);
        continue;
      }

      // Non-retryable HTTP error, or retries exhausted on a retryable one.
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
      )) as { data?: Array<{ embedding?: number[] }> };

      const vectors = (json.data ?? []).map((d) => d.embedding ?? []);

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
      }

      return vectors;
    },

    async complete(prompt: string, opts?: { json?: boolean }): Promise<string> {
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
