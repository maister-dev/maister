import type { CcrManager } from "../../ccr-manager";

import pino from "pino";
import { describe, expect, it, vi, type Mock } from "vitest";

import { type ModelCatalogDraft, type ResolveContext } from "../types";

import { createCcrSource } from "./ccr";

type MockCcr = CcrManager & {
  ensureRunning: Mock;
  getProxyUrl: Mock;
  getState: Mock;
  shutdown: Mock;
};

function makeCcr(over: Partial<MockCcr> = {}): MockCcr {
  return {
    ensureRunning: vi.fn(async () => undefined),
    getProxyUrl: vi.fn(() => "http://ccr-proxy.local:3456"),
    getState: vi.fn(() => "ready" as const),
    shutdown: vi.fn(async () => undefined),
    ...over,
  } as MockCcr;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const ctx: ResolveContext = { logger: pino({ level: "silent" }) };

function ccrDraft(over: Partial<ModelCatalogDraft> = {}): ModelCatalogDraft {
  return {
    adapter: "claude",
    provider: { kind: "anthropic_compatible", baseUrl: "https://x" },
    router: "ccr",
    sidecarId: "ccr-glm",
    ...over,
  } as ModelCatalogDraft;
}

describe("createCcrSource — supports", () => {
  it("supports only when draft.router === 'ccr'", () => {
    const source = createCcrSource(makeCcr());

    expect(source.kind).toBe("ccr");
    expect(source.supports(ccrDraft())).toBe(true);
    expect(
      source.supports({
        adapter: "claude",
        provider: { kind: "anthropic" },
      } as ModelCatalogDraft),
    ).toBe(false);
  });
});

describe("createCcrSource — resolve happy path", () => {
  it("flattens Providers[].models to '<provider>,<model>' route ids, origins ['ccr'], status ok", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        Providers: [
          { name: "zai", models: ["glm-5.1", "glm-5"] },
          { name: "openrouter", models: ["anthropic/claude-sonnet-4-6"] },
        ],
      }),
    ) as unknown as typeof fetch;

    const ccr = makeCcr();
    const source = createCcrSource(ccr, { fetchImpl });

    const { models, status } = await source.resolve(ccrDraft(), ctx);

    expect(models).toEqual([
      { id: "zai,glm-5.1", origins: ["ccr"] },
      { id: "zai,glm-5", origins: ["ccr"] },
      { id: "openrouter,anthropic/claude-sonnet-4-6", origins: ["ccr"] },
    ]);
    expect(status).toEqual({ kind: "ccr", status: "ok", count: 3 });

    expect(ccr.ensureRunning).toHaveBeenCalledWith({
      instance: { id: "ccr-glm" },
    });
    expect(ccr.getProxyUrl).toHaveBeenCalledWith("ccr-glm");
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://ccr-proxy.local:3456/api/config",
      expect.anything(),
    );
  });

  it("passes undefined instance + sidecarId when draft has no sidecarId", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ Providers: [{ name: "zai", models: ["glm-5"] }] }),
    ) as unknown as typeof fetch;

    const ccr = makeCcr();
    const source = createCcrSource(ccr, { fetchImpl });

    await source.resolve(ccrDraft({ sidecarId: undefined }), ctx);

    expect(ccr.ensureRunning).toHaveBeenCalledWith({ instance: undefined });
    expect(ccr.getProxyUrl).toHaveBeenCalledWith(undefined);
  });
});

describe("createCcrSource — resolve failures never throw", () => {
  it("ensureRunning rejects (CCR failed to start) → status error, no throw", async () => {
    const ccr = makeCcr({
      ensureRunning: vi.fn(async () => {
        throw new Error("CCR daemon failed to become ready within 10000ms");
      }),
    });
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const source = createCcrSource(ccr, { fetchImpl });

    const { models, status } = await source.resolve(ccrDraft(), ctx);

    expect(models).toEqual([]);
    expect(status.kind).toBe("ccr");
    expect(status.status).toBe("error");
    expect(status.reason).toContain("failed to become ready");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("fetch non-2xx (502) → status error, no throw", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("bad gateway", { status: 502 }),
    ) as unknown as typeof fetch;
    const source = createCcrSource(makeCcr(), { fetchImpl });

    const { models, status } = await source.resolve(ccrDraft(), ctx);

    expect(models).toEqual([]);
    expect(status.status).toBe("error");
    expect(status.reason).toContain("502");
  });

  it("malformed config (no Providers) → status error mentioning malformed, no throw", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ notProviders: [] }),
    ) as unknown as typeof fetch;
    const source = createCcrSource(makeCcr(), { fetchImpl });

    const { models, status } = await source.resolve(ccrDraft(), ctx);

    expect(models).toEqual([]);
    expect(status.status).toBe("error");
    expect(status.reason).toMatch(/malformed/i);
  });
});
