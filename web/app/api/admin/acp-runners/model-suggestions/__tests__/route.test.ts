import type { NextRequest } from "next/server";
import type {
  SupervisorModelCatalog,
  SupervisorModelCatalogDraft,
} from "@/lib/supervisor-client";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { MaisterError } from "@/lib/errors";

const mocks = vi.hoisted(() => ({
  requireGlobalRole: vi.fn(),
  resolveModelSuggestions: vi.fn(),
}));

vi.mock("@/lib/authz", () => ({
  requireGlobalRole: mocks.requireGlobalRole,
}));
vi.mock("@/lib/supervisor-client", () => ({
  resolveModelSuggestions: mocks.resolveModelSuggestions,
}));

function jsonRequest(body: unknown): NextRequest {
  return new Request("http://x/api/admin/acp-runners/model-suggestions", {
    method: "POST",
    body: JSON.stringify(body),
  }) as NextRequest;
}

const RESOLVED_AT = "2026-06-11T10:00:00.000Z";

function catalog(
  overrides: Partial<SupervisorModelCatalog> = {},
): SupervisorModelCatalog {
  return {
    models: [
      {
        id: "claude-sonnet-4-6",
        displayName: "Claude Sonnet 4.6",
        origins: ["acp_probe"],
      },
      { id: "glm-4.6", origins: ["curated"] },
    ],
    sources: [
      { kind: "acp_probe", status: "ok", count: 1 },
      { kind: "curated", status: "skipped", reason: "z.ai has no listing" },
    ],
    resolvedAt: RESOLVED_AT,
    ttlSeconds: 3600,
    ...overrides,
  };
}

