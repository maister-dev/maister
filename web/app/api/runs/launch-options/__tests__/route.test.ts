import type { NextRequest } from "next/server";

import { getTableName } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireActiveSession: vi.fn(),
  requireProjectAction: vi.fn(),
  getLatestFlowRun: vi.fn(),
  getOpenRelationBlockers: vi.fn(),
  listBranches: vi.fn(),
}));

type TableName =
  | "flow_revisions"
  | "flow_runner_remaps"
  | "flows"
  | "platform_acp_runners"
  | "platform_router_sidecars"
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
  platform_router_sidecars: [],
  platform_runtime_settings: [],
  project_flow_runner_defaults: [],
  projects: [],
  tasks: [],
};

function tableNameOf(table: unknown): TableName {
  const tableName = getTableName(table as never);

  if (tableName in state) return tableName as TableName;

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
vi.mock("@/lib/runs/launchability", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/runs/launchability")>();

  return {
    ...actual,
    getLatestFlowRun: mocks.getLatestFlowRun,
  };
});
vi.mock("@/lib/social/relations", () => ({
  getOpenRelationBlockers: mocks.getOpenRelationBlockers,
}));
vi.mock("@/lib/worktree", () => ({ listBranches: mocks.listBranches }));
vi.mock("@/lib/local-packages/versions", () => ({
  detectAvailablePackageVersions: async () => [],
}));

// A runner-bearing node with no `settings.runner` joins the implicit `default`
// session (resolved via the project/platform default chain). A node with
// `settings.runner` becomes its own SOLO session keyed by node id.
function aiNode(id: string, runner?: string, next = "done"): Row {
  return {
    id,
    type: "ai_coding",
    action: { prompt: id },
    settings: { runner_type: "acp", ...(runner ? { runner } : {}) },
    transitions: { success: next },
  };
}

function manifest(nodes: Row[]): Row {
  return {
    schemaVersion: 1,
    name: "Bugfix",
    compat: { engine_min: "1.1.0" },
    nodes,
  };
}

function request(): NextRequest {
  const url = new URL("http://x/api/runs/launch-options?taskId=task-1");

  return { nextUrl: url } as NextRequest;
}

async function invoke(): Promise<Response> {
  const { GET } = await import("../route");

  return GET(request());
}

function seedBase(): void {
  state.platform_router_sidecars = [];
  state.tasks = [{ id: "task-1", projectId: "project-1", flowId: "flow-1" }];
  state.projects = [
    {
      id: "project-1",
      slug: "demo",
      mainBranch: "main",
      branchPrefix: "maister/",
      defaultRunnerId: null,
      deliveryPolicyDefault: {
        strategy: "merge",
        push: "never",
        trigger: "manual",
        targetBranch: null,
      },
      archivedAt: null,
    },
  ];
  state.flows = [
    {
      id: "flow-1",
      flowRefId: "bugfix",
      enabledRevisionId: "revision-1",
      enablementState: "Enabled",
    },
  ];
  state.flow_revisions = [
    {
      id: "revision-1",
      manifest: manifest([aiNode("implement")]),
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
  mocks.getLatestFlowRun.mockResolvedValue(null);
  mocks.getOpenRelationBlockers.mockResolvedValue(new Map());
  mocks.listBranches.mockResolvedValue(["main", "release"]);
}

describe("GET /api/runs/launch-options per-session resolution (M42)", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    seedBase();
  });

  it("resolves the default session via the platform default chain", async () => {
    const res = await invoke();
    const body = (await res.json()) as {
      selectedRunnerId?: string;
      sessions?: unknown[];
    };

    expect(res.status).toBe(200);
    // Single default session -> the single selectedRunnerId selector covers it.
    expect(body.selectedRunnerId).toBe("claude-platform");
    expect(body.sessions).toEqual([]);
  });

  it("binds a solo session runner via a Mapped slot binding", async () => {
    state.flow_revisions[0].manifest = manifest([
      aiNode("implement", "flow-claude"),
    ]);
    state.flow_runner_remaps = [
      {
        slotKey: "session:implement",
        mappedRunnerId: "codex-ready",
        status: "Mapped",
      },
    ];

    const res = await invoke();
    const body = (await res.json()) as { selectedRunnerId?: string };

    expect(res.status).toBe(200);
    expect(body.selectedRunnerId).toBe("codex-ready");
  });

  it("returns one session entry per logical session for a multi-session flow", async () => {
    state.flow_revisions[0].manifest = manifest([
      aiNode("plan", undefined, "implement"),
      aiNode("implement", "codex-ready"),
    ]);

    const res = await invoke();
    const body = (await res.json()) as {
      sessions?: {
        sessionName: string;
        runnerId: string | null;
        overridable: boolean;
      }[];
    };

    expect(res.status).toBe(200);
    expect(body.sessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sessionName: "default",
          runnerId: "claude-platform",
          overridable: true,
        }),
        expect.objectContaining({
          sessionName: "implement",
          runnerId: "codex-ready",
          overridable: true,
        }),
      ]),
    );
  });

  it("degrades an unbound session to runnerId null instead of 5xx", async () => {
    state.flow_revisions[0].manifest = manifest([
      aiNode("plan", undefined, "implement"),
      aiNode("implement", "ghost-profile"),
    ]);

    const res = await invoke();
    const body = (await res.json()) as {
      sessions?: { sessionName: string; runnerId: string | null }[];
    };

    expect(res.status).toBe(200);
    expect(body.sessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sessionName: "implement",
          runnerId: null,
        }),
      ]),
    );
  });

  it("never leaks provider secrets and omits the dropped runner fields", async () => {
    const res = await invoke();
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(body).not.toHaveProperty("defaultRunnerId");
    expect(body).not.toHaveProperty("runnerResolutionTier");
    expect(body).not.toHaveProperty("flowRef");
    expect(JSON.stringify(body)).not.toMatch(
      /authToken|apiKey|SECRET_TOKEN|OPENAI_SECRET/,
    );
  });

  it("returns the launch dialog DTO (task, flows, runners, branches, policy)", async () => {
    const res = await invoke();
    const body = (await res.json()) as {
      task?: { id?: string; projectSlug?: string; flowId?: string };
      launchability?: { launchable?: boolean; reason?: string };
      flows?: Array<{ id: string; enabled: boolean; isTaskDefault: boolean }>;
      selectedFlowId?: string;
      runners?: Array<{ id: string; model: string; pinnedModel?: object }>;
      branches?: string[];
      defaultBaseBranch?: string | null;
      deliveryPolicyDefault?: { strategy?: string; targetBranch?: string };
    };

    expect(res.status).toBe(200);
    expect(body.task).toMatchObject({
      id: "task-1",
      projectSlug: "demo",
      flowId: "flow-1",
    });
    expect(body.launchability).toEqual({
      launchable: true,
      reason: "launchable",
      blockers: [],
    });
    expect(body.selectedFlowId).toBe("flow-1");
    expect(body.runners).toEqual([
      expect.objectContaining({
        id: "claude-platform",
        pinnedModel: expect.objectContaining({ model: "claude-sonnet-4-6" }),
      }),
      expect.objectContaining({ id: "codex-ready", model: "gpt-5" }),
    ]);
    expect(body.branches).toContain("main");
    expect(body.defaultBaseBranch).toBe("main");
    expect(body.deliveryPolicyDefault).toMatchObject({
      strategy: "merge",
      targetBranch: "main",
    });
  });
});

