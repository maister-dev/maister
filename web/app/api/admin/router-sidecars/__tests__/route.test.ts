import type { NextRequest } from "next/server";

import { getTableName } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { MaisterError } from "@/lib/errors";

const mocks = vi.hoisted(() => ({
  checkSupervisorDiagnostics: vi.fn(),
  requireGlobalRole: vi.fn(),
}));

type Row = Record<string, unknown>;
type Tables = {
  platform_acp_runners: Row[];
  platform_router_sidecars: Row[];
};

const state: {
  inserts: Array<{ tableName: string; values: Row }>;
  tables: Tables;
} = {
  inserts: [],
  tables: {
    platform_acp_runners: [],
    platform_router_sidecars: [],
  },
};

function tableOf(table: unknown): keyof Tables {
  const tableName = getTableName(table as never);

  if (tableName === "platform_acp_runners") return "platform_acp_runners";
  if (tableName === "platform_router_sidecars") {
    return "platform_router_sidecars";
  }
  throw new Error(`unknown table: ${tableName}`);
}

const fakeDb = {
  select: () => ({
    from: (table: unknown) => ({
      where: async () => state.tables[tableOf(table)],
      then: <TResult1 = Row[], TResult2 = never>(
        onfulfilled?:
          | ((value: Row[]) => TResult1 | PromiseLike<TResult1>)
          | null,
        onrejected?:
          | ((reason: unknown) => TResult2 | PromiseLike<TResult2>)
          | null,
      ) =>
        Promise.resolve(state.tables[tableOf(table)]).then(
          onfulfilled,
          onrejected,
        ),
    }),
  }),
  insert: (table: unknown) => ({
    values: async (values: Row) => {
      state.inserts.push({ tableName: getTableName(table as never), values });
    },
  }),
  update: (table: unknown) => ({
    set: (values: Row) => ({
      where: async () => {
        for (const row of state.tables[tableOf(table)]) {
          Object.assign(row, values);
        }
      },
    }),
  }),
};

vi.mock("@/lib/authz", () => ({
  requireGlobalRole: mocks.requireGlobalRole,
}));
vi.mock("@/lib/db/client", () => ({ getDb: () => fakeDb }));
vi.mock("@/lib/supervisor-client", () => ({
  checkSupervisorDiagnostics: mocks.checkSupervisorDiagnostics,
}));

function request(body: unknown): NextRequest {
  return new Request("http://x/api/admin/router-sidecars", {
    method: "POST",
    body: JSON.stringify(body),
  }) as NextRequest;
}

