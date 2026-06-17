import { beforeEach, describe, expect, it, vi } from "vitest";

import { requireActiveSession, requireProjectAction } from "@/lib/authz";
import {
  hitlRequests as hitlRequestsTable,
  projects as projectsTable,
  runs as runsTable,
  scratchAttachments as scratchAttachmentsTable,
  scratchCapabilityProfiles as scratchCapabilityProfilesTable,
  scratchMessages as scratchMessagesTable,
  scratchRuns as scratchRunsTable,
  workspaces as workspacesTable,
} from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";

type Row = Record<string, unknown>;
type Tables = {
  hitl_requests: Row[];
  projects: Row[];
  runs: Row[];
  scratch_attachments: Row[];
  scratch_capability_profiles: Row[];
  scratch_messages: Row[];
  scratch_runs: Row[];
  workspaces: Row[];
};

const dbState: { tables: Tables } = {
  tables: {
    hitl_requests: [],
    projects: [],
    runs: [],
    scratch_attachments: [],
    scratch_capability_profiles: [],
    scratch_messages: [],
    scratch_runs: [],
    workspaces: [],
  },
};

function tableOf(table: unknown): keyof Tables {
  if (table === hitlRequestsTable) return "hitl_requests";
  if (table === projectsTable) return "projects";
  if (table === runsTable) return "runs";
  if (table === scratchAttachmentsTable) return "scratch_attachments";
  if (table === scratchCapabilityProfilesTable) {
    return "scratch_capability_profiles";
  }
  if (table === scratchMessagesTable) return "scratch_messages";
  if (table === scratchRunsTable) return "scratch_runs";
  if (table === workspacesTable) return "workspaces";
  throw new Error("unknown table");
}

const fakeDb = {
  select: () => ({
    from: (table: unknown) => ({
      where: async () => dbState.tables[tableOf(table)],
    }),
  }),
  update: (table: unknown) => ({
    set: (values: Row) => ({
      where: async () => {
        for (const row of dbState.tables[tableOf(table)]) {
          Object.assign(row, values);
        }
      },
    }),
  }),
};

vi.mock("@/lib/db/client", () => ({
  getDb: () => fakeDb,
}));

vi.mock("@/lib/authz", () => ({
  requireActiveSession: vi.fn(async () => ({
    id: "user-1",
    role: "member",
    accountStatus: "active",
    mustChangePassword: false,
  })),
  requireProjectAction: vi.fn(async () => ({
    user: {
      id: "user-1",
      role: "member",
      accountStatus: "active",
      mustChangePassword: false,
    },
    role: "member",
  })),
}));

function seedScratchRun(): string {
  const runId = "scratch-get-run";

  dbState.tables.projects = [{ id: "project-1", slug: "demo" }];
  dbState.tables.runs = [
    {
      id: runId,
      projectId: "project-1",
      runnerId: "runner-claude",
      runnerResolutionTier: "projectDefault",
      capabilityAgent: "claude",
      runnerSnapshot: {
        id: "runner-claude",
        adapter: "claude",
        capabilityAgent: "claude",
        model: "sonnet",
        providerKind: "anthropic",
        permissionPolicy: "default",
        sidecarId: null,
      },
      runKind: "scratch",
      status: "Running",
      acpSessionId: "acp-secret",
      currentStepId: "scratch-dialog",
      startedAt: new Date("2026-05-31T12:00:00.000Z"),
      endedAt: null,
    },
  ];
  dbState.tables.scratch_runs = [
    {
      runId,
      name: "Scratch",
      planMode: true,
      linkedTaskId: null,
      linkedIssueUrl: null,
      baseBranch: "main",
      baseCommit: "abc1234",
      targetBranch: "main",
      dialogStatus: "Running",
      supervisorSessionId: "supervisor-secret",
      errorCode: null,
      errorMessage: null,
      lastUserMessageAt: null,
      lastAgentMessageAt: null,
    },
  ];
  dbState.tables.workspaces = [
    {
      id: "workspace-1",
      runId,
      branch: "scratch/demo",
      worktreePath: "/tmp/scratch/demo",
      parentRepoPath: "/repo/demo",
      removedAt: null,
    },
  ];
  dbState.tables.scratch_capability_profiles = [
    {
      runId,
      profileDigest: "digest",
      materializedPath: "/tmp/scratch/demo/.maister/capabilities/run",
      selectedMcpIds: ["filesystem"],
      selectedSkillIds: ["aif-fix"],
      selectedRuleIds: ["project-rules"],
      restrictions: { selectedRestrictionIds: [] },
      adapterLaunch: {
        env: {
          MAISTER_CAPABILITY_PROFILE_PATH: "/tmp/profile.json",
        },
      },
      downgradeNotes: null,
    },
  ];
  dbState.tables.hitl_requests = [
    {
      id: "hitl-1",
      runId,
      kind: "permission",
      prompt: "Approve?",
      schema: {
        requestId: "request-secret",
        supervisorSessionId: "supervisor-secret",
        options: [{ optionId: "allow", label: "Allow" }],
      },
      respondedAt: null,
    },
  ];
  dbState.tables.scratch_attachments = [
    {
      id: "attachment-1",
      runId,
      messageId: "message-1",
      kind: "uploaded_file",
      label: "notes.txt",
      value: ".maister/demo/runs/scratch-get-run/uploads/launch/notes.txt",
      fileName: "notes.txt",
      mimeType: "text/plain",
      byteSize: 5,
      sha256: "a".repeat(64),
      storagePath:
        "/runtime/.maister/demo/runs/scratch-get-run/uploads/launch/notes.txt",
      createdAt: new Date("2026-05-31T12:01:00.000Z"),
    },
  ];

  return runId;
}