describe("GET /api/runs/launch-options — launchability (ADR-089)", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    seedBase();
    // Provider with no secret fields for these launchability-focused cases.
    state.platform_acp_runners = state.platform_acp_runners.map((runner) => ({
      ...runner,
      provider: {
        kind: runner.capabilityAgent === "claude" ? "anthropic" : "openai",
      },
    }));
  });

  it("a flowless task gets options with launchability=unconfigured and no selected flow", async () => {
    state.tasks = [{ id: "task-1", projectId: "project-1", flowId: null }];

    const res = await invoke();
    const body = (await res.json()) as {
      launchability?: { launchable: boolean; reason: string };
      selectedFlowId?: string;
      flows?: Array<{ id: string; isTaskDefault: boolean }>;
    };

    expect(res.status).toBe(200);
    expect(body.launchability).toMatchObject({
      launchable: false,
      reason: "unconfigured",
    });
    expect(body.selectedFlowId).toBe("");
    expect(body.flows).toEqual([
      expect.objectContaining({ id: "flow-1", isTaskDefault: false }),
    ]);
  });

  it("returns edit/setup options for a selected flow with no enabled revision", async () => {
    state.flows = [
      { id: "flow-1", flowRefId: "bugfix", enabledRevisionId: null },
    ];

    const res = await invoke();
    const body = (await res.json()) as {
      launchability?: { launchable: boolean; reason: string };
      selectedFlowId?: string;
      flows?: Array<{ id: string; disabledReason: string }>;
      runners?: unknown[];
    };

    expect(res.status).toBe(200);
    expect(body.launchability).toMatchObject({
      launchable: false,
      reason: "no_revision",
    });
    expect(body.selectedFlowId).toBe("flow-1");
    expect(body.runners).toEqual([
      expect.objectContaining({ id: "claude-platform" }),
      expect.objectContaining({ id: "codex-ready" }),
    ]);
  });

  it("does not mark an installed-but-not-enabled flow as launchable", async () => {
    state.flows = [
      {
        id: "flow-1",
        flowRefId: "bugfix",
        enabledRevisionId: "revision-1",
        enablementState: "Installed",
      },
    ];

    const res = await invoke();
    const body = (await res.json()) as {
      launchability?: { launchable: boolean; reason: string };
    };

    expect(res.status).toBe(200);
    expect(body.launchability).toMatchObject({
      launchable: false,
      reason: "not_enabled",
    });
  });

  it("the triage verdict pre-fills runner, target branch, and promotion mode", async () => {
    state.tasks = [
      {
        id: "task-1",
        projectId: "project-1",
        flowId: "flow-1",
        runnerId: "codex-ready",
        targetBranch: "release",
        promotionMode: "pull_request",
      },
    ];

    const res = await invoke();
    const body = (await res.json()) as {
      selectedRunnerId?: string;
      defaultTargetBranch?: string;
      deliveryPolicyDefault?: { strategy: string; targetBranch: string };
    };

    expect(res.status).toBe(200);
    expect(body.selectedRunnerId).toBe("codex-ready");
    expect(body.defaultTargetBranch).toBe("release");
    expect(body.deliveryPolicyDefault).toMatchObject({
      strategy: "pull_request",
      targetBranch: "release",
    });
  });
});
