import type { LaunchRunInput } from "@/lib/services/runs";
import type { PlatformStatus } from "@/types/platform-status";

import path from "node:path";
import { mkdir, rm } from "node:fs/promises";

import { type NodePgDatabase } from "drizzle-orm/node-postgres";
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

import { git as fixtureGit } from "@/test-support/git-fixture";
import {
  seedAcceptedRepositoryQualification,
  createEngineFixtureRepository,
  isolateEngineFixtureRuntime,
} from "@/test-support/repository-qualification";
import { launchEngineResponse } from "@/test-support/launch-engine-response";
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

// ADR-119 / Phase 3 — the allowConcurrent body flag selects the force gate, and
// GET /api/runs/launch-options carries the additive `relaunch` verdict. Real
// Postgres; git/supervisor mocked. The force gate widens ONLY the run-status
// gate (busy → launchable) — it NEVER bypasses the task gates flagged/blocked.

const schema = schemaModule as unknown as Record<string, any>;

let testDatabase: StartedPostgresTestDb;
const repositories: string[] = [];
let restoreEngineRuntime: (() => Promise<void>) | undefined;
let db: NodePgDatabase;

const sessionRef: { value: unknown } = { value: null };

vi.mock("@/auth", () => ({
  auth: vi.fn(async () => sessionRef.value),
  signIn: vi.fn(),
  signOut: vi.fn(),
  handlers: {},
}));

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));

// These assertions stop at launch preparation; model execution has separate coverage.
vi.mock("@/lib/flows/runner", () => ({
  runFlow: vi.fn(async () => undefined),
}));

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
const listBranchesMock = vi.fn(async (_repo: string) => ["main", "develop"]);
const resolveBaseCommitMock = vi.fn(
  async (args: { projectRepoPath: string; baseRef: string }) =>
    fixtureGit(
      args.projectRepoPath,
      "rev-parse",
      "--verify",
      `${args.baseRef}^{commit}`,
    ),
);

vi.mock("@/lib/supervisor-client", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/supervisor-client")>();

  return {
    ...actual,
    checkSupervisorHealth: () => checkSupervisorHealthMock(),
    getExecutionHostCapabilities: async () => readyExecutionHostCapabilities(),
  };
});

vi.mock("@/lib/worktree", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/worktree")>();

  return {
    ...actual,
    addWorktree: async (input: Parameters<typeof actual.addWorktree>[0]) => {
      await addWorktreeMock(input);

      return actual.addWorktree(input);
    },
    removeWorktree: async (
      input: Parameters<typeof actual.removeWorktree>[0],
    ) => {
      await removeWorktreeMock(input);

      return actual.removeWorktree(input);
    },
    listBranches: (repo: string) => listBranchesMock(repo),
    resolveBaseCommit: (args: Parameters<typeof resolveBaseCommitMock>[0]) =>
      resolveBaseCommitMock(args),
  };
});

function launchResponse(input: LaunchRunInput): Promise<Response> {
  return launchEngineResponse(testDatabase.db, input, {
    actorUserId: "u-member",
    authorize: async () => undefined,
  });
}
let LAUNCH_OPTIONS_GET: typeof import("@/app/api/runs/launch-options/route").GET;

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

async function seedProject(id: string, slug: string): Promise<void> {
  const repoPath = await createEngineFixtureRepository();

  repositories.push(repoPath);
  await mkdir(path.join(repoPath, ".fixture-flow"), { recursive: true });
  await db.insert(schema.projects).values({
    taskKey: `T${crypto.randomUUID().slice(0, 8)}`.toUpperCase(),
    id,
    slug,
    name: slug,
    repoPath,
    mainBranch: "main",
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
    manifest: instructManifest,
    schemaVersion: 1,
    installedPath: path.join(repoPath, ".fixture-flow"),
    setupStatus: "not_required",
    packageStatus: "Installed",
  });
  await db.insert(schema.flows).values({
    id: `flow-${id}`,
    projectId: id,
    flowRefId: "bugfix",
    source: "github.com/x/y",
    version: "v1.0.0",
    installedPath: path.join(repoPath, ".fixture-flow"),
    manifest: instructManifest,
    schemaVersion: 1,
    enabledRevisionId: revisionId,
    enablementState: "Enabled",
    trustStatus: "trusted_by_policy",
  });
  await db.insert(schema.projectMembers).values({
    id: `pm-${id}`,
    projectId: id,
    userId: "u-member",
    role: "member",
  });
}