describe("GET /api/scratch-runs/[runId]", () => {
  it("does not expose internal ACP or supervisor session handles", async () => {
    const runId = seedScratchRun();
    const { GET } = await import("../route");

    const res = await GET(new Request(`http://localhost/${runId}`), {
      params: Promise.resolve({ runId }),
    });
    const body = (await res.json()) as {
      capabilityProfile: Record<string, unknown>;
      pendingHitl: { schema: Record<string, unknown> };
      run: Record<string, unknown>;
      scratch: Record<string, unknown>;
      workspace: Record<string, unknown>;
      attachments: Array<Record<string, unknown>>;
    };

    expect(res.status).toBe(200);
    expect(body.run).not.toHaveProperty("acpSessionId");
    expect(body.run).not.toHaveProperty("executorId");
    expect(body.run).toMatchObject({
      projectSlug: "demo",
      runnerId: "runner-claude",
      runnerResolutionTier: "projectDefault",
      capabilityAgent: "claude",
      runnerSnapshot: {
        id: "runner-claude",
        adapter: "claude",
        capabilityAgent: "claude",
        model: "sonnet",
        providerKind: "anthropic",
        permissionPolicy: "default",
        sidecarId: null,
      },
    });
    expect(body.scratch).not.toHaveProperty("supervisorSessionId");
    expect(body).toMatchObject({
      workspace: {
        id: "workspace-1",
        branch: "scratch/demo",
        removedAt: null,
      },
      capabilityProfile: {
        profileDigest: "digest",
        selectedMcpIds: ["filesystem"],
        selectedSkillIds: ["aif-fix"],
        selectedRuleIds: ["project-rules"],
      },
      pendingHitl: {
        schema: {
          options: [{ optionId: "allow", label: "Allow" }],
        },
      },
    });
    expect(body.workspace).not.toHaveProperty("worktreePath");
    expect(body.workspace).not.toHaveProperty("parentRepoPath");
    expect(body.capabilityProfile).not.toHaveProperty("materializedPath");
    expect(body.capabilityProfile).not.toHaveProperty("adapterLaunch");
    expect(body.pendingHitl.schema).not.toHaveProperty("requestId");
    expect(body.pendingHitl.schema).not.toHaveProperty("supervisorSessionId");
    expect(body.attachments[0]).toMatchObject({
      kind: "uploaded_file",
      artifactRef:
        ".maister/demo/runs/scratch-get-run/uploads/launch/notes.txt",
    });
    expect(body.attachments[0]).not.toHaveProperty("storagePath");
  });
});

