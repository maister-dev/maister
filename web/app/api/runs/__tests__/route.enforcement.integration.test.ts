import type { PlatformStatus } from "@/types/platform-status";

import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  readyExecutionHostCapabilities,
  TEST_HOST_IDENTITY,
} from "@/test-support/supervisor-health-fixture";
import * as schemaModule from "@/lib/db/schema";
import { testPlatformRunnerRow } from "@/lib/__tests__/runner-fixtures";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

const schema = schemaModule as unknown as Record<string, any>;

let testDatabase: StartedPostgresTestDb;
let db: NodePgDatabase;

// Controllable session — the REAL authz layer runs against the test DB.
const sessionRef: { value: unknown } = { value: null };

vi.mock("@/auth", () => ({
  auth: vi.fn(async () => sessionRef.value),
  signIn: vi.fn(),
  signOut: vi.fn(),
  handlers: {},
}));

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));

function readyPlatformStatus(): PlatformStatus {
  return {
    kind: "ready",
    health: {
      status: "ready",
      host: TEST_HOST_IDENTITY,
      version: "0.0.1",
      uptimeMs: 1,
      checkedAt: new Date().toISOString(),
      sessions: { live: 0, exited: 0, crashed: 0 },
    },
  };
}

const checkSupervisorHealthMock = vi.fn<() => Promise<PlatformStatus>>(
  async () => readyPlatformStatus(),
);
const addWorktreeMock = vi.fn(async (_input: unknown) => undefined);
const removeWorktreeMock = vi.fn(async (_input: unknown) => undefined);
const runFlowMock = vi.fn(async (_runId: string) => undefined);

vi.mock("@/lib/supervisor-client", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/supervisor-client")>();

  return {
    ...actual,
    checkSupervisorHealth: () => checkSupervisorHealthMock(),
    getExecutionHostCapabilities: async () => readyExecutionHostCapabilities(),
  };
});

vi.mock("@/lib/worktree", () => ({
  addWorktree: (input: unknown) => addWorktreeMock(input),
  removeWorktree: (input: unknown) => removeWorktreeMock(input),
  listBranches: async () => ["main"],
  listRemoteUrls: async () => [],
  resolveBaseCommit: async () => "0000000000000000000000000000000000000000",
}));
vi.mock("@/lib/flows/runner", () => ({
  runFlow: (runId: string) => runFlowMock(runId),
}));

let POST: typeof import("@/app/api/runs/route").POST;

function request(taskId: string): NextRequest {
  return new NextRequest("http://localhost/api/runs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ taskId }),
  });
}

// Manifest whose pinned revision declares an ai_coding node with a strict
// enforcement intent on a class the M11c table can only INSTRUCT → launch must
// REFUSE with CONFIG (400, the existing httpStatusForCode mapping).
// ADR-130 flipped tools/mcps to seam-ENFORCED for every agent, so a strict
// `mcps` declaration no longer refuses at the static gate with CONFIG — it
// resolves as enforceable, and where an agent cannot honour it the refusal is
// EXECUTOR_UNAVAILABLE instead. `skills` is still `instructed` for every agent
// (it is not seam-interceptable), so it is the class that still exercises the
// "no executor can strictly enforce this" CONFIG arm these cases are about.
// Same repoint applied to the sibling graph-runner suite in ea320e187.
const strictManifest = {
  schemaVersion: 1,
  name: "Strict",
  nodes: [
    {
      id: "implement",
      type: "ai_coding",
      action: { prompt: "/aif-implement" },
      transitions: { success: "done" },
      settings: { enforcement: { skills: "strict" } },
    },
  ],
};

// A judge node carrying strict skills — also capability-bearing → also refused.
const strictJudgeManifest = {
  schemaVersion: 1,
  name: "StrictJudge",
  nodes: [
    {
      id: "verdict",
      type: "judge",
      action: { prompt: "/judge" },
      transitions: { success: "done" },
      settings: { enforcement: { skills: "strict" } },
    },
  ],
};