describe("admin ACP runner model-suggestions proxy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireGlobalRole.mockResolvedValue({ id: "admin", role: "admin" });
    mocks.resolveModelSuggestions.mockResolvedValue(catalog());
  });

  it("rejects non-admin callers before touching the supervisor", async () => {
    mocks.requireGlobalRole.mockRejectedValue(
      new MaisterError("UNAUTHORIZED", "Requires global role: admin"),
    );

    const { POST } = await import("../route");
    const res = await POST(
      jsonRequest({ adapter: "claude", provider: { kind: "anthropic" } }),
    );
    const body = (await res.json()) as { code?: string };

    expect(res.status).toBe(403);
    expect(body.code).toBe("UNAUTHORIZED");
    expect(mocks.resolveModelSuggestions).not.toHaveBeenCalled();
  });

  it("returns suggestions grouped by primary origin with stable labels", async () => {
    const { POST } = await import("../route");
    const res = await POST(
      jsonRequest({ adapter: "claude", provider: { kind: "anthropic" } }),
    );
    const body = (await res.json()) as {
      groups: Array<{
        source: string;
        label: string;
        status: string;
        reason?: string;
        models: Array<{ id: string; displayName?: string }>;
      }>;
      resolvedAt: string;
      ttlSeconds: number;
    };

    expect(res.status).toBe(200);
    expect(body.resolvedAt).toBe(RESOLVED_AT);
    expect(body.ttlSeconds).toBe(3600);
    expect(body.groups).toEqual([
      {
        source: "acp_probe",
        label: "Agent",
        status: "ok",
        models: [{ id: "claude-sonnet-4-6", displayName: "Claude Sonnet 4.6" }],
      },
      {
        source: "curated",
        label: "Curated",
        status: "skipped",
        reason: "z.ai has no listing",
        models: [{ id: "glm-4.6" }],
      },
    ]);
  });

  it("rejects a raw (non-env:) secret in a provider field with CONFIG", async () => {
    const { POST } = await import("../route");
    const res = await POST(
      jsonRequest({
        adapter: "codex",
        provider: {
          kind: "openai_compatible",
          baseUrl: "https://api.z.ai/api/paas/v4",
          apiKey: "raw-token",
        },
      }),
    );
    const body = (await res.json()) as { code?: string };

    expect(res.status).toBe(422);
    expect(body.code).toBe("CONFIG");
    expect(mocks.resolveModelSuggestions).not.toHaveBeenCalled();
  });

  it("forwards bare env-ref names (env: prefix stripped) to the supervisor", async () => {
    const { POST } = await import("../route");
    const res = await POST(
      jsonRequest({
        adapter: "claude",
        provider: {
          kind: "anthropic_compatible",
          baseUrl: "https://api.z.ai/api/anthropic",
          authToken: "env:ZAI_API_KEY",
        },
        force: true,
      }),
    );

    expect(res.status).toBe(200);
    expect(mocks.resolveModelSuggestions).toHaveBeenCalledTimes(1);
    const [draft, opts] = mocks.resolveModelSuggestions.mock.calls[0] as [
      { adapter: string; provider: Record<string, unknown> },
      { force?: boolean },
    ];

    expect(draft.adapter).toBe("claude");
    expect(draft.provider).toEqual({
      kind: "anthropic_compatible",
      baseUrl: "https://api.z.ai/api/anthropic",
      authTokenEnv: "ZAI_API_KEY",
    });
    expect(opts.force).toBe(true);
  });

  it("forwards Gemini provider drafts with bare apiKeyEnv names", async () => {
    const { POST } = await import("../route");
    const res = await POST(
      jsonRequest({
        adapter: "gemini",
        provider: {
          kind: "google_gemini",
          apiKey: "env:GEMINI_API_KEY",
        },
      }),
    );

    expect(res.status).toBe(200);
    const [draft] = mocks.resolveModelSuggestions.mock.calls[0] as [
      SupervisorModelCatalogDraft,
    ];

    expect(draft).toMatchObject({
      adapter: "gemini",
      provider: { kind: "google_gemini", apiKeyEnv: "GEMINI_API_KEY" },
    });
  });

  it("forwards OpenCode native drafts without Claude/Codex provider defaults", async () => {
    const { POST } = await import("../route");
    const res = await POST(
      jsonRequest({
        adapter: "opencode",
        provider: { kind: "agent_native" },
      }),
    );

    expect(res.status).toBe(200);
    const [draft] = mocks.resolveModelSuggestions.mock.calls[0] as [
      SupervisorModelCatalogDraft,
    ];

    expect(draft).toEqual({
      adapter: "opencode",
      provider: { kind: "agent_native" },
    });
  });

  it("forwards MiMo native drafts without OpenCode aliasing", async () => {
    const { POST } = await import("../route");
    const res = await POST(
      jsonRequest({
        adapter: "mimo",
        provider: { kind: "agent_native" },
      }),
    );

    expect(res.status).toBe(200);
    const [draft] = mocks.resolveModelSuggestions.mock.calls[0] as [
      SupervisorModelCatalogDraft,
    ];

    expect(draft).toEqual({
      adapter: "mimo",
      provider: { kind: "agent_native" },
    });
  });

  it("maps a supervisor EXECUTOR_UNAVAILABLE to 503", async () => {
    mocks.resolveModelSuggestions.mockRejectedValue(
      new MaisterError("EXECUTOR_UNAVAILABLE", "resolveModelSuggestions: down"),
    );

    const { POST } = await import("../route");
    const res = await POST(
      jsonRequest({ adapter: "claude", provider: { kind: "anthropic" } }),
    );
    const body = (await res.json()) as { code?: string };

    expect(res.status).toBe(503);
    expect(body.code).toBe("EXECUTOR_UNAVAILABLE");
  });

  it("maps a stray supervisor PRECONDITION to 503", async () => {
    mocks.resolveModelSuggestions.mockRejectedValue(
      new MaisterError("PRECONDITION", "malformed draft"),
    );

    const { POST } = await import("../route");
    const res = await POST(
      jsonRequest({ adapter: "claude", provider: { kind: "anthropic" } }),
    );

    expect(res.status).toBe(503);
  });
});
