import type { NextRequest } from "next/server";

import { getTableName } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { MaisterError } from "@/lib/errors";

const mocks = vi.hoisted(() => ({
  checkSupervisorDiagnostics: vi.fn(),
  requireGlobalRole: vi.fn(),
}));

type FakeQuery = {
  where: () => Promise<Record<string, unknown>[]>;
  then: PromiseLike<Record<string, unknown>[]>["then"];
};

const state: {
  runners: Record<string, unknown>[];
  sidecars: Record<string, unknown>[];
  settings: Record<string, unknown>[];
  inserts: Array<{ tableName: string; values: unknown }>;
  updates: Array<{ tableName: string; values: unknown }>;
} = {
  runners: [],
  sidecars: [],
  settings: [],
  inserts: [],
  updates: [],
};

function rowsForTable(table: unknown): Record<string, unknown>[] {
  const tableName = getTableName(table as never);

  if (tableName === "platform_acp_runners") return state.runners;
  if (tableName === "platform_router_sidecars") return state.sidecars;
  if (tableName === "platform_runtime_settings") return state.settings;

  return [];
}

function queryFor(table: unknown): FakeQuery {
  const nextRows = async () => rowsForTable(table);

  return {
    where: nextRows,
    then: <TResult1 = Record<string, unknown>[], TResult2 = never>(
      onfulfilled?:
        | ((
            value: Record<string, unknown>[],
          ) => TResult1 | PromiseLike<TResult1>)
        | null,
      onrejected?:
        | ((reason: unknown) => TResult2 | PromiseLike<TResult2>)
        | null,
    ) => nextRows().then(onfulfilled, onrejected),
  };
}

const fakeDb = {
  select: () => ({
    from: (table: unknown) => queryFor(table),
  }),
  insert: (table: unknown) => ({
    values: (values: unknown) => {
      const tableName = getTableName(table as never);

      state.inserts.push({ tableName, values });

      return {
        onConflictDoUpdate: async () => undefined,
      };
    },
  }),
  update: (table: unknown) => ({
    set: (values: unknown) => {
      const tableName = getTableName(table as never);

      state.updates.push({ tableName, values });

      return {
        where: async () => undefined,
      };
    },
  }),
};

vi.mock("@/lib/authz", () => ({
  requireGlobalRole: mocks.requireGlobalRole,
}));
vi.mock("@/lib/db/client", () => ({ getDb: () => fakeDb }));
vi.mock("@/lib/supervisor-client", () => ({
  checkSupervisorDiagnostics: mocks.checkSupervisorDiagnostics,
}));

function jsonRequest(body: unknown): NextRequest {
  return new Request("http://x/api/admin/acp-runners", {
    method: "POST",
    body: JSON.stringify(body),
  }) as NextRequest;
}

