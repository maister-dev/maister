import type { NextRequest } from "next/server";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listBranches: vi.fn(),
  loadSelectableCapabilities: vi.fn(),
  requireActiveSession: vi.fn(),
}));

type FakeDb = {
  select: (fields?: unknown) => {
    from: (table: unknown) => {
      where: (predicate: unknown) => Promise<Record<string, unknown>[]>;
    };
  };
};

const state: {
  selectCalls: number;
  memberships: Record<string, unknown>[];
  visibleProjects: Record<string, unknown>[];
  executors: Record<string, unknown>[];
} = {
  selectCalls: 0,
  memberships: [],
  visibleProjects: [],
  executors: [],
};

const fakeDb: FakeDb = {
  select: () => ({
    from: () => ({
      where: async () => {
        state.selectCalls += 1;

        if (state.selectCalls === 1) return state.memberships;
        if (state.selectCalls === 2) return state.visibleProjects;
        if (state.selectCalls === 3) return state.executors;

        return [];
      },
    }),
  }),
};

vi.mock("@/lib/authz", () => ({
  requireActiveSession: mocks.requireActiveSession,
}));
vi.mock("@/lib/db/client", () => ({ getDb: () => fakeDb }));
vi.mock("@/lib/worktree", () => ({ listBranches: mocks.listBranches }));
vi.mock("@/lib/capabilities/resolver", () => ({
  loadSelectableCapabilities: mocks.loadSelectableCapabilities,
}));

let GET: (req: NextRequest) => Promise<Response>;

const projectA = {
  id: "11111111-1111-4111-8111-111111111111",
  slug: "alpha",
  name: "Alpha",
  repoPath: "/repos/alpha",
  mainBranch: "main",
  branchPrefix: "maister/",
  archivedAt: null,
};
const projectB = {
  id: "22222222-2222-4222-8222-222222222222",
  slug: "beta",
  name: "Beta",
  repoPath: "/repos/beta",
  mainBranch: "trunk",
  branchPrefix: "maister/",
  archivedAt: null,
};

beforeEach(async () => {
  state.selectCalls = 0;
  state.memberships = [{ projectId: projectA.id, role: "member" }];
  state.visibleProjects = [projectA];
  state.executors = [
    {
      id: "33333333-3333-4333-8333-333333333333",
      executorRefId: "codex-default",
      agent: "codex",
      model: "gpt-5",
      router: null,
    },
    {
      id: "44444444-4444-4444-8444-444444444444",
      executorRefId: "codex-high",
      agent: "codex",
      model: "gpt-5-high",
      router: "ccr",
    },
  ];
  mocks.requireActiveSession.mockResolvedValue({
    id: "user-1",
    role: "member",
  });
  mocks.listBranches.mockResolvedValue(["main", "release"]);
  mocks.loadSelectableCapabilities.mockResolvedValue([
    {
      id: "cap-row-1",
      projectId: projectA.id,
      capabilityRefId: "filesystem",
      kind: "mcp",
      label: "Filesystem",
      source: "platform",
      enforceability: "enforced",
      selectedByDefault: true,
      agents: ["codex", "claude"],
    },
    {
      id: "cap-row-2",
      projectId: projectA.id,
      capabilityRefId: "repo-rules",
      kind: "rule",
      label: "Repo rules",
      source: "project",
      enforceability: "instructed",
      selectedByDefault: false,
      agents: ["codex"],
    },
  ]);

  ({ GET } = await import("../route"));
});

afterEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

function request(projectId?: string): NextRequest {
  const url = new URL("http://x/api/scratch-runs/launch-options");

  if (projectId) url.searchParams.set("projectId", projectId);

  return new Request(url) as NextRequest;
}

describe("GET /api/scratch-runs/launch-options", () => {
  it("rejects an unauthenticated request with 401 and never reaches listBranches (M18 §3.1)", async () => {
    const { MaisterError } = await import("@/lib/errors");

    mocks.requireActiveSession.mockRejectedValueOnce(
      new MaisterError("UNAUTHENTICATED", "no active session"),
    );

    const res = await GET(request());
    const body = (await res.json()) as { code?: string };

    expect(res.status).toBe(401);
    expect(body.code).toBe("UNAUTHENTICATED");
    expect(mocks.listBranches).not.toHaveBeenCalled();
  });

  it("returns only member-visible project options and project-scoped capabilities", async () => {
    const res = await GET(request());
    const body = (await res.json()) as {
      projects: Array<{ id: string }>;
      branches: string[];
      executors: Array<{ id: string; displayLabel: string }>;
      workModes: Array<{ id: string; selectedByDefault: boolean }>;
      reasoningEfforts: Array<{ id: string; selectedByDefault: boolean }>;
      capabilities: {
        defaultSelectedMcpIds: string[];
        mcps: Array<{ id: string }>;
        rules: Array<{ id: string }>;
      };
    };

    expect(res.status).toBe(200);
    expect(body.projects.map((project) => project.id)).toEqual([projectA.id]);
    expect(body.branches).toEqual(["main", "release"]);
    expect(body.executors.map((executor) => executor.id)).toEqual([
      "33333333-3333-4333-8333-333333333333",
      "44444444-4444-4444-8444-444444444444",
    ]);
    expect(body.executors[1]?.displayLabel).toContain("codex-high");
    expect(body.workModes.map((mode) => mode.id)).toEqual([
      "auto",
      "plan_first",
      "manual_approval",
    ]);
    expect(body.reasoningEfforts.map((effort) => effort.id)).toEqual([
      "low",
      "high",
      "extra",
      "ultra",
    ]);
    expect(
      body.reasoningEfforts.find((effort) => effort.id === "high")
        ?.selectedByDefault,
    ).toBe(true);
    expect(body.capabilities.defaultSelectedMcpIds).toEqual(["filesystem"]);
    expect(body.capabilities.mcps).toEqual([
      expect.objectContaining({ id: "filesystem" }),
    ]);
    expect(body.capabilities.rules).toEqual([
      expect.objectContaining({ id: "repo-rules" }),
    ]);
    expect(mocks.listBranches).toHaveBeenCalledWith("/repos/alpha");
    expect(mocks.loadSelectableCapabilities).toHaveBeenCalledWith(
      projectA.id,
      fakeDb,
    );
  });

  it("rejects a project id outside the visible project set", async () => {
    state.visibleProjects = [projectA];

    const res = await GET(request(projectB.id));
    const body = (await res.json()) as { code?: string; message?: string };

    expect(res.status).toBe(409);
    expect(body.code).toBe("PRECONDITION");
    expect(body.message).toContain(projectB.id);
    expect(mocks.listBranches).not.toHaveBeenCalled();
  });

  it("surfaces branch listing failures without leaking another repo path", async () => {
    const { MaisterError } = await import("@/lib/errors");

    mocks.listBranches.mockRejectedValue(
      new MaisterError("CONFLICT", "git branch list failed"),
    );

    const res = await GET(request(projectA.id));
    const body = (await res.json()) as { code?: string };

    expect(res.status).toBe(409);
    expect(body.code).toBe("CONFLICT");
    expect(mocks.listBranches).toHaveBeenCalledWith("/repos/alpha");
  });
});
