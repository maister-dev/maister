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

  it("never throws when the cache write fails (live-path safety)", () => {
    const throwingCache = {
      set: () => {
        throw new Error("cache boom");
      },
    } as unknown as ModelCatalogCache;

    expect(() =>
      harvestSessionModels(runner, modelState, throwingCache, silent),
    ).not.toThrow();
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