// All-instruct manifest → launch must proceed past the enforcement gate.
const instructManifest = {
  schemaVersion: 1,
  name: "Instruct",
  nodes: [
    {
      id: "implement",
      type: "ai_coding",
      action: { prompt: "/aif-implement" },
      transitions: { success: "done" },
      settings: { enforcement: { mcps: "instruct" } },
    },
  ],
};

const legacyManifest = {
  schemaVersion: 1,
  name: "Legacy",
  steps: [],
};

// Retired settings.executors metadata is forbidden by the strict graph schema;
// runner resolution uses platform ACP runners and runner/remap fields.
const unknownExecutorManifest = {
  schemaVersion: 1,
  name: "UnknownExec",
  nodes: [
    {
      id: "implement",
      type: "ai_coding",
      action: { prompt: "/aif-implement" },
      transitions: { success: "done" },
      settings: { executors: ["ghost"] },
    },
  ],
};

// A value that happens to look like a historical runner ref is still forbidden.
const knownExecutorManifest = {
  schemaVersion: 1,
  name: "KnownExec",
  nodes: [
    {
      id: "implement",
      type: "ai_coding",
      action: { prompt: "/aif-implement" },
      transitions: { success: "done" },
      settings: { executors: ["claude-default"] },
    },
  ],
};

const missingFlowRoleManifest = {
  schemaVersion: 1,
  name: "MissingFlowRole",
  nodes: [
    {
      id: "review",
      type: "human",
      settings: {
        roles: ["reviewer"],
        decisions: ["approve"],
      },
      transitions: { approve: "done" },
    },
  ],
};

const stepTargetManifest = {
  schemaVersion: 1,
  name: "StepTarget",
  nodes: [
    {
      id: "implement",
      type: "ai_coding",
      action: { prompt: "/aif-implement" },
      transitions: { success: "done" },
      settings: { runner_type: "acp", runner: "flow-claude" },
    },
  ],
};