async function seedTask(
  taskId: string,
  projectId: string,
  opts: { triageStatus?: string; status?: string } = {},
): Promise<void> {
  await db.insert(schema.tasks).values({
    number: Math.trunc(Math.random() * 1e9) + 1,
    id: taskId,
    projectId,
    title: "gate task",
    prompt: "do it",
    flowId: `flow-${projectId}`,
    ...(opts.triageStatus
      ? { triageStatus: opts.triageStatus, triageFlagOrigin: "explicit" }
      : {}),
    ...(opts.status ? { status: opts.status } : {}),
  });
  await seedAcceptedRepositoryQualification(testDatabase.db, projectId, taskId);
}

function postRequest(body: LaunchRunInput): LaunchRunInput {
  return body;
}

function launchOptionsRequest(taskId: string): NextRequest {
  return new NextRequest(
    `http://localhost/api/runs/launch-options?taskId=${taskId}`,
  );
}

beforeAll(async () => {
  restoreEngineRuntime = await isolateEngineFixtureRuntime();
  testDatabase = await startMainPostgresTestDb({
    databaseName: "relaunch_gate_test",
  });

  db = testDatabase.db;

  await db.insert(schema.users).values({
    id: "u-member",
    email: "member@test.com",
    role: "member",
    accountStatus: "active",
    passwordHash: "x",
  });
  await db
    .insert(schema.platformAcpRunners)
    .values(testPlatformRunnerRow("claude-default", "claude"));
  await db.insert(schema.platformRuntimeSettings).values({
    id: "singleton",
    defaultRunnerId: "claude-default",
  });

  await seedProject("proj-gate", "proj-gate");
  await seedTask("task-busy", "proj-gate");

  // A blocked task: a Backlog blocker task X `blocks` it.
  await seedTask("task-blocked", "proj-gate");
  await seedTask("task-blocker", "proj-gate", { status: "Backlog" });
  await db.insert(schema.taskRelations).values({
    id: "rel-1",
    projectId: "proj-gate",
    fromTaskId: "task-blocker",
    kind: "blocks",
    toTaskId: "task-blocked",
    actorType: "user",
    actorId: "u-member",
  });

  // A flagged task.
  await seedTask("task-flagged", "proj-gate", { triageStatus: "flagged" });

  // ADR-119 (S1): a task whose flow became non-launchable (Disabled) after
  // configuration. The force verdict must layer the flow-setup issue exactly
  // like the manual launchability so the runs-history button disables up-front.
  await db.insert(schema.flows).values({
    id: "flow-disabled",
    projectId: "proj-gate",
    flowRefId: "bugfix-disabled",
    source: "github.com/x/y",
    version: "v1.0.0",
    installedPath: "/cache/disabled",
    manifest: instructManifest,
    schemaVersion: 1,
    enabledRevisionId: "rev-proj-gate",
    enablementState: "Disabled",
    trustStatus: "trusted_by_policy",
  });
  await db.insert(schema.tasks).values({
    number: Math.trunc(Math.random() * 1e9) + 1,
    id: "task-flowissue",
    projectId: "proj-gate",
    title: "flow issue task",
    prompt: "do it",
    flowId: "flow-disabled",
  });

  ({ GET: LAUNCH_OPTIONS_GET } =
    await import("@/app/api/runs/launch-options/route"));
}, 180_000);

