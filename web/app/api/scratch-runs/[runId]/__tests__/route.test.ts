import { describe, expect, it, vi } from "vitest";

import {
  hitlRequests as hitlRequestsTable,
  runs as runsTable,
  scratchAttachments as scratchAttachmentsTable,
  scratchCapabilityProfiles as scratchCapabilityProfilesTable,
  scratchMessages as scratchMessagesTable,
  scratchRuns as scratchRunsTable,
  workspaces as workspacesTable,
} from "@/lib/db/schema";

type Row = Record<string, unknown>;
type Tables = {
  hitl_requests: Row[];
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

  dbState.tables.runs = [
    {
      id: runId,
      projectId: "project-1",
      executorId: "executor-1",
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
    };

    expect(res.status).toBe(200);
    expect(body.run).not.toHaveProperty("acpSessionId");
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
  });
});
