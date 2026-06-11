// T5.1 — model-catalog end-to-end resolve through POST /model-catalog/resolve
// with a REAL ModelSource registry: the ACP probe drives the mock adapter
// (test/fixtures/mock-acp-models.mjs), the curated source is static, the
// provider-API + CCR sources use a mocked fetch. Proves the sources compose,
// merge + dedupe by id (origins accumulate), per-source status is surfaced,
// the cache short-circuits a second resolve, force bypasses it, and a malformed
// draft maps to 409.
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import Fastify, { type FastifyInstance } from "fastify";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CcrManager } from "../ccr-manager";
import { registerRoutes } from "../http-api";
import { ModelCatalogCache } from "../model-catalog/cache";
import { ModelSourceRegistry } from "../model-catalog/registry";
import { createAcpProbeSource } from "../model-catalog/sources/acp-probe";
import { createCcrSource } from "../model-catalog/sources/ccr";
import { createCuratedSource } from "../model-catalog/sources/curated";
import { createProviderApiSource } from "../model-catalog/sources/provider-api";
import { SessionRegistry } from "../registry";

const here = dirname(fileURLToPath(import.meta.url));
const mockAdapter = resolve(here, "../../test/fixtures/mock-acp-models.mjs");
const silent = pino({ level: "silent" });

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

function bootWithRealSources(opts: {
  providerFetch: typeof fetch;
  ccrFetch: typeof fetch;
  ccrManager: CcrManager;
}): { app: FastifyInstance } {
  const registry = new ModelSourceRegistry([
    createAcpProbeSource({ binaryOverride: "node", preArgs: [mockAdapter] }),
    createCuratedSource(),
    createProviderApiSource({ fetchImpl: opts.providerFetch }),
    createCcrSource(opts.ccrManager, { fetchImpl: opts.ccrFetch }),
  ]);
  const app = Fastify({ logger: false });

  registerRoutes({
    app,
    registry: new SessionRegistry(silent),
    logger: silent,
    runtimeRoot: "/tmp/model-catalog-e2e",
    modelCatalog: { registry, cache: new ModelCatalogCache() },
  });

  return { app };
}

beforeEach(() => {
  vi.stubEnv("MOCK_ACP_MODELS_MODE", "ok");
  vi.stubEnv("ZAI_API_KEY", "zai-secret");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("model-catalog end-to-end resolve", () => {
  it("merges probe + curated + provider sources, dedupes by id, accumulates origins", async () => {
    const providerFetch = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { data: [{ id: "glm-5.1" }] }));
    const ccrManager = {} as unknown as CcrManager;
    const { app } = bootWithRealSources({
      providerFetch,
      ccrFetch: vi.fn(),
      ccrManager,
    });

    const res = await app.inject({
      method: "POST",
      url: "/model-catalog/resolve",
      payload: {
        adapter: "claude",
        provider: {
          kind: "anthropic_compatible",
          baseUrl: "https://api.z.ai/api/anthropic",
          authTokenEnv: "ZAI_API_KEY",
        },
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    const ids: string[] = body.models.map((m: { id: string }) => m.id);

    // curated GLM list is present; probe + provider also advertise glm-5.1.
    expect(ids).toContain("glm-5.1");
    expect(ids).toContain("glm-4.7");
    const glm51 = body.models.find((m: { id: string }) => m.id === "glm-5.1");

    // glm-5.1 came from the probe (first source) + curated + provider_api.
    expect(glm51.origins).toEqual(
      expect.arrayContaining(["acp_probe", "curated", "provider_api"]),
    );
    // ccr does not support a non-ccr draft → not in the source list.
    const kinds = body.sources.map((s: { kind: string }) => s.kind);

    expect(kinds).toEqual(
      expect.arrayContaining(["acp_probe", "curated", "provider_api"]),
    );
    expect(kinds).not.toContain("ccr");
    expect(
      body.sources.every((s: { status: string }) => s.status === "ok"),
    ).toBe(true);

    await app.close();
  });

  it("a CCR-routed draft resolves only the CCR source via the proxy config", async () => {
    const ccrFetch = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        Providers: [{ name: "zai", models: ["glm-5.1", "glm-5"] }],
      }),
    );
    const ccrManager = {
      ensureRunning: vi.fn().mockResolvedValue(undefined),
      getProxyUrl: vi.fn().mockReturnValue("http://ccr.local:3456"),
    } as unknown as CcrManager;
    const { app } = bootWithRealSources({
      providerFetch: vi.fn(),
      ccrFetch,
      ccrManager,
    });

    const res = await app.inject({
      method: "POST",
      url: "/model-catalog/resolve",
      payload: {
        adapter: "claude",
        provider: { kind: "anthropic_compatible" },
        router: "ccr",
        sidecarId: "ccr-default",
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();

    expect(body.models.map((m: { id: string }) => m.id)).toEqual([
      "zai,glm-5.1",
      "zai,glm-5",
    ]);
    expect(body.sources.map((s: { kind: string }) => s.kind)).toContain("ccr");

    await app.close();
  });

  it("caches within TTL (second resolve does not re-probe) and force bypasses it", async () => {
    const providerFetch = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { data: [] }));
    const { app } = bootWithRealSources({
      providerFetch,
      ccrFetch: vi.fn(),
      ccrManager: {} as unknown as CcrManager,
    });
    const draft = {
      adapter: "claude",
      provider: {
        kind: "anthropic_compatible",
        baseUrl: "https://api.z.ai/api/anthropic",
        authTokenEnv: "ZAI_API_KEY",
      },
    };

    await app.inject({ method: "POST", url: "/model-catalog/resolve", payload: draft });
    expect(providerFetch).toHaveBeenCalledTimes(1);

    // cache hit — no new source calls.
    await app.inject({ method: "POST", url: "/model-catalog/resolve", payload: draft });
    expect(providerFetch).toHaveBeenCalledTimes(1);

    // force bypasses the cache.
    await app.inject({
      method: "POST",
      url: "/model-catalog/resolve",
      payload: { ...draft, force: true },
    });
    expect(providerFetch).toHaveBeenCalledTimes(2);

    await app.close();
  });

  it("malformed draft (env:-prefixed secret) → 409 PRECONDITION", async () => {
    const { app } = bootWithRealSources({
      providerFetch: vi.fn(),
      ccrFetch: vi.fn(),
      ccrManager: {} as unknown as CcrManager,
    });

    const res = await app.inject({
      method: "POST",
      url: "/model-catalog/resolve",
      payload: {
        adapter: "claude",
        provider: { kind: "anthropic_compatible", authTokenEnv: "env:ZAI_API_KEY" },
      },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("PRECONDITION");

    await app.close();
  });
});
