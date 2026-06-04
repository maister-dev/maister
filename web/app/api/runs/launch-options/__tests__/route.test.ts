import type { NextRequest } from "next/server";

import { getTableName } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireActiveSession: vi.fn(),
  requireProjectAction: vi.fn(),
}));

type TableName =
  | "flow_revisions"
  | "flow_runner_remaps"
  | "flows"
  | "platform_acp_runners"
  | "platform_runtime_settings"
  | "project_flow_runner_defaults"
  | "projects"
  | "tasks";
type Row = Record<string, unknown>;

const state: Record<TableName, Row[]> = {
  flow_revisions: [],
  flow_runner_remaps: [],
  flows: [],
  platform_acp_runners: [],
  platform_runtime_settings: [],
  project_flow_runner_defaults: [],
  projects: [],
  tasks: [],
};

function tableNameOf(table: unknown): TableName {
  const tableName = getTableName(table as never);

  if (
    tableName === "flow_revisions" ||
    tableName === "flow_runner_remaps" ||
    tableName === "flows" ||
    tableName === "platform_acp_runners" ||
    tableName === "platform_runtime_settings" ||
    tableName === "project_flow_runner_defaults" ||
    tableName === "projects" ||
    tableName === "tasks"
  ) {
    return tableName;
  }

  throw new Error(`unknown table: ${tableName}`);
}

const fakeDb = {
  select: () => ({
    from: (table: unknown) => ({
      where: async () => state[tableNameOf(table)],
      then: <TResult1 = Row[], TResult2 = never>(
        onfulfilled?:
          | ((value: Row[]) => TResult1 | PromiseLike<TResult1>)
          | null,
        onrejected?:
          | ((reason: unknown) => TResult2 | PromiseLike<TResult2>)
          | null,
      ) =>
        Promise.resolve(state[tableNameOf(table)]).then(
          onfulfilled,
          onrejected,
        ),
    }),
  }),
};

vi.mock("@/lib/authz", () => ({
  requireActiveSession: mocks.requireActiveSession,
  requireProjectAction: mocks.requireProjectAction,
}));
vi.mock("@/lib/db/client", () => ({ getDb: () => fakeDb }));

function manifest(runner: string): Row {
  return {
    schemaVersion: 1,
    name: "Bugfix",
    compat: { engine_min: "1.1.0" },
    nodes: [
      {
        id: "implement",
        type: "ai_coding",
        action: { prompt: "implement" },
        settings: { runner_type: "acp", runner },
        transitions: { success: "done" },
      },
    ],
  };
}

function request(): NextRequest {
  const url = new URL("http://x/api/runs/launch-options?taskId=task-1");

  return {
    nextUrl: url,
  } as NextRequest;
}

async function invoke(): Promise<Response> {
  const { GET } = await import("../route");

  return GET(request());
}

describe("GET /api/runs/launch-options runner remaps", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    state.tasks = [{ id: "task-1", projectId: "project-1", flowId: "flow-1" }];
    state.projects = [
      {
        id: "project-1",
        slug: "demo",
        defaultRunnerId: null,
        archivedAt: null,
      },
    ];
    state.flows = [
      {
        id: "flow-1",
        flowRefId: "bugfix",
        enabledRevisionId: "revision-1",
      },
    ];
    state.flow_revisions = [
      {
        id: "revision-1",
        manifest: manifest("flow-claude"),
        packageStatus: "Installed",
        setupStatus: "not_required",
        schemaVersion: 1,
        defaultRunnerId: null,
      },
    ];
    state.platform_runtime_settings = [
      { id: "singleton", defaultRunnerId: "claude-platform" },
    ];
    state.platform_acp_runners = [
      {
        id: "claude-platform",
        adapter: "claude",
        capabilityAgent: "claude",
        model: "claude-sonnet-4-6",
        provider: { kind: "anthropic_compatible", authToken: "env:SECRET_TOKEN" },
        permissionPolicy: "default",
        sidecarId: null,
        readinessStatus: "Ready",
        readinessReasons: [],
        enabled: true,
      },
      {
        id: "codex-ready",
        adapter: "codex",
        capabilityAgent: "codex",
        model: "gpt-5",
        provider: { kind: "openai_compatible", apiKey: "env:OPENAI_SECRET" },
        permissionPolicy: "default",
        sidecarId: null,
        readinessStatus: "Ready",
        readinessReasons: [],
        enabled: true,
      },
    ];
    state.project_flow_runner_defaults = [];
    state.flow_runner_remaps = [];
    mocks.requireActiveSession.mockResolvedValue({ id: "user-1" });
    mocks.requireProjectAction.mockResolvedValue({ role: "member" });
  });

  it("returns mapped Flow step target as the default runner", async () => {
    state.flow_runner_remaps = [
      {
        stepId: "implement",
        sourceRunnerId: "flow-claude",
        mappedRunnerId: "codex-ready",
        status: "Mapped",
      },
    ];

    const res = await invoke();
    const body = (await res.json()) as {
      defaultRunnerId?: string;
      runnerResolutionTier?: string;
    };

    expect(res.status).toBe(200);
    expect(body.defaultRunnerId).toBe("codex-ready");
    expect(body.runnerResolutionTier).toBe("stepTarget");
    expect(JSON.stringify(body)).not.toMatch(
      /authToken|apiKey|SECRET_TOKEN|OPENAI_SECRET/,
    );
  });

  it("refuses pending Flow runner remap instead of exposing platform default", async () => {
    state.flow_runner_remaps = [
      {
        stepId: "implement",
        sourceRunnerId: "flow-claude",
        mappedRunnerId: null,
        status: "Pending",
      },
    ];

    const res = await invoke();
    const body = (await res.json()) as { code?: string; message?: string };

    expect(res.status).toBe(422);
    expect(body.code).toBe("CONFIG");
    expect(body.message).toContain("requires ACP runner remapping");
  });
});
