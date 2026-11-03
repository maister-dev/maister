import type { LaunchRunInput, LaunchRunContext } from "@/lib/services/runs";
import type { PlatformStatus } from "@/types/platform-status";

import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";

import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
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
import { launchEvaluationEngineFixture } from "@/test-support/evaluation-engine-launch";
import {
  launchEngineResponse,
  launchQualifiedEngineRun,
  bindAcceptedEngineFixture,
} from "@/test-support/launch-engine-response";
import {
  acceptInteractiveTaskLaunch,
  taskLaunchSettingsToken,
} from "@/lib/tasks/launch-intent";
import { interactiveTaskLaunchPrincipal } from "@/lib/tasks/admission-types";
import { MaisterError } from "@/lib/errors";
import { releaseAssignmentForRun } from "@/lib/execution-host/assignments";
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

// M18 Phase 1 — RED until migration 0021 + launchRun branch persistence land.
// Real Postgres (Testcontainers) + real DB writes; the git side of the worktree
// module is mocked so the workspace-row persistence is what is asserted:
//   - a launch with explicit baseBranch/targetBranch persists base_branch,
//     base_commit, target_branch, promotion_mode on the workspaces row.
//   - promotion_mode reflects the project's promotion_mode (SET) and the
//     local_merge default (CLEAR).
//   - the ext launch (POST /api/v1/ext/runs) threads the same branch fields.

const schema = schemaModule as unknown as Record<string, any>;

let testDatabase: StartedPostgresTestDb;
const repositories: string[] = [];
let restoreEngineRuntime: (() => Promise<void>) | undefined;
let db: NodePgDatabase<typeof schemaModule>;

const sessionRef: { value: unknown } = { value: null };

vi.mock("@/auth", () => ({
  auth: vi.fn(async () => sessionRef.value),
  signIn: vi.fn(),
  signOut: vi.fn(),
  handlers: {},
}));

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));

// Runner selection and persistence are real; do not start background agents.
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
const listBranchesMock = vi.fn(async (_repo: string) => [
  "main",
  "develop",
  "release",
]);
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
    listRemoteUrls: vi.fn(async () => []),
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

// All-instruct manifest → passes the M11c enforcement gate so the launch
// reaches the worktree/workspace persistence path.
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