describe("admin ACP runner API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.runners = [
      {
        id: "claude-code",
        adapter: "claude",
        capabilityAgent: "claude",
        model: "claude-sonnet-4-6",
        provider: { kind: "anthropic" },
        permissionPolicy: "default",
        readinessStatus: "Ready",
        readinessReasons: [],
        enabled: true,
      },
    ];
    state.sidecars = [];
    state.settings = [{ id: "singleton", defaultRunnerId: "claude-code" }];
    state.inserts = [];
    state.updates = [];
    mocks.checkSupervisorDiagnostics.mockResolvedValue({
      kind: "ready",
      diagnostics: {
        status: "ready",
        version: "test",
        checkedAt: new Date().toISOString(),
        adapters: [
          { id: "claude", binary: "claude-agent-acp", available: true },
          { id: "codex", binary: "codex-acp", available: true },
        ],
        envRefs: [{ name: "ZAI_API_KEY", present: false }],
        sidecars: [{ id: "ccr-default", kind: "ccr", state: "ready" }],
      },
    });
    mocks.requireGlobalRole.mockResolvedValue({ id: "admin", role: "admin" });
  });

  it("lists platform runners for admins", async () => {
    const { GET } = await import("../route");
    const res = await GET();
    const body = (await res.json()) as {
      defaultRunnerId: string;
      presets: Array<{ id: string; readinessStatus: string }>;
      runners: Array<{ id: string }>;
    };

    expect(res.status).toBe(200);
    expect(mocks.requireGlobalRole).toHaveBeenCalledWith("admin");
    expect(body.defaultRunnerId).toBe("claude-code");
    expect(body.presets.map((preset) => preset.id)).toContain(
      "claude-code-dangerous",
    );
    expect(
      body.presets.find((preset) => preset.id === "codex-zai-glm")
        ?.readinessStatus,
    ).toBe("NotReady");
    expect(body.runners.map((runner) => runner.id)).toEqual(["claude-code"]);
  });

  it("rejects non-admin callers before exposing runner catalog", async () => {
    mocks.requireGlobalRole.mockRejectedValue(
      new MaisterError("UNAUTHORIZED", "Requires global role: admin"),
    );

    const { GET } = await import("../route");
    const res = await GET();
    const body = (await res.json()) as { code?: string };

    expect(res.status).toBe(403);
    expect(body.code).toBe("UNAUTHORIZED");
  });

  it("rejects raw provider tokens and accepts env secret refs only", async () => {
    const { POST } = await import("../route");
    const res = await POST(
      jsonRequest({
        id: "codex-zai",
        adapter: "codex",
        model: "glm-5.1",
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
    expect(state.inserts).toEqual([]);
  });

  it("derives readiness instead of trusting caller-provided Ready status", async () => {
    const { POST } = await import("../route");
    const res = await POST(
      jsonRequest({
        id: "codex-zai",
        adapter: "codex",
        model: "glm-5.1",
        provider: {
          kind: "openai_compatible",
          apiKey: "env:ZAI_API_KEY",
          baseUrl: "https://api.z.ai/api/paas/v4",
          wireApi: "responses",
        },
        readinessStatus: "Ready",
      }),
    );

    expect(res.status).toBe(201);
    expect(state.inserts).toEqual([
      expect.objectContaining({
        tableName: "platform_acp_runners",
        values: expect.objectContaining({
          readinessStatus: "NotReady",
          readinessReasons: expect.arrayContaining([
            "Codex OpenAI-compatible provider materialization is not verified",
          ]),
        }),
      }),
    ]);
  });

  it("stores Anthropic-compatible env refs without raw secret values", async () => {
    const { POST } = await import("../route");
    const res = await POST(
      jsonRequest({
        id: "claude-zai-env",
        adapter: "claude",
        model: "glm-5.1",
        provider: {
          kind: "anthropic_compatible",
          authToken: "env:ZAI_API_KEY",
          baseUrl: "https://api.z.ai/api/anthropic",
        },
      }),
    );

    expect(res.status).toBe(201);
    expect(state.inserts).toEqual([
      expect.objectContaining({
        tableName: "platform_acp_runners",
        values: expect.objectContaining({
          provider: expect.objectContaining({
            authToken: "env:ZAI_API_KEY",
          }),
          readinessStatus: "NotReady",
          readinessReasons: expect.arrayContaining([
            "env ref is missing: ZAI_API_KEY",
          ]),
        }),
      }),
    ]);
  });

  it("updates the platform default runner only when the runner exists", async () => {
    const { PATCH } = await import("../route");
    const res = await PATCH(jsonRequest({ defaultRunnerId: "claude-code" }));

    expect(res.status).toBe(200);
    expect(state.inserts).toEqual([
      expect.objectContaining({
        tableName: "platform_runtime_settings",
        values: { id: "singleton", defaultRunnerId: "claude-code" },
      }),
    ]);
  });

  it("rejects not-ready platform default runners", async () => {
    state.runners = [
      { id: "codex-zai-glm", enabled: true, readinessStatus: "NotReady" },
    ];

    const { PATCH } = await import("../route");
    const res = await PATCH(jsonRequest({ defaultRunnerId: "codex-zai-glm" }));
    const body = (await res.json()) as { code?: string };

    expect(res.status).toBe(409);
    expect(body.code).toBe("PRECONDITION");
    expect(state.inserts).toEqual([]);
  });

  it("derives readiness on runner PATCH instead of trusting caller-provided Ready status", async () => {
    const { PATCH } = await import("../[runnerId]/route");
    const res = await PATCH(
      jsonRequest({
        provider: {
          kind: "anthropic_compatible",
          authToken: "env:ZAI_API_KEY",
          baseUrl: "https://api.z.ai/api/anthropic",
        },
        readinessStatus: "Ready",
      }),
      { params: Promise.resolve({ runnerId: "claude-code" }) },
    );

    expect(res.status).toBe(200);
    expect(state.updates).toEqual([
      expect.objectContaining({
        tableName: "platform_acp_runners",
        values: expect.objectContaining({
          provider: expect.objectContaining({
            kind: "anthropic_compatible",
          }),
          readinessStatus: "NotReady",
          readinessReasons: expect.arrayContaining([
            "env ref is missing: ZAI_API_KEY",
          ]),
        }),
      }),
    ]);
  });

  it("rejects unsupported provider updates on runner PATCH", async () => {
    const { PATCH } = await import("../[runnerId]/route");
    const res = await PATCH(
      jsonRequest({
        provider: {
          kind: "openai_compatible",
          apiKey: "env:ZAI_API_KEY",
          baseUrl: "https://api.z.ai/api/paas/v4",
          wireApi: "responses",
        },
      }),
      { params: Promise.resolve({ runnerId: "claude-code" }) },
    );
    const body = (await res.json()) as { code?: string };

    expect(res.status).toBe(422);
    expect(body.code).toBe("CONFIG");
    expect(state.updates).toEqual([]);
  });

  it("rejects disabling the current platform default runner", async () => {
    const { PATCH } = await import("../[runnerId]/route");
    const res = await PATCH(jsonRequest({ enabled: false }), {
      params: Promise.resolve({ runnerId: "claude-code" }),
    });
    const body = (await res.json()) as { code?: string };

    expect(res.status).toBe(409);
    expect(body.code).toBe("CONFLICT");
    expect(state.updates).toEqual([]);
  });
});
