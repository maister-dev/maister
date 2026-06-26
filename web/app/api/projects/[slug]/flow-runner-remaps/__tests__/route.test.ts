import { getTableName } from "drizzle-orm";
import { NextRequest } from "next/server";
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
  tables: Record<TableName, Row[]>;
} = {
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

const fakeDb = {
  select: () => ({
    from: (table: unknown) => ({
      where: async () => state.tables[tableNameOf(table)],
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
  insert: (table: unknown) => ({
    values: async (row: Row) => {
      state.tables[tableNameOf(table)].push(row);
    },
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

async function get(query = "") {
  const { GET } = await import("../route");

  return GET(
    new NextRequest(`http://x/api/projects/demo/flow-runner-remaps${query}`),
    { params: Promise.resolve({ slug: "demo" }) },
  );
}

describe("project Flow runner remap API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.tables.projects = [
      { id: "project-1", slug: "demo", archivedAt: null },
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
        slotKey: "session:default",
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
        manifest: { steps: [{ id: "implement", type: "agent" }] },
        enablementState: "Disabled",
        trustStatus: "trusted_by_policy",
      },
    ];
    mocks.requireActiveSession.mockResolvedValue({ id: "user-1" });
    mocks.requireProjectAction.mockResolvedValue({ role: "admin" });
  });

  it("binds a declared slot after project-scoped authz", async () => {
    const res = await patch({
      flowRevisionId: "revision-1",
      slotKey: "session:default",
      mappedRunnerId: "claude-code",
    });
    const body = (await res.json()) as { remap?: { status?: string } };

    expect(res.status).toBe(200);
    expect(body.remap?.status).toBe("Mapped");
    expect(mocks.requireProjectAction).toHaveBeenCalledWith(
      "project-1",
      "editSettings",
    );
    expect(state.tables.flow_runner_remaps[0].mappedRunnerId).toBe(
      "claude-code",
    );
    expect(state.tables.flow_runner_remaps[0].status).toBe("Mapped");
  });

  it("clears a slot binding back to Pending", async () => {
    state.tables.flow_runner_remaps[0].mappedRunnerId = "claude-code";
    state.tables.flow_runner_remaps[0].status = "Mapped";

    const res = await patch({
      flowRevisionId: "revision-1",
      slotKey: "session:default",
      mappedRunnerId: null,
    });
    const body = (await res.json()) as { remap?: { status?: string } };

    expect(res.status).toBe(200);
    expect(body.remap?.status).toBe("Pending");
    expect(state.tables.flow_runner_remaps[0].mappedRunnerId).toBeNull();
    expect(state.tables.flow_runner_remaps[0].status).toBe("Pending");
  });

  it("rejects a slot_key not declared by the revision", async () => {
    const res = await patch({
      flowRevisionId: "revision-1",
      slotKey: "session:ghost",
      mappedRunnerId: "claude-code",
    });
    const body = (await res.json()) as { code?: string };

    expect(res.status).toBe(409);
    expect(body.code).toBe("CONFLICT");
    expect(state.tables.flow_runner_remaps[0].status).toBe("Pending");
  });

  it("rejects a revision not present in the project", async () => {
    // The fake DB ignores the WHERE clause, so an absent project flow row is
    // modeled by emptying the table — the route's `flow[0]` is then undefined.
    state.tables.flows = [];

    const res = await patch({
      flowRevisionId: "revision-other",
      slotKey: "session:default",
      mappedRunnerId: "claude-code",
    });
    const body = (await res.json()) as { code?: string };

    expect(res.status).toBe(409);
    expect(body.code).toBe("CONFLICT");
  });

  it("rejects disabled runner mappings", async () => {
    state.tables.platform_acp_runners = [
      { id: "disabled-runner", enabled: false, readinessStatus: "Ready" },
    ];

    const res = await patch({
      flowRevisionId: "revision-1",
      slotKey: "session:default",
      mappedRunnerId: "disabled-runner",
    });
    const body = (await res.json()) as { code?: string };

    expect(res.status).toBe(409);
    expect(body.code).toBe("PRECONDITION");
    expect(state.tables.flow_runner_remaps[0].status).toBe("Pending");
  });

  it("rejects not-ready runner mappings", async () => {
    state.tables.platform_acp_runners = [
      { id: "not-ready-runner", enabled: true, readinessStatus: "NotReady" },
    ];

    const res = await patch({
      flowRevisionId: "revision-1",
      slotKey: "session:default",
      mappedRunnerId: "not-ready-runner",
    });
    const body = (await res.json()) as { code?: string };

    expect(res.status).toBe(409);
    expect(body.code).toBe("PRECONDITION");
    expect(state.tables.flow_runner_remaps[0].status).toBe("Pending");
  });

  it("lists slot bindings enriched with kind and label", async () => {
    const res = await get();
    const body = (await res.json()) as {
      remaps: { slotKey: string; kind: string; label: string }[];
    };

    expect(res.status).toBe(200);
    expect(body.remaps).toEqual([
      expect.objectContaining({
        slotKey: "session:default",
        kind: "session",
        label: "default",
        status: "Pending",
        flowRef: "bugfix",
      }),
    ]);
  });

  it("scopes the listing to one flow revision", async () => {
    state.tables.flow_runner_remaps.push({
      id: "remap-2",
      projectId: "project-1",
      flowRevisionId: "revision-2",
      slotKey: "session:default",
      mappedRunnerId: null,
      status: "Pending",
    });

    const res = await get("?flowRevisionId=revision-2");
    const body = (await res.json()) as { remaps: { flowRevisionId: string }[] };

    expect(body.remaps).toHaveLength(1);
    expect(body.remaps[0].flowRevisionId).toBe("revision-2");
  });

  it("rejects callers without project settings authority", async () => {
    mocks.requireProjectAction.mockRejectedValueOnce(
      new MaisterError("UNAUTHORIZED", "Requires project settings access"),
    );

    const res = await patch({
      flowRevisionId: "revision-1",
      slotKey: "session:default",
      mappedRunnerId: "claude-code",
    });
    const body = (await res.json()) as { code?: string };

    expect(res.status).toBe(403);
    expect(body.code).toBe("UNAUTHORIZED");
    expect(state.tables.flow_runner_remaps[0].status).toBe("Pending");
  });
});