describe("PATCH /api/scratch-runs/[runId]", () => {
  beforeEach(() => {
    vi.mocked(requireActiveSession).mockClear();
    vi.mocked(requireProjectAction).mockClear();
  });

  function seedScratchForRename(name = "Old name"): string {
    const runId = "scratch-patch-run";

    dbState.tables.runs = [
      {
        id: runId,
        projectId: "project-1",
        runKind: "scratch",
        status: "Running",
      },
    ];
    dbState.tables.scratch_runs = [{ runId, name, dialogStatus: "Running" }];

    return runId;
  }

  async function patch(
    runId: string,
    body: unknown,
  ): Promise<{
    status: number;
    json: { ok?: boolean; name?: string; code?: string };
  }> {
    const { PATCH } = await import("../route");
    const res = await PATCH(
      new Request(`http://localhost/${runId}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ runId }) },
    );

    return { status: res.status, json: await res.json() };
  }

  it("renames a scratch run, persists the trimmed name, and gates on the project action", async () => {
    const runId = seedScratchForRename("Old");

    const res = await patch(runId, { name: "  New name  " });

    expect(res.status).toBe(200);
    expect(res.json).toEqual({ ok: true, name: "New name" });
    expect(dbState.tables.scratch_runs[0].name).toBe("New name");
    expect(vi.mocked(requireProjectAction)).toHaveBeenCalledWith(
      "project-1",
      "renameScratchRun",
    );
  });

  it("ignores unknown body properties and renames on the trimmed name", async () => {
    const runId = seedScratchForRename("Old");

    const res = await patch(runId, { name: "  Kept  ", bogus: "x", id: 7 });

    expect(res.status).toBe(200);
    expect(res.json).toEqual({ ok: true, name: "Kept" });
    expect(dbState.tables.scratch_runs[0].name).toBe("Kept");
  });

  it("rejects an empty (whitespace-only) name with CONFIG 400 and does not write", async () => {
    const runId = seedScratchForRename("Old");

    const res = await patch(runId, { name: "   " });

    expect(res.status).toBe(400);
    expect(res.json.code).toBe("CONFIG");
    expect(dbState.tables.scratch_runs[0].name).toBe("Old");
  });

  it("rejects a name longer than 200 characters with CONFIG 400", async () => {
    const runId = seedScratchForRename("Old");

    const res = await patch(runId, { name: "x".repeat(201) });

    expect(res.status).toBe(400);
    expect(res.json.code).toBe("CONFIG");
    expect(dbState.tables.scratch_runs[0].name).toBe("Old");
  });

  it("rejects a missing name field with CONFIG 400", async () => {
    const runId = seedScratchForRename("Old");

    const res = await patch(runId, {});

    expect(res.status).toBe(400);
    expect(res.json.code).toBe("CONFIG");
  });

  it("returns PRECONDITION 409 for a non-scratch run", async () => {
    const runId = "flow-run";

    dbState.tables.runs = [
      { id: runId, projectId: "project-1", runKind: "flow", status: "Running" },
    ];
    dbState.tables.scratch_runs = [];

    const res = await patch(runId, { name: "Nope" });

    expect(res.status).toBe(409);
    expect(res.json.code).toBe("PRECONDITION");
  });

  it("returns PRECONDITION 409 for a missing run", async () => {
    dbState.tables.runs = [];
    dbState.tables.scratch_runs = [];

    const res = await patch("ghost", { name: "Nope" });

    expect(res.status).toBe(409);
    expect(res.json.code).toBe("PRECONDITION");
  });

  it("returns UNAUTHORIZED 403 for a viewer and does not write", async () => {
    const runId = seedScratchForRename("Old");

    vi.mocked(requireProjectAction).mockRejectedValueOnce(
      new MaisterError("UNAUTHORIZED", "denied"),
    );

    const res = await patch(runId, { name: "New" });

    expect(res.status).toBe(403);
    expect(res.json.code).toBe("UNAUTHORIZED");
    expect(dbState.tables.scratch_runs[0].name).toBe("Old");
  });

  it("returns UNAUTHENTICATED 401 with no session", async () => {
    const runId = seedScratchForRename("Old");

    vi.mocked(requireActiveSession).mockRejectedValueOnce(
      new MaisterError("UNAUTHENTICATED", "sign in"),
    );

    const res = await patch(runId, { name: "New" });

    expect(res.status).toBe(401);
    expect(res.json.code).toBe("UNAUTHENTICATED");
  });
});
