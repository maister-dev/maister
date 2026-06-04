import type { NextRequest } from "next/server";

import { getTableName } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { MaisterError } from "@/lib/errors";

const mocks = vi.hoisted(() => ({
  requireActiveSession: vi.fn(),
  requireProjectAction: vi.fn(),
}));

type Row = Record<string, unknown>;
type TableName =
  | "flow_runner_remaps"
  | "flows"
  | "platform_acp_runners"
  | "projects";

const state: {
  remapSelectCalls: number;
  tables: Record<TableName, Row[]>;
} = {
  remapSelectCalls: 0,
  tables: {
    flow_runner_remaps: [],
    flows: [],
    platform_acp_runners: [],
    projects: [],
  },
};

function tableNameOf(table: unknown): TableName {
  const tableName = getTableName(table as never);

  if (
    tableName === "flow_runner_remaps" ||
    tableName === "flows" ||
    tableName === "platform_acp_runners" ||
    tableName === "projects"
  ) {
    return tableName;
  }

  throw new Error(`unknown table: ${tableName}`);
}

function selectRows(table: unknown): Row[] {
  const tableName = tableNameOf(table);

  if (tableName !== "flow_runner_remaps") return state.tables[tableName];

  state.remapSelectCalls += 1;

  if (state.remapSelectCalls === 2) {
    return state.tables.flow_runner_remaps.filter(
      (row) => row.status === "Pending",
    );
  }

  return state.tables.flow_runner_remaps;
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
        for (const row of state.tables[tableNameOf(table)]) {
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
  return new Request("http://x/api/projects/demo/flow-runner-remaps", {
    method: "PATCH",
    body: JSON.stringify(body),
  }) as NextRequest;
}

async function patch(body: unknown) {
  const { PATCH } = await import("../route");

  return PATCH(request(body), { params: Promise.resolve({ slug: "demo" }) });
}

describe("project Flow runner remap API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.remapSelectCalls = 0;
    state.tables.projects = [
      {
        id: "project-1",
        slug: "demo",
        archivedAt: null,
      },
    ];
    state.tables.platform_acp_runners = [
      { id: "claude-code", enabled: true, readinessStatus: "Ready" },
      { id: "disabled-runner", enabled: false, readinessStatus: "Ready" },
      { id: "not-ready-runner", enabled: true, readinessStatus: "NotReady" },
    ];
    state.tables.flow_runner_remaps = [
      {
        id: "remap-1",
        projectId: "project-1",
        flowRevisionId: "revision-1",
        stepId: "implement",
        sourceRunnerId: "claude-glm",
        mappedRunnerId: null,
        status: "Pending",
      },
    ];
    state.tables.flows = [
      {
        id: "flow-1",
        projectId: "project-1",
        flowRefId: "bugfix",
        enabledRevisionId: "revision-1",
        enablementState: "Disabled",
        trustStatus: "trusted_by_policy",
      },
    ];
    mocks.requireActiveSession.mockResolvedValue({ id: "user-1" });
    mocks.requireProjectAction.mockResolvedValue({ role: "admin" });
  });

  it("maps a missing Flow runner target after project-scoped authz", async () => {
    const res = await patch({
      remapId: "remap-1",
      mappedRunnerId: "claude-code",
    });
    const body = (await res.json()) as { status?: string };

    expect(res.status).toBe(200);
    expect(body.status).toBe("Mapped");
    expect(mocks.requireProjectAction).toHaveBeenCalledWith(
      "project-1",
      "editSettings",
    );
    expect(state.tables.flow_runner_remaps[0].mappedRunnerId).toBe(
      "claude-code",
    );
    expect(state.tables.flow_runner_remaps[0].status).toBe("Mapped");
    expect(state.tables.flows[0].enablementState).toBe("Disabled");
  });

  it("rejects disabled runner mappings", async () => {
    state.tables.platform_acp_runners = [
      { id: "disabled-runner", enabled: false, readinessStatus: "Ready" },
    ];

    const res = await patch({
      remapId: "remap-1",
      mappedRunnerId: "disabled-runner",
    });
    const body = (await res.json()) as { code?: string };

    expect(res.status).toBe(409);
    expect(body.code).toBe("PRECONDITION");
    expect(state.tables.flow_runner_remaps[0].status).toBe("Pending");
    expect(state.tables.flows[0].enablementState).toBe("Disabled");
  });

  it("rejects not-ready runner mappings", async () => {
    state.tables.platform_acp_runners = [
      { id: "not-ready-runner", enabled: true, readinessStatus: "NotReady" },
    ];

    const res = await patch({
      remapId: "remap-1",
      mappedRunnerId: "not-ready-runner",
    });
    const body = (await res.json()) as { code?: string };

    expect(res.status).toBe(409);
    expect(body.code).toBe("PRECONDITION");
    expect(state.tables.flow_runner_remaps[0].status).toBe("Pending");
    expect(state.tables.flows[0].enablementState).toBe("Disabled");
  });

  it("rejects callers without project settings authority", async () => {
    mocks.requireProjectAction.mockRejectedValueOnce(
      new MaisterError("UNAUTHORIZED", "Requires project settings access"),
    );

    const res = await patch({
      remapId: "remap-1",
      mappedRunnerId: "claude-code",
    });
    const body = (await res.json()) as { code?: string };

    expect(res.status).toBe(403);
    expect(body.code).toBe("UNAUTHORIZED");
    expect(mocks.requireProjectAction).toHaveBeenCalledWith(
      "project-1",
      "editSettings",
    );
    expect(state.tables.flow_runner_remaps[0].status).toBe("Pending");
    expect(state.tables.flows[0].enablementState).toBe("Disabled");
  });
});