describe("admin router sidecar API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.inserts = [];
    state.tables.platform_acp_runners = [];
    state.tables.platform_router_sidecars = [];
    mocks.checkSupervisorDiagnostics.mockResolvedValue({
      kind: "unavailable",
      message: "supervisor is offline",
      reason: "connect_error",
    });
    mocks.requireGlobalRole.mockResolvedValue({ id: "admin", role: "admin" });
  });

  it("rejects raw token values and accepts only env refs", async () => {
    const { POST } = await import("../route");
    const res = await POST(
      request({
        id: "ccr-default",
        kind: "ccr",
        lifecycle: "managed",
        authTokenRef: "raw-token",
      }),
    );
    const body = (await res.json()) as { code?: string };

    expect(res.status).toBe(422);
    expect(body.code).toBe("CONFIG");
    expect(state.inserts).toEqual([]);
  });

  it("creates a typed CCR sidecar for admins", async () => {
    const { POST } = await import("../route");
    const res = await POST(
      request({
        id: "ccr-default",
        kind: "ccr",
        lifecycle: "managed",
        commandPreset: "ccr_start",
        authTokenRef: "env:MAISTER_CCR_AUTH_TOKEN",
      }),
    );

    expect(res.status).toBe(201);
    expect(state.inserts).toEqual([
      expect.objectContaining({
        tableName: "platform_router_sidecars",
        values: expect.objectContaining({
          authTokenRef: "env:MAISTER_CCR_AUTH_TOKEN",
          commandPreset: "ccr_start",
          id: "ccr-default",
        }),
      }),
    ]);
  });

  it("derives POST readiness from diagnostics instead of trusting the body", async () => {
    const { POST } = await import("../route");
    const res = await POST(
      request({
        id: "ccr-default",
        kind: "ccr",
        lifecycle: "managed",
        commandPreset: "ccr_start",
        configPath: "~/.claude-code-router/config.json",
        readinessStatus: "Ready",
        readinessReasons: [],
      }),
    );

    expect(res.status).toBe(201);
    expect(state.inserts[0]?.values).toMatchObject({
      readinessStatus: "NotReady",
      readinessReasons: expect.arrayContaining([
        "supervisor diagnostics unavailable: supervisor is offline",
      ]),
    });
  });

  it("stores Ready when diagnostics confirm a configured CCR sidecar", async () => {
    mocks.checkSupervisorDiagnostics.mockResolvedValue({
      kind: "ready",
      diagnostics: {
        status: "ready",
        version: "test",
        checkedAt: new Date().toISOString(),
        adapters: [],
        envRefs: [],
        sidecars: [{ id: "ccr-default", kind: "ccr", state: "ready" }],
      },
    });

    const { POST } = await import("../route");
    const res = await POST(
      request({
        id: "ccr-default",
        kind: "ccr",
        lifecycle: "managed",
        commandPreset: "ccr_start",
        configPath: "~/.claude-code-router/config.json",
      }),
    );

    expect(res.status).toBe(201);
    expect(state.inserts[0]?.values).toMatchObject({
      readinessStatus: "Ready",
      readinessReasons: [],
    });
  });

  it("derives PATCH readiness from the updated config and diagnostics", async () => {
    state.tables.platform_router_sidecars = [
      {
        id: "ccr-default",
        kind: "ccr",
        lifecycle: "managed",
        commandPreset: "ccr_start",
        configPath: "~/.claude-code-router/config.json",
        baseUrl: null,
        healthcheckUrl: null,
        authTokenRef: null,
        enabled: true,
        readinessStatus: "Ready",
        readinessReasons: [],
      },
    ];

    const { PATCH } = await import("../[sidecarId]/route");
    // The body carries only a config change; readiness is NOT a caller input —
    // the server recomputes it (NotReady here: a managed CCR needs a config path
    // and diagnostics are offline).
    const res = await PATCH(request({ configPath: null }), {
      params: Promise.resolve({ sidecarId: "ccr-default" }),
    });

    expect(res.status).toBe(200);
    expect(state.tables.platform_router_sidecars[0]).toMatchObject({
      configPath: null,
      readinessStatus: "NotReady",
      readinessReasons: expect.arrayContaining([
        "managed CCR sidecar requires config path",
        "supervisor diagnostics unavailable: supervisor is offline",
      ]),
    });
  });

  it("rejects a PATCH body carrying server-authoritative readiness fields (422)", async () => {
    state.tables.platform_router_sidecars = [{ id: "ccr-default" }];

    const { PATCH } = await import("../[sidecarId]/route");
    const res = await PATCH(request({ readinessStatus: "Ready" }), {
      params: Promise.resolve({ sidecarId: "ccr-default" }),
    });
    const body = (await res.json()) as { code?: string };

    expect(res.status).toBe(422);
    expect(body.code).toBe("CONFIG");
  });

  it("refuses to disable a sidecar referenced by ACP runners", async () => {
    state.tables.platform_router_sidecars = [{ id: "ccr-default" }];
    state.tables.platform_acp_runners = [
      { id: "claude-code-ccr", sidecarId: "ccr-default" },
    ];

    const { PATCH } = await import("../[sidecarId]/route");
    const res = await PATCH(request({ enabled: false }), {
      params: Promise.resolve({ sidecarId: "ccr-default" }),
    });
    const body = (await res.json()) as { code?: string };

    expect(res.status).toBe(409);
    expect(body.code).toBe("CONFLICT");
  });

  it("POST rejects a configPath with '..' traversal and writes nothing (ADR-094)", async () => {
    const { POST } = await import("../route");
    const res = await POST(
      request({
        id: "ccr-default",
        kind: "ccr",
        lifecycle: "managed",
        configPath: "../../etc/passwd",
      }),
    );
    const body = (await res.json()) as { code?: string };

    expect(res.status).toBe(422);
    expect(body.code).toBe("CONFIG");
    expect(state.inserts).toEqual([]);
  });

  it("PATCH rejects a configPath with '..' traversal and leaves the stored value unchanged (ADR-094)", async () => {
    state.tables.platform_router_sidecars = [
      {
        id: "ccr-default",
        kind: "ccr",
        lifecycle: "managed",
        commandPreset: "ccr_start",
        configPath: "~/.claude-code-router/config.json",
        enabled: true,
        readinessStatus: "Ready",
        readinessReasons: [],
      },
    ];

    const { PATCH } = await import("../[sidecarId]/route");
    const res = await PATCH(request({ configPath: "../../etc/passwd" }), {
      params: Promise.resolve({ sidecarId: "ccr-default" }),
    });
    const body = (await res.json()) as { code?: string };

    expect(res.status).toBe(422);
    expect(body.code).toBe("CONFIG");
    // The update boundary must reject traversal so a value the supervisor fs
    // sink would refuse can never be persisted (the gap Codex flagged).
    expect(state.tables.platform_router_sidecars[0].configPath).toBe(
      "~/.claude-code-router/config.json",
    );
  });

  it("POST runs the admin check before body validation (auth-first)", async () => {
    mocks.requireGlobalRole.mockRejectedValue(
      new MaisterError("UNAUTHORIZED", "requires admin"),
    );

    const { POST } = await import("../route");
    // A body that WOULD 422 (raw token, not an env ref) if it reached the schema.
    const res = await POST(request({ authTokenRef: "raw-token" }));
    const body = (await res.json()) as { code?: string };

    expect(res.status).toBe(403);
    expect(body.code).not.toBe("CONFIG");
    expect(state.inserts).toEqual([]);
  });

  it("PATCH runs the admin check before body validation (auth-first)", async () => {
    mocks.requireGlobalRole.mockRejectedValue(
      new MaisterError("UNAUTHORIZED", "requires admin"),
    );

    const { PATCH } = await import("../[sidecarId]/route");
    // A configPath traversal that WOULD 422 if it reached the schema.
    const res = await PATCH(request({ configPath: "../../etc/passwd" }), {
      params: Promise.resolve({ sidecarId: "ccr-default" }),
    });
    const body = (await res.json()) as { code?: string };

    expect(res.status).toBe(403);
    expect(body.code).not.toBe("CONFIG");
  });
});
