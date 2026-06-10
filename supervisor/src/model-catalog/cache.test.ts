import { describe, expect, it } from "vitest";

import { ModelCatalogCache } from "./cache";
import {
  MODEL_CATALOG_TTL_SECONDS,
  type ModelCatalogDraft,
  type ModelCatalogResult,
} from "./types";

function makeResult(
  overrides?: Partial<ModelCatalogResult>,
): ModelCatalogResult {
  return {
    models: [{ id: "glm-4.6", origins: ["curated"] }],
    sources: [{ kind: "curated", status: "ok", count: 1 }],
    resolvedAt: "2026-06-11T00:00:00.000Z",
    ttlSeconds: MODEL_CATALOG_TTL_SECONDS,
    ...overrides,
  };
}

const zaiDraft: ModelCatalogDraft = {
  adapter: "claude",
  provider: {
    kind: "anthropic_compatible",
    baseUrl: "https://api.z.ai/api/anthropic",
    authTokenEnv: "ZAI_API_KEY",
  },
};

function clock(start = 0): {
  now: () => number;
  advance: (ms: number) => void;
} {
  let t = start;

  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe("ModelCatalogCache", () => {
  it("hit within TTL: set then get returns the same result object; repeated get within TTL also hits", () => {
    const c = clock();
    const cache = new ModelCatalogCache({ now: c.now });
    const result = makeResult();

    cache.set(zaiDraft, result);

    c.advance(MODEL_CATALOG_TTL_SECONDS * 1000 - 1);
    const first = cache.get(zaiDraft);

    expect(first).toBe(result);

    const second = cache.get(zaiDraft);

    expect(second).toBe(result);
  });

  it("miss after TTL: advancing now to exactly ttl boundary returns undefined", () => {
    const c = clock();
    const cache = new ModelCatalogCache({ now: c.now });

    cache.set(zaiDraft, makeResult());

    c.advance(MODEL_CATALOG_TTL_SECONDS * 1000);
    expect(cache.get(zaiDraft)).toBeUndefined();
  });

  it("miss after TTL: well past the window returns undefined", () => {
    const c = clock();
    const cache = new ModelCatalogCache({ now: c.now });

    cache.set(zaiDraft, makeResult());

    c.advance(MODEL_CATALOG_TTL_SECONDS * 1000 + 10_000);
    expect(cache.get(zaiDraft)).toBeUndefined();
  });

  it("honors a custom ttlSeconds for the boundary", () => {
    const c = clock();
    const cache = new ModelCatalogCache({ now: c.now, ttlSeconds: 10 });

    cache.set(zaiDraft, makeResult());

    c.advance(9_999);
    expect(cache.get(zaiDraft)).toBeDefined();

    c.advance(1);
    expect(cache.get(zaiDraft)).toBeUndefined();
  });

  it("force semantics belong to the caller: set overwrites and re-stamps insertion time, extending validity", () => {
    const c = clock();
    const cache = new ModelCatalogCache({ now: c.now });
    const stale = makeResult({ resolvedAt: "2026-06-11T00:00:00.000Z" });

    cache.set(zaiDraft, stale);

    // advance to just before expiry, then a caller-driven (force) re-set
    c.advance(MODEL_CATALOG_TTL_SECONDS * 1000 - 1);
    const fresh = makeResult({ resolvedAt: "2026-06-11T01:00:00.000Z" });

    cache.set(zaiDraft, fresh);

    // a full near-TTL window later than the FIRST insert, the new entry is still live
    c.advance(MODEL_CATALOG_TTL_SECONDS * 1000 - 1);
    expect(cache.get(zaiDraft)).toBe(fresh);
  });

  it("key isolation: drafts differing by provider.kind get independent entries", () => {
    const cache = new ModelCatalogCache();
    const a: ModelCatalogDraft = {
      adapter: "claude",
      provider: { kind: "anthropic" },
    };
    const b: ModelCatalogDraft = {
      adapter: "claude",
      provider: { kind: "openai" },
    };

    const ra = makeResult();

    cache.set(a, ra);
    expect(cache.get(b)).toBeUndefined();
    expect(cache.get(a)).toBe(ra);
  });

  it("key isolation: drafts differing by baseUrl get independent entries", () => {
    const cache = new ModelCatalogCache();
    const a: ModelCatalogDraft = {
      adapter: "claude",
      provider: {
        kind: "anthropic_compatible",
        baseUrl: "https://api.z.ai/api/anthropic",
      },
    };
    const b: ModelCatalogDraft = {
      adapter: "claude",
      provider: {
        kind: "anthropic_compatible",
        baseUrl: "https://openrouter.ai/api/anthropic",
      },
    };

    cache.set(a, makeResult());
    expect(cache.get(b)).toBeUndefined();
  });

  it("key isolation: drafts differing by env-ref NAME get independent entries", () => {
    const cache = new ModelCatalogCache();
    const a: ModelCatalogDraft = {
      adapter: "claude",
      provider: { kind: "anthropic_compatible", authTokenEnv: "ZAI_API_KEY" },
    };
    const b: ModelCatalogDraft = {
      adapter: "claude",
      provider: {
        kind: "anthropic_compatible",
        authTokenEnv: "OPENROUTER_API_KEY",
      },
    };

    cache.set(a, makeResult());
    expect(cache.get(b)).toBeUndefined();
  });

  it("key isolation: drafts differing by router get independent entries", () => {
    const cache = new ModelCatalogCache();
    const a: ModelCatalogDraft = {
      adapter: "claude",
      provider: { kind: "anthropic" },
    };
    const b: ModelCatalogDraft = {
      adapter: "claude",
      provider: { kind: "anthropic" },
      router: "ccr",
    };

    cache.set(a, makeResult());
    expect(cache.get(b)).toBeUndefined();
  });

  it("key isolation: drafts differing by sidecarId get independent entries", () => {
    const cache = new ModelCatalogCache();
    const a: ModelCatalogDraft = {
      adapter: "claude",
      provider: { kind: "anthropic" },
      router: "ccr",
      sidecarId: "ccr-main",
    };
    const b: ModelCatalogDraft = {
      adapter: "claude",
      provider: { kind: "anthropic" },
      router: "ccr",
      sidecarId: "ccr-alt",
    };

    cache.set(a, makeResult());
    expect(cache.get(b)).toBeUndefined();
  });

  it("same names -> same key: identical (adapter, kind, baseUrl, env-ref names, router, sidecarId) share one entry", () => {
    const cache = new ModelCatalogCache();
    const a: ModelCatalogDraft = {
      adapter: "claude",
      provider: {
        kind: "anthropic_compatible",
        baseUrl: "https://api.z.ai/api/anthropic",
        authTokenEnv: "ZAI_API_KEY",
      },
    };
    const b: ModelCatalogDraft = {
      adapter: "claude",
      provider: {
        kind: "anthropic_compatible",
        baseUrl: "https://api.z.ai/api/anthropic",
        authTokenEnv: "ZAI_API_KEY",
      },
    };

    const result = makeResult();

    cache.set(a, result);
    expect(cache.get(b)).toBe(result);
  });

  it("force flag on the draft is NOT part of the key (caller owns force; cache ignores it)", () => {
    const cache = new ModelCatalogCache();
    const withForce: ModelCatalogDraft = {
      adapter: "claude",
      provider: { kind: "anthropic" },
      force: true,
    };
    const withoutForce: ModelCatalogDraft = {
      adapter: "claude",
      provider: { kind: "anthropic" },
    };

    const result = makeResult();

    cache.set(withoutForce, result);
    expect(cache.get(withForce)).toBe(result);
  });

  it("key is built from the env-ref NAME: the key string contains the name and changing the name changes the key", () => {
    const cache = new ModelCatalogCache();
    const a: ModelCatalogDraft = {
      adapter: "claude",
      provider: { kind: "anthropic_compatible", authTokenEnv: "ZAI_API_KEY" },
    };

    const keyA = cache.keyFor(a);

    expect(keyA).toContain("ZAI_API_KEY");

    const b: ModelCatalogDraft = {
      adapter: "claude",
      provider: { kind: "anthropic_compatible", authTokenEnv: "OTHER_KEY" },
    };

    expect(cache.keyFor(b)).not.toBe(keyA);
    expect(cache.keyFor(b)).toContain("OTHER_KEY");
  });

  it("clear() empties the cache", () => {
    const cache = new ModelCatalogCache();

    cache.set(zaiDraft, makeResult());
    expect(cache.get(zaiDraft)).toBeDefined();

    cache.clear();
    expect(cache.get(zaiDraft)).toBeUndefined();
  });
});
