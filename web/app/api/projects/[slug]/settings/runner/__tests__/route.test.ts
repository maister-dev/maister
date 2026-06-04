import type { NextRequest } from "next/server";

import { getTableName } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { MaisterError } from "@/lib/errors";

const mocks = vi.hoisted(() => ({
  requireActiveSession: vi.fn(),
  requireProjectAction: vi.fn(),
}));

type Row = Record<string, unknown>;
type Tables = {
  platform_acp_runners: Row[];
  projects: Row[];
};

const state: { tables: Tables } = {
  tables: {
    platform_acp_runners: [],
    projects: [],
  },
};

function tableOf(table: unknown): keyof Tables {
  const tableName = getTableName(table as never);

  if (tableName === "platform_acp_runners") return "platform_acp_runners";
  if (tableName === "projects") return "projects";
  throw new Error(`unknown table: ${tableName}`);
}

function selectRows(table: unknown): Row[] {
  return state.tables[tableOf(table)];
}

const fakeDb = {
  select: () => ({
    from: (table: unknown) => ({
      where: async () => selectRows(table),
    }),
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
  requireActiveSession: mocks.requireActiveSession,
  requireProjectAction: mocks.requireProjectAction,
}));
vi.mock("@/lib/db/client", () => ({ getDb: () => fakeDb }));

function request(body: unknown): NextRequest {
  return new Request("http://x/api/projects/demo/settings/runner", {
    method: "PATCH",
    body: JSON.stringify(body),
  }) as NextRequest;
}

async function invoke(body: unknown) {
  const { PATCH } = await import("../route");

  return PATCH(request(body), { params: Promise.resolve({ slug: "demo" }) });
}

describe("project runner settings API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.tables.projects = [
      {
        id: "project-1",
        slug: "demo",
        defaultRunnerId: null,
        archivedAt: null,
      },
    ];
    state.tables.platform_acp_runners = [
      { id: "claude-code", enabled: true, readinessStatus: "Ready" },
      { id: "codex-disabled", enabled: false, readinessStatus: "Ready" },
      { id: "codex-not-ready", enabled: true, readinessStatus: "NotReady" },
    ];
    mocks.requireActiveSession.mockResolvedValue({ id: "user-1" });
    mocks.requireProjectAction.mockResolvedValue({ role: "admin" });
  });

  it("sets an explicit project default runner after project-scoped authz", async () => {
    const res = await invoke({ runnerId: "claude-code" });

    expect(res.status).toBe(200);
    expect(mocks.requireProjectAction).toHaveBeenCalledWith(
      "project-1",
      "editSettings",
    );
    expect(state.tables.projects[0].defaultRunnerId).toBe("claude-code");
  });

  it("clears the project default runner to inherit platform default", async () => {
    state.tables.projects[0].defaultRunnerId = "claude-code";

    const res = await invoke({ runnerId: null });

    expect(res.status).toBe(200);
    expect(state.tables.projects[0].defaultRunnerId).toBeNull();
  });

  it("rejects unknown platform runner refs", async () => {
    state.tables.platform_acp_runners = [];

    const res = await invoke({ runnerId: "missing-runner" });
    const body = (await res.json()) as { code?: string };

    expect(res.status).toBe(409);
    expect(body.code).toBe("PRECONDITION");
    expect(state.tables.projects[0].defaultRunnerId).toBeNull();
  });

  it("rejects disabled platform runner refs", async () => {
    state.tables.platform_acp_runners = [
      { id: "codex-disabled", enabled: false, readinessStatus: "Ready" },
    ];

    const res = await invoke({ runnerId: "codex-disabled" });
    const body = (await res.json()) as { code?: string };

    expect(res.status).toBe(409);
    expect(body.code).toBe("PRECONDITION");
    expect(state.tables.projects[0].defaultRunnerId).toBeNull();
  });

  it("rejects not-ready platform runner refs", async () => {
    state.tables.platform_acp_runners = [
      { id: "codex-not-ready", enabled: true, readinessStatus: "NotReady" },
    ];

    const res = await invoke({ runnerId: "codex-not-ready" });
    const body = (await res.json()) as { code?: string };

    expect(res.status).toBe(409);
    expect(body.code).toBe("PRECONDITION");
    expect(state.tables.projects[0].defaultRunnerId).toBeNull();
  });

  it("rejects callers without project settings authority", async () => {
    mocks.requireProjectAction.mockRejectedValueOnce(
      new MaisterError("UNAUTHORIZED", "Requires project settings access"),
    );

    const res = await invoke({ runnerId: "claude-code" });
    const body = (await res.json()) as { code?: string };

    expect(res.status).toBe(403);
    expect(body.code).toBe("UNAUTHORIZED");
    expect(mocks.requireProjectAction).toHaveBeenCalledWith(
      "project-1",
      "editSettings",
    );
    expect(state.tables.projects[0].defaultRunnerId).toBeNull();
  });
});
