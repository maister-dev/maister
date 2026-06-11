// T1.4 — POST /model-catalog/resolve route (ADR-075). Boots Fastify with a
// stubbed ModelSource registry (no real probe/network) and exercises the route
// through app.inject: happy path, draft validation (409), cache hit/force, and
// the frozen invariant that a per-source failure surfaces inside a 200 — never
// a 5xx from the resolve itself.
import type {
  ModelEntry,
  ModelSource,
  SourceKind,
} from "../model-catalog/types";

import Fastify, { type FastifyInstance } from "fastify";
import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import { registerRoutes } from "../http-api";
import { ModelCatalogCache } from "../model-catalog/cache";
import { ModelSourceRegistry } from "../model-catalog/registry";
import { SessionRegistry } from "../registry";

const silentLogger = pino({ level: "silent" });

function fakeSource(
  kind: SourceKind,
  models: ModelEntry[],
  opts: {
    onResolve?: () => void;
    throwError?: Error;
    status?: "ok" | "skipped";
  } = {},
): ModelSource {
  return {
    kind,
    supports: () => true,
    resolve: async () => {
      opts.onResolve?.();

      if (opts.throwError) throw opts.throwError;

      return {
        models,
        status: { kind, status: opts.status ?? "ok", count: models.length },
      };
    },
  };
}

function boot(sources: ModelSource[]): {
  app: FastifyInstance;
  cache: ModelCatalogCache;
} {
  const app = Fastify({ logger: false });
  const cache = new ModelCatalogCache();

  registerRoutes({
    app,
    registry: new SessionRegistry(silentLogger),
    logger: silentLogger,
    runtimeRoot: "/tmp/model-catalog-route-test",
    modelCatalog: { registry: new ModelSourceRegistry(sources), cache },
  });

  return { app, cache };
}

const zaiDraft = {
  adapter: "claude" as const,
  provider: {
    kind: "anthropic_compatible" as const,
    baseUrl: "https://api.z.ai/api/anthropic",
    authTokenEnv: "ZAI_API_KEY",
  },
};

describe("POST /model-catalog/resolve", () => {
  it("200 happy path: merges + dedupes sources and returns per-source status", async () => {
    const { app } = boot([
      fakeSource("acp_probe", [{ id: "glm-5.1", origins: ["acp_probe"] }]),
      fakeSource("curated", [
        { id: "glm-5.1", origins: ["curated"] },
        { id: "glm-5", origins: ["curated"] },
      ]),
    ]);

    const res = await app.inject({
      method: "POST",
      url: "/model-catalog/resolve",
      payload: zaiDraft,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();

    expect(body.models.map((m: ModelEntry) => m.id)).toEqual([
      "glm-5.1",
      "glm-5",
    ]);
    // glm-5.1 advertised by both → deduped, origins accumulate first-source-first.
    expect(body.models[0].origins).toEqual(["acp_probe", "curated"]);
    expect(
      body.sources.map(
        (s: { kind: string; status: string }) => `${s.kind}:${s.status}`,
      ),
    ).toEqual(["acp_probe:ok", "curated:ok"]);
    expect(typeof body.resolvedAt).toBe("string");
    expect(body.ttlSeconds).toBe(3600);

    await app.close();
  });

  it("409 PRECONDITION on an env:-prefixed secret in an env-ref field", async () => {
    const { app } = boot([fakeSource("curated", [])]);

    const res = await app.inject({
      method: "POST",
      url: "/model-catalog/resolve",
      payload: {
        adapter: "claude",
        provider: {
          kind: "anthropic_compatible",
          authTokenEnv: "env:ZAI_API_KEY",
        },
      },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("PRECONDITION");

    await app.close();
  });

  it("409 PRECONDITION on a malformed draft (unknown adapter)", async () => {
    const { app } = boot([fakeSource("curated", [])]);

    const res = await app.inject({
      method: "POST",
      url: "/model-catalog/resolve",
      payload: { adapter: "gemini", provider: { kind: "anthropic" } },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("PRECONDITION");

    await app.close();
  });

  it("409 PRECONDITION on router without sidecarId", async () => {
    const { app } = boot([fakeSource("curated", [])]);

    const res = await app.inject({
      method: "POST",
      url: "/model-catalog/resolve",
      payload: {
        adapter: "claude",
        provider: { kind: "anthropic" },
        router: "ccr",
      },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("PRECONDITION");

    await app.close();
  });

  it("a per-source failure surfaces as status:error INSIDE a 200 (never a 5xx)", async () => {
    const { app } = boot([
      fakeSource("acp_probe", [{ id: "glm-5.1", origins: ["acp_probe"] }]),
      fakeSource("ccr", [], { throwError: new Error("ccr unreachable") }),
    ]);

    const res = await app.inject({
      method: "POST",
      url: "/model-catalog/resolve",
      payload: zaiDraft,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();

    expect(body.models.map((m: ModelEntry) => m.id)).toEqual(["glm-5.1"]);
    const ccr = body.sources.find((s: { kind: string }) => s.kind === "ccr");

    expect(ccr.status).toBe("error");
    expect(ccr.reason).toContain("ccr unreachable");

    await app.close();
  });

  it("cache hit: a second identical resolve (no force) does NOT re-run sources", async () => {
    const onResolve = vi.fn();
    const { app } = boot([
      fakeSource("acp_probe", [{ id: "glm-5.1", origins: ["acp_probe"] }], {
        onResolve,
      }),
    ]);

    await app.inject({
      method: "POST",
      url: "/model-catalog/resolve",
      payload: zaiDraft,
    });
    await app.inject({
      method: "POST",
      url: "/model-catalog/resolve",
      payload: zaiDraft,
    });

    expect(onResolve).toHaveBeenCalledTimes(1);

    await app.close();
  });

  it("force:true bypasses the cache and re-runs sources", async () => {
    const onResolve = vi.fn();
    const { app } = boot([
      fakeSource("acp_probe", [{ id: "glm-5.1", origins: ["acp_probe"] }], {
        onResolve,
      }),
    ]);

    await app.inject({
      method: "POST",
      url: "/model-catalog/resolve",
      payload: zaiDraft,
    });
    await app.inject({
      method: "POST",
      url: "/model-catalog/resolve",
      payload: { ...zaiDraft, force: true },
    });

    expect(onResolve).toHaveBeenCalledTimes(2);

    await app.close();
  });
});
