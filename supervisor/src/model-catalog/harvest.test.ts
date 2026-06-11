// T2.4 — passive harvest unit coverage. A session/new (or resume) response that
// carries model state populates the shared cache tagged agent_observed; a
// response without models is a no-op; a harvest failure never throws into the
// session path.
import type * as acp from "@agentclientprotocol/sdk";
import type { RunnerLaunch } from "../types";

import pino from "pino";
import { describe, expect, it } from "vitest";

import { ModelCatalogCache } from "./cache";
import { draftFromRunner, harvestSessionModels } from "./harvest";

const silent = pino({ level: "silent" });

const runner: RunnerLaunch = {
  version: 1,
  runnerId: "r1",
  adapter: "claude",
  capabilityAgent: "claude",
  model: "glm-5.1",
  provider: {
    kind: "anthropic_compatible",
    baseUrl: "https://api.z.ai/api/anthropic",
    authTokenEnv: "ZAI_API_KEY",
  },
  permissionPolicy: "default",
};

const modelState: acp.SessionModelState = {
  availableModels: [
    { modelId: "glm-5.1", name: "GLM-5.1" },
    { modelId: "glm-5", name: "GLM-5" },
  ],
  currentModelId: "glm-5.1",
};

describe("harvestSessionModels", () => {
  it("populates the cache (agent_observed) from an observed model state", () => {
    const cache = new ModelCatalogCache();

    harvestSessionModels(runner, modelState, cache, silent);

    const hit = cache.get(draftFromRunner(runner));

    expect(hit?.models.map((m) => m.id)).toEqual(["glm-5.1", "glm-5"]);
    expect(hit?.models[0]).toEqual({
      id: "glm-5.1",
      displayName: "GLM-5.1",
      origins: ["agent_observed"],
    });
    expect(hit?.sources).toEqual([
      { kind: "agent_observed", status: "ok", count: 2 },
    ]);
  });

  it("is a no-op for a null model state, an empty list, or no runner", () => {
    const cache = new ModelCatalogCache();

    harvestSessionModels(runner, null, cache, silent);
    harvestSessionModels(
      runner,
      { availableModels: [], currentModelId: "" },
      cache,
      silent,
    );
    harvestSessionModels(undefined, modelState, cache, silent);

    expect(cache.get(draftFromRunner(runner))).toBeUndefined();
  });

  // The wire is unvalidated (the ACP SDK applies no response schema): a
  // malformed adapter `models` payload must be ignored, never thrown into the
  // session spawn path.
  it("never throws on a malformed adapter model state", () => {
    const cache = new ModelCatalogCache();

    expect(() =>
      harvestSessionModels(
        runner,
        {} as acp.SessionModelState,
        cache,
        silent,
      ),
    ).not.toThrow();
    expect(() =>
      harvestSessionModels(
        runner,
        { availableModels: "glm-5.1" } as unknown as acp.SessionModelState,
        cache,
        silent,
      ),
    ).not.toThrow();
    expect(cache.get(draftFromRunner(runner))).toBeUndefined();
  });

  it("never throws when the cache write fails (live-path safety)", () => {
    const throwingCache = {
      setMerged: () => {
        throw new Error("cache boom");
      },
    } as unknown as ModelCatalogCache;

    expect(() =>
      harvestSessionModels(runner, modelState, throwingCache, silent),
    ).not.toThrow();
  });

  // ADR-075 regression: a real session observes only a subset of the catalog;
  // harvest must ENRICH the existing resolved entry, never shrink it.
  it("merges observed models into an existing catalog without dropping prior models/sources", () => {
    const cache = new ModelCatalogCache();
    const draft = draftFromRunner(runner);

    cache.set(draft, {
      models: [
        { id: "glm-5.1", displayName: "GLM-5.1", origins: ["acp_probe"] },
        { id: "glm-5", displayName: "GLM-5", origins: ["acp_probe"] },
        { id: "glm-4.6", displayName: "GLM-4.6", origins: ["curated"] },
      ],
      sources: [
        { kind: "acp_probe", status: "ok", count: 2 },
        { kind: "curated", status: "ok", count: 1 },
      ],
      resolvedAt: new Date(0).toISOString(),
      ttlSeconds: 3600,
    });

    harvestSessionModels(
      runner,
      {
        availableModels: [{ modelId: "glm-5.1", name: "GLM-5.1" }],
        currentModelId: "glm-5.1",
      },
      cache,
      silent,
    );

    const hit = cache.get(draft);

    expect(hit?.models.map((m) => m.id).sort()).toEqual([
      "glm-4.6",
      "glm-5",
      "glm-5.1",
    ]);
    expect(hit?.models.find((m) => m.id === "glm-5.1")?.origins.sort()).toEqual(
      ["acp_probe", "agent_observed"],
    );
    expect(hit?.sources.map((s) => s.kind).sort()).toEqual([
      "acp_probe",
      "agent_observed",
      "curated",
    ]);
    // No duplicate agent_observed source row on a second harvest.
    harvestSessionModels(runner, modelState, cache, silent);
    expect(
      cache.get(draft)?.sources.filter((s) => s.kind === "agent_observed"),
    ).toHaveLength(1);
  });

  it("does not extend the underlying catalog's TTL window on harvest", () => {
    let nowMs = 1_000_000;
    const cache = new ModelCatalogCache({ now: () => nowMs, ttlSeconds: 100 });
    const draft = draftFromRunner(runner);

    cache.set(draft, {
      models: [{ id: "glm-5.1", origins: ["acp_probe"] }],
      sources: [{ kind: "acp_probe", status: "ok", count: 1 }],
      resolvedAt: new Date(nowMs).toISOString(),
      ttlSeconds: 100,
    });

    nowMs += 90_000; // within the original 100s window
    harvestSessionModels(runner, modelState, cache, silent);

    nowMs += 20_000; // 110s after the ORIGINAL insert → must be expired
    expect(cache.get(draft)).toBeUndefined();
  });

  it("draftFromRunner maps a CCR sidecar to router + sidecarId", () => {
    const ccrRunner: RunnerLaunch = {
      ...runner,
      sidecar: { id: "ccr-1", kind: "ccr" },
    };

    expect(draftFromRunner(ccrRunner)).toMatchObject({
      adapter: "claude",
      router: "ccr",
      sidecarId: "ccr-1",
    });
    expect(draftFromRunner(runner).router).toBeUndefined();
  });
});
