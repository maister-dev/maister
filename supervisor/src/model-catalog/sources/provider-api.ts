import type {
  ModelCatalogDraft,
  ModelEntry,
  ModelSource,
  ResolveContext,
  SourceStatus,
} from "../types";

type RunnerProvider = ModelCatalogDraft["provider"];

type SourceResult = { models: ModelEntry[]; status: SourceStatus };

const ANTHROPIC_DEFAULT_BASE = "https://api.anthropic.com";
const OPENAI_DEFAULT_BASE = "https://api.openai.com";
const ANTHROPIC_VERSION = "2023-06-01";

function status(s: "skipped" | "error", reason: string): SourceStatus {
  return { kind: "provider_api", status: s, reason };
}

// Append the listing path. A base that already ends in a version segment
// (e.g. OpenRouter `…/api/v1`, z.ai paas `…/v4`) only needs `/models`; otherwise
// append `/v1/models` — this covers native Anthropic/OpenAI AND
// `anthropic_compatible` bases like z.ai `…/api/anthropic`, which mirror the
// native `/v1/models` shape (and avoids a doubled `/v1/v1/models`).
function modelsUrl(base: string): string {
  const trimmed = base.replace(/\/+$/, "");

  return /\/v\d+$/.test(trimmed) ? `${trimmed}/models` : `${trimmed}/v1/models`;
}

function readEnv(name: string): string | undefined {
  const value = process.env[name];

  return value && value.length > 0 ? value : undefined;
}

function parseModels(body: unknown): ModelEntry[] {
  if (
    typeof body !== "object" ||
    body === null ||
    !Array.isArray((body as { data?: unknown }).data)
  ) {
    throw new Error("malformed models response");
  }

  const data = (body as { data: unknown[] }).data;
  const models: ModelEntry[] = [];

  for (const item of data) {
    const id = (item as { id?: unknown }).id;

    if (typeof id === "string" && id.length > 0) {
      models.push({ id, origins: ["provider_api"] });
    }
  }

  return models;
}

async function listModels(
  url: string,
  headers: Record<string, string>,
  fetchImpl: typeof fetch,
  ctx: ResolveContext,
): Promise<SourceResult> {
  let response: Awaited<ReturnType<typeof fetch>>;

  try {
    response = await fetchImpl(url, { headers, signal: ctx.signal });
  } catch {
    return { models: [], status: status("error", "models request failed") };
  }

  if (!response.ok) {
    return {
      models: [],
      status: status("error", `models request returned ${response.status}`),
    };
  }

  let body: unknown;

  try {
    body = await response.json();
  } catch {
    return {
      models: [],
      status: status("error", "malformed models response"),
    };
  }

  let models: ModelEntry[];

  try {
    models = parseModels(body);
  } catch {
    return {
      models: [],
      status: status("error", "malformed models response"),
    };
  }

  ctx.logger.info(
    { source: "provider_api", status: "ok", count: models.length },
    "model source resolved",
  );

  return {
    models,
    status: { kind: "provider_api", status: "ok", count: models.length },
  };
}

async function resolveAnthropic(
  fetchImpl: typeof fetch,
  ctx: ResolveContext,
): Promise<SourceResult> {
  const key = readEnv("ANTHROPIC_API_KEY");

  if (!key) {
    return { models: [], status: status("skipped", "no anthropic api key") };
  }

  return listModels(
    modelsUrl(ANTHROPIC_DEFAULT_BASE),
    { "x-api-key": key, "anthropic-version": ANTHROPIC_VERSION },
    fetchImpl,
    ctx,
  );
}

async function resolveAnthropicCompatible(
  provider: Extract<RunnerProvider, { kind: "anthropic_compatible" }>,
  fetchImpl: typeof fetch,
  ctx: ResolveContext,
): Promise<SourceResult> {
  if (!provider.baseUrl) {
    return {
      models: [],
      status: status("skipped", "no base url for authed listing"),
    };
  }
  if (!provider.authTokenEnv) {
    return {
      models: [],
      status: status("skipped", "no auth token env for authed listing"),
    };
  }

  const key = readEnv(provider.authTokenEnv);

  if (!key) {
    return { models: [], status: status("error", "env ref not set") };
  }

  return listModels(
    modelsUrl(provider.baseUrl),
    { "x-api-key": key, "anthropic-version": ANTHROPIC_VERSION },
    fetchImpl,
    ctx,
  );
}

async function resolveOpenai(
  fetchImpl: typeof fetch,
  ctx: ResolveContext,
): Promise<SourceResult> {
  const key = readEnv("OPENAI_API_KEY");

  if (!key) {
    return { models: [], status: status("skipped", "no openai api key") };
  }

  return listModels(
    modelsUrl(OPENAI_DEFAULT_BASE),
    { Authorization: `Bearer ${key}` },
    fetchImpl,
    ctx,
  );
}

async function resolveOpenaiCompatible(
  provider: Extract<RunnerProvider, { kind: "openai_compatible" }>,
  fetchImpl: typeof fetch,
  ctx: ResolveContext,
): Promise<SourceResult> {
  const key = provider.apiKeyEnv ? readEnv(provider.apiKeyEnv) : undefined;

  if (!provider.baseUrl && !key) {
    return {
      models: [],
      status: status("skipped", "no base url and no api key"),
    };
  }

  const headers: Record<string, string> = key
    ? { Authorization: `Bearer ${key}` }
    : {};

  return listModels(
    modelsUrl(provider.baseUrl ?? OPENAI_DEFAULT_BASE),
    headers,
    fetchImpl,
    ctx,
  );
}

export function createProviderApiSource(opts?: {
  fetchImpl?: typeof fetch;
}): ModelSource {
  const fetchImpl = opts?.fetchImpl ?? fetch;

  return {
    kind: "provider_api",
    // Direct provider listing — declines CCR-routed drafts (a CCR runner's
    // models come from the CCR proxy config, not a direct provider /v1/models).
    supports: (draft: ModelCatalogDraft) =>
      draft.router !== "ccr" &&
      (draft.provider.kind === "anthropic" ||
        draft.provider.kind === "openai" ||
        draft.provider.kind === "openai_compatible" ||
        draft.provider.kind === "anthropic_compatible"),
    resolve: async (
      draft: ModelCatalogDraft,
      ctx: ResolveContext,
    ): Promise<SourceResult> => {
      const provider = draft.provider;

      switch (provider.kind) {
        case "anthropic":
          return resolveAnthropic(fetchImpl, ctx);
        case "anthropic_compatible":
          return resolveAnthropicCompatible(provider, fetchImpl, ctx);
        case "openai":
          return resolveOpenai(fetchImpl, ctx);
        case "openai_compatible":
          return resolveOpenaiCompatible(provider, fetchImpl, ctx);
      }
    },
  };
}
