import {
  MODEL_CATALOG_TTL_SECONDS,
  type ModelCatalogDraft,
  type ModelCatalogResult,
} from "./types";

type CacheEntry = { result: ModelCatalogResult; insertedAt: number };

function envRefNames(provider: ModelCatalogDraft["provider"]): string[] {
  const names: string[] = [];

  if (provider.kind === "anthropic_compatible" && provider.authTokenEnv)
    names.push(provider.authTokenEnv);
  if (provider.kind === "openai_compatible" && provider.apiKeyEnv)
    names.push(provider.apiKeyEnv);

  return names.sort();
}

function baseUrlForKey(provider: ModelCatalogDraft["provider"]): string {
  if (
    provider.kind === "anthropic_compatible" ||
    provider.kind === "openai_compatible"
  )
    return provider.baseUrl ?? "";

  return "";
}

export class ModelCatalogCache {
  private readonly store = new Map<string, CacheEntry>();
  private readonly now: () => number;
  private readonly ttlMs: number;

  constructor(opts?: { now?: () => number; ttlSeconds?: number }) {
    this.now = opts?.now ?? Date.now;
    this.ttlMs = (opts?.ttlSeconds ?? MODEL_CATALOG_TTL_SECONDS) * 1000;
  }

  // Key = (adapter, provider.kind, base URL, sorted env-ref NAMES, router, sidecarId).
  // Env-ref names only (e.g. ZAI_API_KEY) — never secret values, by design.
  keyFor(draft: ModelCatalogDraft): string {
    return JSON.stringify([
      draft.adapter,
      draft.provider.kind,
      baseUrlForKey(draft.provider),
      envRefNames(draft.provider),
      draft.router ?? "",
      draft.sidecarId ?? "",
    ]);
  }

  get(draft: ModelCatalogDraft): ModelCatalogResult | undefined {
    const key = this.keyFor(draft);
    const entry = this.store.get(key);

    if (!entry) return undefined;
    if (this.now() - entry.insertedAt < this.ttlMs) return entry.result;

    this.store.delete(key);

    return undefined;
  }

  // The cache does NOT know about `force`: the caller skips get() and calls set()
  // after re-resolving when force is true.
  set(draft: ModelCatalogDraft, result: ModelCatalogResult): void {
    this.store.set(this.keyFor(draft), { result, insertedAt: this.now() });
  }

  // Passive-harvest enrichment (harvest.ts): replace the cached RESULT via `merge`
  // while PRESERVING a live entry's original `insertedAt`, so an observed-models
  // harvest enriches the catalog without extending the TTL of slow-moving
  // provider/curated rows (they must still expire on their own schedule). `merge`
  // receives the live result, or undefined when the entry is absent OR expired —
  // in which case this behaves like a fresh set().
  setMerged(
    draft: ModelCatalogDraft,
    merge: (prev: ModelCatalogResult | undefined) => ModelCatalogResult,
  ): void {
    const key = this.keyFor(draft);
    const entry = this.store.get(key);
    const live =
      entry && this.now() - entry.insertedAt < this.ttlMs ? entry : undefined;

    this.store.set(key, {
      result: merge(live?.result),
      insertedAt: live ? live.insertedAt : this.now(),
    });
  }

  clear(): void {
    this.store.clear();
  }
}

export const modelCatalogCache = new ModelCatalogCache();