afterAll(async () => {
  await restoreEngineRuntime?.();
  await testDatabase?.stop();
  await Promise.all(
    repositories.map((repo) => rm(repo, { recursive: true, force: true })),
  );
});

beforeEach(() => {
  checkSupervisorHealthMock.mockResolvedValue(readyPlatformStatus());
  addWorktreeMock.mockClear();
  sessionRef.value = { user: { id: "u-member", role: "member" } };
});

describe("Delivery engine — allowConcurrent gate (ADR-119, integration)", () => {
  it("a busy task: the ordinary reservation conflicts; an authorized concurrent decision succeeds", async () => {
    // First launch makes the task busy (latest run Pending/Running).
    const first = await launchResponse(postRequest({ taskId: "task-busy" }));

    expect(first.status).toBe(202);

    // Manual gate (default) refuses while busy.
    const refused = await launchResponse(postRequest({ taskId: "task-busy" }));

    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({
      code: "CONFLICT",
      details: { reason: "launch_already_reserved" },
    });

    // Force gate launches an additive concurrent run.
    const forced = await launchResponse(
      postRequest({ taskId: "task-busy", allowConcurrent: true }),
    );

    expect(forced.status).toBe(202);
  });

  it("a blocked task: allowConcurrent:true is STILL refused PRECONDITION (task gate not bypassed)", async () => {
    const res = await launchResponse(
      postRequest({ taskId: "task-blocked", allowConcurrent: true }),
    );

    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("PRECONDITION");
  });

  it("a flagged task: an authorized concurrent decision still refuses the explicit hold", async () => {
    const res = await launchResponse(
      postRequest({ taskId: "task-flagged", allowConcurrent: true }),
    );

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      code: "CONFLICT",
      details: { reason: "launch_task_held" },
    });
  });
});

describe("GET /api/runs/launch-options — relaunch field (ADR-119, integration)", () => {
  it("a busy task: launchability is busy/not-launchable but relaunch is launchable", async () => {
    const res = await LAUNCH_OPTIONS_GET(launchOptionsRequest("task-busy"));

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      launchability: { launchable: boolean; reason: string };
      relaunch: { launchable: boolean; reason: string };
    };

    expect(body.launchability.launchable).toBe(false);
    expect(body.launchability.reason).toBe("busy");
    expect(body.relaunch.launchable).toBe(true);
    expect(body.relaunch.reason).toBe("launchable");
  });

  it("a blocked task: relaunch.reason is blocked", async () => {
    const res = await LAUNCH_OPTIONS_GET(launchOptionsRequest("task-blocked"));
    const body = (await res.json()) as {
      relaunch: { launchable: boolean; reason: string };
    };

    expect(body.relaunch.launchable).toBe(false);
    expect(body.relaunch.reason).toBe("blocked");
  });

  it("a flagged task: relaunch.reason is flagged", async () => {
    const res = await LAUNCH_OPTIONS_GET(launchOptionsRequest("task-flagged"));
    const body = (await res.json()) as {
      relaunch: { launchable: boolean; reason: string };
    };

    expect(body.relaunch.launchable).toBe(false);
    expect(body.relaunch.reason).toBe("flagged");
  });

  // ADR-119 (S1): a non-launchable flow surfaces in the force verdict too — the
  // runs-history button disables up-front instead of failing after submit.
  it("a task with a disabled flow: relaunch layers the flow-setup issue", async () => {
    const res = await LAUNCH_OPTIONS_GET(
      launchOptionsRequest("task-flowissue"),
    );
    const body = (await res.json()) as {
      launchability: { launchable: boolean; reason: string };
      relaunch: { launchable: boolean; reason: string };
    };

    expect(body.relaunch.launchable).toBe(false);
    expect(body.relaunch.reason).toBe("not_enabled");
    // Mirrors the manual verdict — both surface the flow issue.
    expect(body.launchability.reason).toBe("not_enabled");
  });
});
