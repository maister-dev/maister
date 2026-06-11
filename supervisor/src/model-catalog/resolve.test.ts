import { describe, expect, it } from "vitest";
import pino from "pino";

import { ModelSourceRegistry } from "./registry";
import { resolveModelCatalog } from "./resolve";
import {
  MODEL_CATALOG_TTL_SECONDS,
  ModelCatalogDraftSchema,
  type ModelCatalogDraft,
  type ModelEntry,
  type ModelSource,
  type ResolveContext,
  type SourceKind,
  type SourceStatus,
} from "./types";

const ctx: ResolveContext = { logger: pino({ level: "silent" }) };

const draft: ModelCatalogDraft = {
  adapter: "claude",
  provider: { kind: "anthropic" },
};

function okSource(
  kind: SourceKind,
  models: ModelEntry[],
  statusOverride?: Partial<SourceStatus>,
): ModelSource {
  return {
    kind,
    supports: () => true,
    resolve: async () => ({
      models,
      status: { kind, status: "ok", count: models.length, ...statusOverride },
    }),
  };
}

function skippedSource(kind: SourceKind, reason: string): ModelSource {
  return {
    kind,
    supports: () => true,
    resolve: async () => ({
      models: [],
      status: { kind, status: "skipped", reason },
    }),
  };
}

function throwingSource(kind: SourceKind, message: string): ModelSource {
  return {
    kind,
    supports: () => true,
    resolve: async () => {
      throw new Error(message);
    },
  };
}

describe("resolveModelCatalog", () => {
  it("dedupes by id; origins accumulate both kinds in registry order; body from first source", async () => {
    const first = okSource("acp_probe", [
      { id: "glm-5.1", displayName: "GLM 5.1 (probe)", origins: ["acp_probe"] },
    ]);
    const second = okSource("curated", [
      { id: "glm-5.1", displayName: "GLM 5.1 (curated)", origins: ["curated"] },
    ]);
    const registry = new ModelSourceRegistry([first, second]);

    const result = await resolveModelCatalog(draft, registry, ctx);

    expect(result.models).toHaveLength(1);
    expect(result.models[0]).toEqual({
      id: "glm-5.1",
      displayName: "GLM 5.1 (probe)",
      origins: ["acp_probe", "curated"],
    });
  });

  it("preserves first-seen model order across sources", async () => {
    const first = okSource("acp_probe", [
      { id: "a", origins: ["acp_probe"] },
      { id: "b", origins: ["acp_probe"] },
    ]);
    const second = okSource("provider_api", [
      { id: "b", origins: ["provider_api"] },
      { id: "c", origins: ["provider_api"] },
    ]);
    const registry = new ModelSourceRegistry([first, second]);

    const result = await resolveModelCatalog(draft, registry, ctx);

    expect(result.models.map((m) => m.id)).toEqual(["a", "b", "c"]);
    expect(result.models.find((m) => m.id === "b")?.origins).toEqual([
      "acp_probe",
      "provider_api",
    ]);
  });

  it("aggregates per-source status: ok + skipped + thrower(error) all surfaced; thrower carries its message; ok models still returned", async () => {
    const ok = okSource("acp_probe", [{ id: "m1", origins: ["acp_probe"] }]);
    const skipped = skippedSource("ccr", "router not configured");
    const thrower = throwingSource("provider_api", "boom: provider 500");
    const registry = new ModelSourceRegistry([ok, skipped, thrower]);

    const result = await resolveModelCatalog(draft, registry, ctx);

    expect(result.models).toEqual([{ id: "m1", origins: ["acp_probe"] }]);
    expect(result.sources).toEqual([
      { kind: "acp_probe", status: "ok", count: 1 },
      { kind: "ccr", status: "skipped", reason: "router not configured" },
      { kind: "provider_api", status: "error", reason: "boom: provider 500" },
    ]);
  });

  it("a thrown non-Error becomes an error status with a stringified reason and zero models", async () => {
    const thrower: ModelSource = {
      kind: "curated",
      supports: () => true,
      resolve: async () => {
        throw "raw string failure";
      },
    };
    const registry = new ModelSourceRegistry([thrower]);

    const result = await resolveModelCatalog(draft, registry, ctx);

    expect(result.models).toEqual([]);
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0].kind).toBe("curated");
    expect(result.sources[0].status).toBe("error");
    expect(result.sources[0].reason).toContain("raw string failure");
  });

  it("count per source reflects pre-dedupe contribution", async () => {
    const first = okSource("acp_probe", [
      { id: "x", origins: ["acp_probe"] },
      { id: "y", origins: ["acp_probe"] },
    ]);
    const second = okSource("curated", [
      { id: "x", origins: ["curated"] },
      { id: "z", origins: ["curated"] },
    ]);
    const registry = new ModelSourceRegistry([first, second]);

    const result = await resolveModelCatalog(draft, registry, ctx);

    expect(result.sources.map((s) => s.count)).toEqual([2, 2]);
    expect(result.models).toHaveLength(3);
  });

  it("empty supporting set returns an empty result with ttl + iso resolvedAt", async () => {
    const registry = new ModelSourceRegistry([
      {
        kind: "acp_probe",
        supports: () => false,
        resolve: async () => {
          throw new Error("must not be called");
        },
      },
    ]);

    const result = await resolveModelCatalog(draft, registry, ctx);

    expect(result.models).toEqual([]);
    expect(result.sources).toEqual([]);
    expect(result.ttlSeconds).toBe(MODEL_CATALOG_TTL_SECONDS);
    expect(result.ttlSeconds).toBe(3600);
    expect(new Date(result.resolvedAt).toISOString()).toBe(result.resolvedAt);
  });

  it("only runs supports()-matching sources; non-supporting sources are never resolved", async () => {
    let called = false;
    const supporting = okSource("acp_probe", [
      { id: "m1", origins: ["acp_probe"] },
    ]);
    const notSupporting: ModelSource = {
      kind: "ccr",
      supports: () => false,
      resolve: async () => {
        called = true;

        return { models: [], status: { kind: "ccr", status: "ok" } };
      },
    };
    const registry = new ModelSourceRegistry([supporting, notSupporting]);

    const result = await resolveModelCatalog(draft, registry, ctx);

    expect(called).toBe(false);
    expect(result.sources.map((s) => s.kind)).toEqual(["acp_probe"]);
  });
});