async function seedProjectWithManifest(
  id: string,
  slug: string,
  manifest: unknown,
  opts: { trustStatus?: string } = {},
): Promise<void> {
  await db.insert(schema.projects).values({
    taskKey: `T${crypto.randomUUID().slice(0, 8)}`.toUpperCase(),
    id,
    slug,
    name: slug,
    repoPath: `/repos/${slug}`,
    maisterYamlPath: `/repos/${slug}/maister.yaml`,
  });

  const revisionId = `rev-${id}`;

  await db.insert(schema.flowRevisions).values({
    id: revisionId,
    flowRefId: "bugfix",
    source: "github.com/x/y",
    versionLabel: "v1.0.0",
    resolvedRevision: id.padEnd(40, "x").slice(0, 40),
    manifestDigest: `digest-${id}`,
    manifest,
    schemaVersion: 1,
    installedPath: `/cache/${id}`,
    setupStatus: "not_required",
    packageStatus: "Installed",
  });
  await db.insert(schema.flows).values({
    id: `flow-${id}`,
    projectId: id,
    flowRefId: "bugfix",
    source: "github.com/x/y",
    version: "v1.0.0",
    installedPath: `/cache/${id}`,
    manifest,
    schemaVersion: 1,
    enabledRevisionId: revisionId,
    enablementState: "Enabled",
    trustStatus: opts.trustStatus ?? "trusted_by_policy",
  });
  await db
    .insert(schema.platformAcpRunners)
    .values(testPlatformRunnerRow(`exec-${id}`, "claude"));
  await db
    .update(schema.projects)
    .set({ defaultRunnerId: `exec-${id}` })
    .where(eq(schema.projects.id, id));
  await db.insert(schema.projectMembers).values({
    id: `pm-${id}`,
    projectId: id,
    userId: "u-member",
    role: "member",
  });
  await db.insert(schema.tasks).values({
    number: Math.trunc(Math.random() * 1e9) + 1,
    id: `task-${id}`,
    projectId: id,
    title: `${slug} task`,
    prompt: "do it",
    flowId: `flow-${id}`,
  });
}

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "runs_enf_test",
  });

  db = testDatabase.db;

  await db.insert(schema.users).values({
    id: "u-member",
    email: "member@test.com",
    role: "member",
    accountStatus: "active",
    passwordHash: "x",
  });
  await db.insert(schema.platformAcpRunners).values([
    {
      id: "claude-platform",
      adapter: "claude",
      capabilityAgent: "claude",
      model: "claude-sonnet-4-6",
      provider: { kind: "anthropic" },
      permissionPolicy: "default",
      readinessStatus: "Ready",
      readinessReasons: [],
      enabled: true,
    },
    {
      id: "codex-ready",
      adapter: "codex",
      capabilityAgent: "codex",
      model: "gpt-5",
      provider: { kind: "openai" },
      permissionPolicy: "default",
      readinessStatus: "Ready",
      readinessReasons: [],
      enabled: true,
    },
  ]);
  await db.insert(schema.platformRuntimeSettings).values({
    id: "singleton",
    defaultRunnerId: "claude-platform",
  });

  await seedProjectWithManifest("proj-strict", "proj-strict", strictManifest);
  await seedProjectWithManifest(
    "proj-judge",
    "proj-judge",
    strictJudgeManifest,
  );
  await seedProjectWithManifest(
    "proj-instruct",
    "proj-instruct",
    instructManifest,
  );
  await seedProjectWithManifest("proj-legacy", "proj-legacy", legacyManifest);
  await seedProjectWithManifest(
    "proj-badexec",
    "proj-badexec",
    unknownExecutorManifest,
  );
  await seedProjectWithManifest(
    "proj-goodexec",
    "proj-goodexec",
    knownExecutorManifest,
  );
  await seedProjectWithManifest(
    "proj-badrole",
    "proj-badrole",
    missingFlowRoleManifest,
  );
  await db.insert(schema.projectFlowRoles).values({
    id: "role-proj-badrole-maintainer",
    projectId: "proj-badrole",
    roleRef: "maintainer",
    label: "Maintainer",
    source: "config",
  });
  await seedProjectWithManifest(
    "proj-emptyrole",
    "proj-emptyrole",
    missingFlowRoleManifest,
  );
  await seedProjectWithManifest(
    "proj-untrusted",
    "proj-untrusted",
    strictManifest,
    {
      trustStatus: "untrusted",
    },
  );
  await seedProjectWithManifest(
    "proj-remap-mapped",
    "proj-remap-mapped",
    stepTargetManifest,
  );
  await db.insert(schema.flowRunnerRemaps).values({
    id: "remap-proj-remap-mapped",
    projectId: "proj-remap-mapped",
    flowRevisionId: "rev-proj-remap-mapped",
    slotKey: "session:implement",
    mappedRunnerId: "codex-ready",
    status: "Mapped",
  });
  await seedProjectWithManifest(
    "proj-remap-pending",
    "proj-remap-pending",
    stepTargetManifest,
  );
  await db.insert(schema.flowRunnerRemaps).values({
    id: "remap-proj-remap-pending",
    projectId: "proj-remap-pending",
    flowRevisionId: "rev-proj-remap-pending",
    slotKey: "session:implement",
    mappedRunnerId: null,
    status: "Pending",
  });

  ({ POST } = await import("@/app/api/runs/route"));
}, 180_000);

afterAll(async () => {
  await testDatabase?.stop();
});

