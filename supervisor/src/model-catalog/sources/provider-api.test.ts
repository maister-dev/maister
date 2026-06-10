import type { ModelCatalogDraft, ResolveContext } from "../types";

import pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createProviderApiSource } from "./provider-api";

const ctx: ResolveContext = { logger: pino({ level: "silent" }) };

function draftWith(provider: ModelCatalogDraft["provider"]): ModelCatalogDraft {
  return { adapter: "claude", provider };
}

type FakeResponse = {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
};

function jsonResponse(status: number, body: unknown): FakeResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

function fetchReturning(response: FakeResponse): typeof fetch {
  return vi.fn(async () => response) as unknown as typeof fetch;
}

describe("createProviderApiSource", () => {
  beforeEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.ZAI_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("declares kind 'provider_api'", () => {
    expect(createProviderApiSource().kind).toBe("provider_api");
  });

  it("supports anthropic, openai, openai_compatible, AND anthropic_compatible", () => {
    const source = createProviderApiSource();

    expect(source.supports(draftWith({ kind: "anthropic" }))).toBe(true);
    expect(source.supports(draftWith({ kind: "openai" }))).toBe(true);
    expect(source.supports(draftWith({ kind: "openai_compatible" }))).toBe(
      true,
    );
    expect(source.supports(draftWith({ kind: "anthropic_compatible" }))).toBe(
      true,
    );
  });

  describe("anthropic", () => {
    it("maps data[].id with ANTHROPIC_API_KEY present", async () => {
      vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-secret");
      const fetchImpl = fetchReturning(
        jsonResponse(200, { data: [{ id: "claude-sonnet-4-6" }] }),
      );
      const source = createProviderApiSource({ fetchImpl });

      const { models, status } = await source.resolve(
        draftWith({ kind: "anthropic" }),
        ctx,
      );

      expect(status.status).toBe("ok");
      expect(models).toEqual([
        { id: "claude-sonnet-4-6", origins: ["provider_api"] },
      ]);
      const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>)
        .mock.calls[0];

      expect(url).toBe("https://api.anthropic.com/v1/models");
      expect((init as RequestInit).headers).toMatchObject({
        "x-api-key": "sk-ant-secret",
        "anthropic-version": "2023-06-01",
      });
    });

    it("skips when ANTHROPIC_API_KEY is absent (no fetch call)", async () => {
      const fetchImpl = fetchReturning(jsonResponse(200, { data: [] }));
      const source = createProviderApiSource({ fetchImpl });

      const { models, status } = await source.resolve(
        draftWith({ kind: "anthropic" }),
        ctx,
      );

      expect(models).toEqual([]);
      expect(status.status).toBe("skipped");
      expect(status.reason).toBeTruthy();
      expect(fetchImpl).not.toHaveBeenCalled();
    });
  });

  describe("anthropic_compatible", () => {
    it("performs an authed GET and tags returned models provider_api", async () => {
      vi.stubEnv("ZAI_API_KEY", "zai-secret-value");
      const fetchImpl = fetchReturning(
        jsonResponse(200, { data: [{ id: "glm-5.1" }] }),
      );
      const source = createProviderApiSource({ fetchImpl });

      const { models, status } = await source.resolve(
        draftWith({
          kind: "anthropic_compatible",
          baseUrl: "https://api.z.ai/api/anthropic",
          authTokenEnv: "ZAI_API_KEY",
        }),
        ctx,
      );

      expect(status.status).toBe("ok");
      expect(models).toEqual([{ id: "glm-5.1", origins: ["provider_api"] }]);
      const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>)
        .mock.calls[0];

      expect(String(url)).toBe("https://api.z.ai/api/anthropic/v1/models");
      expect((init as RequestInit).headers).toMatchObject({
        "x-api-key": "zai-secret-value",
      });
    });

    it("returns error/skipped status (no throw) on 401; curated carries the truth", async () => {
      vi.stubEnv("ZAI_API_KEY", "zai-secret-value");
      const fetchImpl = fetchReturning(jsonResponse(401, { error: "nope" }));
      const source = createProviderApiSource({ fetchImpl });

      const { models, status } = await source.resolve(
        draftWith({
          kind: "anthropic_compatible",
          baseUrl: "https://api.z.ai/api/anthropic",
          authTokenEnv: "ZAI_API_KEY",
        }),
        ctx,
      );

      expect(models).toEqual([]);
      expect(["error", "skipped"]).toContain(status.status);
      expect(status.reason).toBeTruthy();
    });

    it("returns a status with reason when authTokenEnv is missing", async () => {
      const fetchImpl = fetchReturning(jsonResponse(200, { data: [] }));
      const source = createProviderApiSource({ fetchImpl });

      const { models, status } = await source.resolve(
        draftWith({
          kind: "anthropic_compatible",
          baseUrl: "https://api.z.ai/api/anthropic",
        }),
        ctx,
      );

      expect(models).toEqual([]);
      expect(["error", "skipped"]).toContain(status.status);
      expect(status.reason).toBeTruthy();
    });

    it("does not throw when the env-ref name is set but absent from the environment", async () => {
      const fetchImpl = fetchReturning(jsonResponse(200, { data: [] }));
      const source = createProviderApiSource({ fetchImpl });

      const result = await source.resolve(
        draftWith({
          kind: "anthropic_compatible",
          baseUrl: "https://api.z.ai/api/anthropic",
          authTokenEnv: "ZAI_API_KEY",
        }),
        ctx,
      );

      expect(["error", "skipped"]).toContain(result.status.status);
      expect(result.status.reason).toBeTruthy();
      expect(fetchImpl).not.toHaveBeenCalled();
    });
  });

  describe("openai", () => {
    it("maps data[].id when OPENAI_API_KEY is present", async () => {
      vi.stubEnv("OPENAI_API_KEY", "sk-openai-secret");
      const fetchImpl = fetchReturning(
        jsonResponse(200, { data: [{ id: "gpt-5" }, { id: "gpt-5-mini" }] }),
      );
      const source = createProviderApiSource({ fetchImpl });

      const { models, status } = await source.resolve(
        draftWith({ kind: "openai" }),
        ctx,
      );

      expect(status.status).toBe("ok");
      expect(models).toEqual([
        { id: "gpt-5", origins: ["provider_api"] },
        { id: "gpt-5-mini", origins: ["provider_api"] },
      ]);
      const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>)
        .mock.calls[0];

      expect(url).toBe("https://api.openai.com/v1/models");
      expect((init as RequestInit).headers).toMatchObject({
        Authorization: "Bearer sk-openai-secret",
      });
    });

    it("skips when OPENAI_API_KEY is absent", async () => {
      const fetchImpl = fetchReturning(jsonResponse(200, { data: [] }));
      const source = createProviderApiSource({ fetchImpl });

      const { models, status } = await source.resolve(
        draftWith({ kind: "openai" }),
        ctx,
      );

      expect(models).toEqual([]);
      expect(status.status).toBe("skipped");
      expect(fetchImpl).not.toHaveBeenCalled();
    });
  });

  describe("openai_compatible", () => {
    it("attempts an unauthenticated GET against OpenRouter when no apiKeyEnv is set", async () => {
      const fetchImpl = fetchReturning(
        jsonResponse(200, { data: [{ id: "anthropic/claude-3.5" }] }),
      );
      const source = createProviderApiSource({ fetchImpl });

      const { models, status } = await source.resolve(
        draftWith({
          kind: "openai_compatible",
          baseUrl: "https://openrouter.ai/api/v1",
        }),
        ctx,
      );

      expect(status.status).toBe("ok");
      expect(models).toEqual([
        { id: "anthropic/claude-3.5", origins: ["provider_api"] },
      ]);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>)
        .mock.calls[0];

      expect(url).toBe("https://openrouter.ai/api/v1/models");
      const headers = ((init as RequestInit).headers ?? {}) as Record<
        string,
        string
      >;

      expect(headers.Authorization).toBeUndefined();
    });

    it("sends a bearer token when apiKeyEnv resolves", async () => {
      vi.stubEnv("OPENROUTER_API_KEY", "or-secret");
      const fetchImpl = fetchReturning(
        jsonResponse(200, { data: [{ id: "x/y" }] }),
      );
      const source = createProviderApiSource({ fetchImpl });

      await source.resolve(
        draftWith({
          kind: "openai_compatible",
          baseUrl: "https://openrouter.ai/api/v1",
          apiKeyEnv: "OPENROUTER_API_KEY",
        }),
        ctx,
      );

      const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock
        .calls[0];

      expect((init as RequestInit).headers).toMatchObject({
        Authorization: "Bearer or-secret",
      });
    });

    it("skips a non-public host with neither baseUrl nor apiKeyEnv", async () => {
      const fetchImpl = fetchReturning(jsonResponse(200, { data: [] }));
      const source = createProviderApiSource({ fetchImpl });

      const { models, status } = await source.resolve(
        draftWith({ kind: "openai_compatible" }),
        ctx,
      );

      expect(models).toEqual([]);
      expect(status.status).toBe("skipped");
      expect(fetchImpl).not.toHaveBeenCalled();
    });
  });

  describe("malformed responses", () => {
    it("returns error status mentioning malformed when data is missing (no throw)", async () => {
      vi.stubEnv("OPENAI_API_KEY", "sk-openai-secret");
      const fetchImpl = fetchReturning(jsonResponse(200, { nope: true }));
      const source = createProviderApiSource({ fetchImpl });

      const { models, status } = await source.resolve(
        draftWith({ kind: "openai" }),
        ctx,
      );

      expect(models).toEqual([]);
      expect(status.status).toBe("error");
      expect(status.reason).toMatch(/malformed/i);
    });

    it("returns error status (no throw) when json() rejects", async () => {
      vi.stubEnv("OPENAI_API_KEY", "sk-openai-secret");
      const fetchImpl = vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError("Unexpected token < in JSON");
        },
      })) as unknown as typeof fetch;
      const source = createProviderApiSource({ fetchImpl });

      const { models, status } = await source.resolve(
        draftWith({ kind: "openai" }),
        ctx,
      );

      expect(models).toEqual([]);
      expect(status.status).toBe("error");
      expect(status.reason).toBeTruthy();
    });

    it("returns error status (no throw) when fetch rejects with a network error", async () => {
      vi.stubEnv("OPENAI_API_KEY", "sk-openai-secret");
      const fetchImpl = vi.fn(async () => {
        throw new TypeError("fetch failed");
      }) as unknown as typeof fetch;
      const source = createProviderApiSource({ fetchImpl });

      const { models, status } = await source.resolve(
        draftWith({ kind: "openai" }),
        ctx,
      );

      expect(models).toEqual([]);
      expect(["error", "skipped"]).toContain(status.status);
      expect(status.reason).toBeTruthy();
    });
  });

  it("never leaks a secret value into status.reason on any failure path", async () => {
    const SECRET = "TOP-SECRET-TOKEN-9f3a";

    vi.stubEnv("ZAI_API_KEY", SECRET);
    const fetchImpl = fetchReturning(
      jsonResponse(403, { error: "forbidden", token: SECRET }),
    );
    const source = createProviderApiSource({ fetchImpl });

    const result = await source.resolve(
      draftWith({
        kind: "anthropic_compatible",
        baseUrl: "https://api.z.ai/api/anthropic",
        authTokenEnv: "ZAI_API_KEY",
      }),
      ctx,
    );

    expect(JSON.stringify(result)).not.toContain(SECRET);
  });
});