async function seedProject(
  id: string,
  slug: string,
  opts: { promotionMode?: string | null } = {},
): Promise<void> {
  const repoPath = await createEngineFixtureRepository();

  repositories.push(repoPath);
  await fixtureGit(repoPath, "branch", "develop");
  await fixtureGit(repoPath, "branch", "release");
  await db.insert(schema.projects).values({
    taskKey: `T${crypto.randomUUID().slice(0, 8)}`.toUpperCase(),
    id,
    slug,
    name: slug,
    repoPath,
    mainBranch: "main",
    maisterYamlPath: `/repos/${slug}/maister.yaml`,
    // M18: projects.promotion_mode (migration 0021). Setting it here is part of
    // the SET path of the §3.4 config→column symmetry assertion.
    ...(opts.promotionMode !== undefined
      ? { promotionMode: opts.promotionMode }
      : {}),
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
    installedPath: `${repoPath}/.fixture-flow`,
    setupStatus: "not_required",
    packageStatus: "Installed",
  });
  await db.insert(schema.flows).values({
    id: `flow-${id}`,
    projectId: id,
    flowRefId: "bugfix",
    source: "github.com/x/y",
    version: "v1.0.0",
    installedPath: `${repoPath}/.fixture-flow`,
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

async function seedTask(taskId: string, projectId: string): Promise<void> {
  await db.insert(schema.tasks).values({
    number: Math.trunc(Math.random() * 1e9) + 1,
    id: taskId,
    projectId,
    title: "branch task",
    prompt: "do it",
    flowId: `flow-${projectId}`,
  });
  if (taskId === "task-pr")
    await db
      .update(schema.tasks)
      .set({ baseBranch: "develop", targetBranch: "release" })
      .where(eq(schema.tasks.id, taskId));
  await seedAcceptedRepositoryQualification(testDatabase.db, projectId, taskId);
}

function runRequest(body: LaunchRunInput): LaunchRunInput {
  return body;
}

async function workspaceForRun(runId: string): Promise<Record<string, any>> {
  const rows = await db
    .select()
    .from(schema.workspaces)
    .where(eq(schema.workspaces.runId, runId));

  return rows[0];
}

async function latestRunForTask(taskId: string): Promise<Record<string, any>> {
  const rows = await db
    .select()
    .from(schema.runs)
    .where(eq(schema.runs.taskId, taskId));

  return rows[0];
}

beforeAll(async () => {
  restoreEngineRuntime = await isolateEngineFixtureRuntime();
  testDatabase = await startMainPostgresTestDb({
    databaseName: "runs_branch_test",
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

  await seedProject("proj-pr", "proj-pr", { promotionMode: "pull_request" });
  await seedTask("task-pr", "proj-pr");

  await seedProject("proj-default", "proj-default");
  await seedTask("task-default", "proj-default");
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
  removeWorktreeMock.mockClear();
  listBranchesMock.mockClear();
  resolveBaseCommitMock.mockClear();
  sessionRef.value = { user: { id: "u-member", role: "member" } };
});

describe("Delivery engine — launch-time branch persistence (M18, integration)", () => {
  it("persists base_branch/base_commit/target_branch/promotion_mode on the workspace row", async () => {
    const res = await launchResponse(
      runRequest({
        taskId: "task-pr",
        baseBranch: "develop",
        targetBranch: "release",
      }),
    );

    expect(res.status).toBe(202);

    const run = await latestRunForTask("task-pr");
    const ws = await workspaceForRun(run.id);

    const [project] = await db
      .select()
      .from(schema.projects)
      .where(eq(schema.projects.id, "proj-pr"));
    const checkedSha = await fixtureGit(
      project.repoPath,
      "rev-parse",
      "develop",
    );

    expect(ws.baseBranch).toBe("develop");
    expect(ws.baseCommit).toBe(checkedSha);
    expect(ws.targetBranch).toBe("release");
    // proj-pr's projects.promotion_mode = 'pull_request' (SET path, §3.4).
    expect(ws.promotionMode).toBe("pull_request");
    expect(addWorktreeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        startPoint: checkedSha,
      }),
    );
  });

  it("defaults promotion_mode to local_merge when the project has none, and target to the base", async () => {
    const res = await launchResponse(runRequest({ taskId: "task-default" }));

    expect(res.status).toBe(202);

    const run = await latestRunForTask("task-default");
    const ws = await workspaceForRun(run.id);

    expect(ws.baseBranch).toBe("main");
    expect(ws.targetBranch).toBe("main");
    expect(ws.promotionMode).toBe("local_merge");
  });
});

describe("Delivery engine — inherited session runners", () => {
  it.each(["platform", "task", "launch", "session"] as const)(
    "persists the %s choice for compatible unbound sessions",
    async (source) => {
      const projectId = `sessions-${source}`;
      const taskId = `task-${projectId}`;
      const taskRunnerId = `claude-task-${source}`;
      const launchRunnerId = `claude-launch-${source}`;
      const reviewerId = `codex-${source}`;

      await db
        .insert(schema.platformAcpRunners)
        .values([
          testPlatformRunnerRow(taskRunnerId, "claude"),
          testPlatformRunnerRow(launchRunnerId, "claude"),
          testPlatformRunnerRow(reviewerId, "codex"),
        ]);
      await seedProject(projectId, projectId);
      await seedTask(taskId, projectId);
      const manifest = {
        ...instructManifest,
        sessions: {
          implement: {
            runner: {
              runner_type: "acp",
              capability_agent: "claude",
              permission_policy: "default",
            },
          },
          review: { runner: reviewerId },
        },
        nodes: [
          {
            ...instructManifest.nodes[0],
            id: "plan",
            transitions: { success: "implement" },
          },
          {
            ...instructManifest.nodes[0],
            session: "implement",
            transitions: { success: "review" },
          },
          { ...instructManifest.nodes[0], id: "review", session: "review" },
        ],
      };

      await db
        .update(schema.flowRevisions)
        .set({ manifest })
        .where(eq(schema.flowRevisions.id, `rev-${projectId}`));
      await db
        .update(schema.flows)
        .set({ manifest })
        .where(eq(schema.flows.id, `flow-${projectId}`));
      if (source !== "platform") {
        await db
          .update(schema.tasks)
          .set({ runnerId: taskRunnerId })
          .where(eq(schema.tasks.id, taskId));
      }
      if (source === "session") {
        await db
          .update(schema.platformAcpRunners)
          .set({ enabled: false })
          .where(eq(schema.platformAcpRunners.id, taskRunnerId));
      }
      const response =
        source === "session"
          ? null
          : await launchResponse(
              runRequest({
                taskId,
                ...(source === "launch" ? { runnerId: launchRunnerId } : {}),
              }),
            );
      const body = response
        ? await response.json()
        : await launchEvaluationEngineFixture(
            testDatabase.db,
            {
              taskId,
              sessionRunnerOverrides: {
                default: launchRunnerId,
                implement: launchRunnerId,
              },
            },
            { actorUserId: "u-member", authorize: async () => undefined },
          );

      if (response) expect(response.status, JSON.stringify(body)).toBe(202);
      const sessions = await db
        .select()
        .from(schema.runSessions)
        .where(eq(schema.runSessions.runId, body.runId));
      const chosen =
        source === "launch"
          ? launchRunnerId
          : source !== "platform"
            ? taskRunnerId
            : "claude-default";

      expect(
        Object.fromEntries(
          sessions.map((session) => [session.sessionName, session.runnerId]),
        ),
      ).toEqual({
        default: source === "session" ? launchRunnerId : chosen,
        implement: source === "session" ? launchRunnerId : chosen,
        review: reviewerId,
      });
    },
  );
});

async function configuredEngineCase(
  label: string,
): Promise<{ taskId: string; projectId: string; repo: string }> {
  const projectId = `${label}-${randomUUID()}`;
  const taskId = randomUUID();

  await seedProject(projectId, projectId);
  await seedTask(taskId, projectId);
  const [project] = await db
    .select()
    .from(schema.projects)
    .where(eq(schema.projects.id, projectId));

  return { taskId, projectId, repo: project.repoPath };
}

async function manualEngineRun(
  taskId: string,
): Promise<{ runId: string; status: string }> {
  const [task] = await db
    .select()
    .from(schema.tasks)
    .where(eq(schema.tasks.id, taskId));
  const receipt = await acceptInteractiveTaskLaunch(
    testDatabase.db,
    await interactiveTaskLaunchPrincipal(),
    {
      taskId,
      expectedTaskRevision: task.revision,
      expectedSettingsToken: await taskLaunchSettingsToken(
        testDatabase.db,
        taskId,
      ),
    },
    randomUUID(),
  );

  return bindAcceptedEngineFixture(testDatabase.db, receipt);
}

async function terminalEngineHistory(
  taskId: string,
  status: "Failed" | "Abandoned" | "Crashed" | "Done",
): Promise<void> {
  const bound = await launchQualifiedEngineRun(
    { taskId },
    engineContext,
    testDatabase.db,
  );

  await db.transaction(async (tx) => {
    await releaseAssignmentForRun(
      tx,
      bound.runId,
      "technical fixture terminal history",
    );
    await tx
      .update(schema.runs)
      .set({ status, endedAt: new Date() })
      .where(eq(schema.runs.id, bound.runId));
  });
}

const engineContext = {
  actorUserId: "u-member",
  authorize: async () => undefined,
};

describe("canonical engine consumer contracts retained from the generic launcher", () => {
  it("snapshots supervised/unattended and Brain choices while enforcing current unattended permission and blind-ship refusal", async () => {
    const scopedContext: LaunchRunContext = {
      actorUserId: "u-member",
      authorize: async (_projectId, action) => {
        if (action === "launchUnattended")
          throw new MaisterError(
            "UNAUTHORIZED",
            "Fixture caller does not grant unattended launch",
          );
      },
    };

    for (const brainContext of [undefined, true] as const) {
      const item = await configuredEngineCase("policy");
      const launched = await launchQualifiedEngineRun(
        {
          taskId: item.taskId,
          ...(brainContext === undefined ? {} : { brainContext }),
        },
        scopedContext,
        testDatabase.db,
      );
      const [run] = await db
        .select()
        .from(schema.runs)
        .where(eq(schema.runs.id, launched.runId));

      expect(run.executionPolicy).toEqual({ preset: "supervised" });
      expect(run.brainContext).toBe(brainContext ?? null);
    }
    const denied = await configuredEngineCase("policy-denied");

    await expect(
      launchQualifiedEngineRun(
        { taskId: denied.taskId, executionPolicy: { preset: "unattended" } },
        scopedContext,
        testDatabase.db,
      ),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(
      await db
        .select()
        .from(schema.runs)
        .where(eq(schema.runs.taskId, denied.taskId)),
    ).toEqual([]);
    const owned = await configuredEngineCase("policy-owned");

    await db
      .update(schema.projectMembers)
      .set({ role: "owner" })
      .where(eq(schema.projectMembers.projectId, owned.projectId));
    const launched = await launchQualifiedEngineRun(
      { taskId: owned.taskId, executionPolicy: { preset: "unattended" } },
      engineContext,
      testDatabase.db,
    );
    const [run] = await db
      .select()
      .from(schema.runs)
      .where(eq(schema.runs.id, launched.runId));

    expect(run.executionPolicy).toMatchObject({ preset: "unattended" });
    const blind = await configuredEngineCase("blind-ship");

    await expect(
      launchQualifiedEngineRun(
        {
          taskId: blind.taskId,
          executionPolicy: {
            preset: "unattended",
            overrides: { checks: "skip" },
          },
        },
        engineContext,
        testDatabase.db,
      ),
    ).rejects.toMatchObject({ code: "PRECONDITION" });
    expect(
      await db
        .select()
        .from(schema.runs)
        .where(eq(schema.runs.taskId, blind.taskId)),
    ).toEqual([]);
  });

  it("binds a task base/default target and explicit reachable SHA, and rejects unknown targets and unreachable commits before allocation", async () => {
    const item = await configuredEngineCase("branch-default");

    await db
      .update(schema.tasks)
      .set({ baseBranch: "develop", targetBranch: null })
      .where(eq(schema.tasks.id, item.taskId));
    await seedAcceptedRepositoryQualification(
      testDatabase.db,
      item.projectId,
      item.taskId,
    );
    const sha = await fixtureGit(item.repo, "rev-parse", "develop");
    const launched = await launchQualifiedEngineRun(
      { taskId: item.taskId, baseCommit: sha },
      engineContext,
      testDatabase.db,
    );
    const workspace = await workspaceForRun(launched.runId);

    expect(workspace).toMatchObject({
      baseBranch: "develop",
      targetBranch: "develop",
      baseCommit: sha,
    });
    expect(await fixtureGit(workspace.worktreePath, "rev-parse", "HEAD")).toBe(
      sha,
    );
    for (const selector of [
      "baseBranch",
      "targetBranch",
      "baseCommit",
    ] as const) {
      const refused = await configuredEngineCase(`bad-${selector}`);
      const [before] = await db
        .select()
        .from(schema.tasks)
        .where(eq(schema.tasks.id, refused.taskId));
      const tree = await fixtureGit(refused.repo, "rev-parse", "HEAD^{tree}");
      const unreachable = await fixtureGit(
        refused.repo,
        "commit-tree",
        tree,
        "-m",
        "Unreachable admission control",
      );
      const input = {
        taskId: refused.taskId,
        [selector]: selector === "baseCommit" ? unreachable : "unknown-branch",
      };

      const refusal = launchQualifiedEngineRun(
        input,
        engineContext,
        testDatabase.db,
      );

      await expect(refusal).rejects.toBeInstanceOf(MaisterError);
      await expect(refusal).rejects.toMatchObject({ code: "PRECONDITION" });
      const [after] = await db
        .select()
        .from(schema.tasks)
        .where(eq(schema.tasks.id, refused.taskId));

      expect(after.attemptNumber).toBe(before.attemptNumber);
      expect(
        await db
          .select()
          .from(schema.runs)
          .where(eq(schema.runs.taskId, refused.taskId)),
      ).toEqual([]);
      expect(
        await db
          .select()
          .from(schema.workspaces)
          .where(eq(schema.workspaces.projectId, refused.projectId)),
      ).toEqual([]);
    }
  });

  it("keeps retryable historical statuses launchable, refuses busy remnants, and authorizes before classification", async () => {
    for (const [taskStatus, sourceStatus] of [
      ["InFlight", "Failed"],
      ["Backlog", "Abandoned"],
      ["InFlight", "Crashed"],
      ["Done", "Done"],
    ] as const) {
      const item = await configuredEngineCase("historical");

      await terminalEngineHistory(item.taskId, sourceStatus);
      await db
        .update(schema.tasks)
        .set({ status: taskStatus })
        .where(eq(schema.tasks.id, item.taskId));
      expect((await manualEngineRun(item.taskId)).runId).toBeTruthy();
    }
    for (const active of [false, true]) {
      const item = await configuredEngineCase("busy");

      if (active)
        await launchQualifiedEngineRun(
          { taskId: item.taskId },
          engineContext,
          testDatabase.db,
        );
      else
        await db
          .update(schema.tasks)
          .set({ status: "InFlight" })
          .where(eq(schema.tasks.id, item.taskId));
      const beforeWorkspaces = await db
        .select()
        .from(schema.workspaces)
        .where(eq(schema.workspaces.projectId, item.projectId));

      await expect(
        launchQualifiedEngineRun(
          { taskId: item.taskId },
          engineContext,
          testDatabase.db,
        ),
      ).rejects.toMatchObject({ name: "MaisterError" });
      expect(
        await db
          .select()
          .from(schema.workspaces)
          .where(eq(schema.workspaces.projectId, item.projectId)),
      ).toEqual(beforeWorkspaces);
      const denied = new Error("fixture denied before classification");

      await expect(
        launchQualifiedEngineRun(
          { taskId: item.taskId },
          {
            actorUserId: "u-member",
            authorize: async () => {
              throw denied;
            },
          },
          testDatabase.db,
        ),
      ).rejects.toBe(denied);
    }
  });

  it("allows an explicit human run-again of an Abandoned task while refusing automatic admission of that task", async () => {
    const item = await configuredEngineCase("abandoned");

    await terminalEngineHistory(item.taskId, "Crashed");
    await db
      .update(schema.tasks)
      .set({ status: "Abandoned" })
      .where(eq(schema.tasks.id, item.taskId));
    await expect(
      launchQualifiedEngineRun(
        { taskId: item.taskId },
        engineContext,
        testDatabase.db,
      ),
    ).rejects.toMatchObject({ code: "PRECONDITION" });
    const [task] = await db
      .select()
      .from(schema.tasks)
      .where(eq(schema.tasks.id, item.taskId));
    const receipt = await acceptInteractiveTaskLaunch(
      testDatabase.db,
      await interactiveTaskLaunchPrincipal(),
      {
        taskId: item.taskId,
        expectedTaskRevision: task.revision,
        expectedSettingsToken: await taskLaunchSettingsToken(
          testDatabase.db,
          item.taskId,
        ),
      },
      randomUUID(),
    );
    const bound = await bindAcceptedEngineFixture(testDatabase.db, receipt);
    const [run] = await db
      .select()
      .from(schema.runs)
      .where(eq(schema.runs.id, bound.runId));

    expect(run.taskAdmissionSnapshot).toMatchObject({
      version: 2,
      mode: "manual",
      basis: "manual",
      intentId: receipt.intentId,
    });
  });
});