describe("POST /api/runs — settings-enforcement launch refusal (integration)", () => {
  beforeEach(() => {
    checkSupervisorHealthMock.mockResolvedValue(readyPlatformStatus());
    addWorktreeMock.mockClear();
    removeWorktreeMock.mockClear();
    runFlowMock.mockClear();
    sessionRef.value = { user: { id: "u-member", role: "member" } };
  });

  it("refuses a strict-skills ai_coding manifest with 400 CONFIG and NO side-effect", async () => {
    const res = await POST(request("task-proj-strict"));

    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("CONFIG");

    // The refusal runs BEFORE worktree creation — no worktree, no run, no
    // workspace, task stays Backlog.
    expect(addWorktreeMock).not.toHaveBeenCalled();

    const runs = await db
      .select()
      .from(schema.runs)
      .where(eq(schema.runs.taskId, "task-proj-strict"));

    expect(runs).toHaveLength(0);

    const workspaces = await db
      .select()
      .from(schema.workspaces)
      .where(eq(schema.workspaces.projectId, "proj-strict"));

    expect(workspaces).toHaveLength(0);

    const task = await db
      .select()
      .from(schema.tasks)
      .where(eq(schema.tasks.id, "task-proj-strict"));

    expect(task[0].status).toBe("Backlog");
  });

  it("refuses a legacy pinned revision with 400 CONFIG before launch mutations", async () => {
    const sessionCountBefore = (await db.select().from(schema.runSessions))
      .length;
    const response = await POST(request("task-proj-legacy"));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      code: "CONFIG",
      message:
        "legacy steps[] flows are not supported since engine 3.0.0; republish the package with nodes[]",
    });
    expect(addWorktreeMock).not.toHaveBeenCalled();
    expect(
      await db
        .select()
        .from(schema.runs)
        .where(eq(schema.runs.taskId, "task-proj-legacy")),
    ).toHaveLength(0);
    expect(
      await db
        .select()
        .from(schema.workspaces)
        .where(eq(schema.workspaces.projectId, "proj-legacy")),
    ).toHaveLength(0);
    expect(await db.select().from(schema.runSessions)).toHaveLength(
      sessionCountBefore,
    );
    expect(
      (
        await db
          .select()
          .from(schema.tasks)
          .where(eq(schema.tasks.id, "task-proj-legacy"))
      )[0],
    ).toMatchObject({ status: "Backlog", attemptNumber: 1 });
  });

  it("refuses a strict-skills judge manifest with 400 CONFIG too", async () => {
    const res = await POST(request("task-proj-judge"));

    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("CONFIG");
    expect(addWorktreeMock).not.toHaveBeenCalled();

    const runs = await db
      .select()
      .from(schema.runs)
      .where(eq(schema.runs.taskId, "task-proj-judge"));

    expect(runs).toHaveLength(0);
  });

  it("an all-instruct manifest launches cleanly (202, creates runs + workspaces rows)", async () => {
    const res = await POST(request("task-proj-instruct"));

    expect(res.status).toBe(202);
    expect(addWorktreeMock).toHaveBeenCalledTimes(1);

    const runRows = await db
      .select()
      .from(schema.runs)
      .where(eq(schema.runs.taskId, "task-proj-instruct"));

    expect(runRows).toHaveLength(1);

    const workspaceRows = await db
      .select()
      .from(schema.workspaces)
      .where(eq(schema.workspaces.runId, runRows[0].id));

    expect(workspaceRows).toHaveLength(1);

    const task = await db
      .select()
      .from(schema.tasks)
      .where(eq(schema.tasks.id, "task-proj-instruct"));

    expect(task[0].status).toBe("InFlight");
  });

  it("persists a mapped Flow step runner as a per-slot binding, not the platform default", async () => {
    const res = await POST(request("task-proj-remap-mapped"));

    expect(res.status).toBe(202);
    expect(addWorktreeMock).toHaveBeenCalledTimes(1);

    const runRows = await db
      .select()
      .from(schema.runs)
      .where(eq(schema.runs.taskId, "task-proj-remap-mapped"));

    expect(runRows).toHaveLength(1);

    // M42 (ADR-114): runner identity lives on the run's default run_sessions row.
    const sessionRows = await db
      .select()
      .from(schema.runSessions)
      .where(eq(schema.runSessions.runId, runRows[0].id));

    expect(sessionRows[0].runnerId).toBe("codex-ready");
    // M42 (ADR-114): a Mapped per-slot remap resolves on the `binding` tier.
    expect(sessionRows[0].runnerResolutionTier).toBe("binding");
    expect(sessionRows[0].capabilityAgent).toBe("codex");
    expect(sessionRows[0].runnerSnapshot).toMatchObject({
      id: "codex-ready",
      capabilityAgent: "codex",
    });
  });

  it("rejects a pending Flow runner remap before worktree/run/workspace side effects", async () => {
    const res = await POST(request("task-proj-remap-pending"));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.code).toBe("CONFIG");
    // M42 (ADR-114): a Pending per-slot remap is unresolved — the slot falls
    // through to its (unbound) profile ref, refused before any side effect.
    expect(body.message).toContain("unknown runner profile");
    expect(addWorktreeMock).not.toHaveBeenCalled();

    const runRows = await db
      .select()
      .from(schema.runs)
      .where(eq(schema.runs.taskId, "task-proj-remap-pending"));
    const workspaceRows = await db
      .select()
      .from(schema.workspaces)
      .where(eq(schema.workspaces.projectId, "proj-remap-pending"));
    const taskRows = await db
      .select()
      .from(schema.tasks)
      .where(eq(schema.tasks.id, "task-proj-remap-pending"));

    expect(runRows).toHaveLength(0);
    expect(workspaceRows).toHaveLength(0);
    expect(taskRows[0].status).toBe("Backlog");
  });

  it("refuses an unknown retired settings.executors ref before launch mutations", async () => {
    const res = await POST(request("task-proj-badexec"));

    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("CONFIG");
    expect(addWorktreeMock).not.toHaveBeenCalled();

    const runs = await db
      .select()
      .from(schema.runs)
      .where(eq(schema.runs.taskId, "task-proj-badexec"));

    expect(runs).toHaveLength(0);

    const task = await db
      .select()
      .from(schema.tasks)
      .where(eq(schema.tasks.id, "task-proj-badexec"));

    expect(task[0].status).toBe("Backlog");
  });

  it("refuses a matching retired settings.executors ref just as strictly", async () => {
    const res = await POST(request("task-proj-goodexec"));

    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("CONFIG");
    expect(addWorktreeMock).not.toHaveBeenCalled();

    const runRows = await db
      .select()
      .from(schema.runs)
      .where(eq(schema.runs.taskId, "task-proj-goodexec"));

    expect(runRows).toHaveLength(0);
  });

  it("refuses a manifest role ref missing from the active project Flow role registry before worktree creation", async () => {
    const res = await POST(request("task-proj-badrole"));

    expect(res.status).toBe(400);

    const body = await res.json();

    expect(body.code).toBe("CONFIG");
    expect(body.message).toContain("reviewer");
    expect(addWorktreeMock).not.toHaveBeenCalled();

    const runs = await db
      .select()
      .from(schema.runs)
      .where(eq(schema.runs.taskId, "task-proj-badrole"));

    expect(runs).toHaveLength(0);
  });

  it("does not enforce manifest role refs when the project has no active Flow role registry", async () => {
    const res = await POST(request("task-proj-emptyrole"));

    expect(res.status).toBe(202);
    expect(addWorktreeMock).toHaveBeenCalledTimes(1);

    const runs = await db
      .select()
      .from(schema.runs)
      .where(eq(schema.runs.taskId, "task-proj-emptyrole"));

    expect(runs).toHaveLength(1);
  });

  it("refuses an untrusted revision on the TRUST gate BEFORE the enforcement evaluator (PRECONDITION 409, not CONFIG)", async () => {
    // The manifest carries enforcement.skills:"strict" (would yield CONFIG at the
    // enforcement gate), but trust runs first → the evaluator is never reached.
    const res = await POST(request("task-proj-untrusted"));

    expect(res.status).toBe(409);

    const body = await res.json();

    expect(body.code).toBe("PRECONDITION");
    expect(body.code).not.toBe("CONFIG");
    expect(addWorktreeMock).not.toHaveBeenCalled();

    const runs = await db
      .select()
      .from(schema.runs)
      .where(eq(schema.runs.taskId, "task-proj-untrusted"));

    expect(runs).toHaveLength(0);
  });
});