describe("ModelCatalogDraftSchema", () => {
  it("accepts a valid env-router draft with bare authTokenEnv name", () => {
    const parsed = ModelCatalogDraftSchema.safeParse({
      adapter: "claude",
      provider: {
        kind: "anthropic_compatible",
        baseUrl: "https://api.z.ai/api/anthropic",
        authTokenEnv: "ZAI_API_KEY",
      },
    });

    expect(parsed.success).toBe(true);
  });

  it("rejects an env:-prefixed authTokenEnv (RunnerProviderSchema enforces bare names)", () => {
    const parsed = ModelCatalogDraftSchema.safeParse({
      adapter: "claude",
      provider: {
        kind: "anthropic_compatible",
        authTokenEnv: "env:ZAI_API_KEY",
      },
    });

    expect(parsed.success).toBe(false);
  });

  it("rejects provider kinds that do not belong to the adapter", () => {
    const parsed = ModelCatalogDraftSchema.safeParse({
      adapter: "gemini",
      provider: { kind: "anthropic" },
    });

    expect(parsed.success).toBe(false);
  });

  it("accepts a ccr router draft with a valid sidecarId", () => {
    const parsed = ModelCatalogDraftSchema.safeParse({
      adapter: "claude",
      provider: { kind: "anthropic" },
      router: "ccr",
      sidecarId: "ccr-main",
      force: true,
    });

    expect(parsed.success).toBe(true);
  });

  it("rejects unknown top-level keys (strict)", () => {
    const parsed = ModelCatalogDraftSchema.safeParse({
      adapter: "claude",
      provider: { kind: "anthropic" },
      bogus: 1,
    });

    expect(parsed.success).toBe(false);
  });

  it("rejects a sidecarId with a path separator", () => {
    const parsed = ModelCatalogDraftSchema.safeParse({
      adapter: "codex",
      provider: { kind: "openai" },
      sidecarId: "bad/id",
    });

    expect(parsed.success).toBe(false);
  });
});
