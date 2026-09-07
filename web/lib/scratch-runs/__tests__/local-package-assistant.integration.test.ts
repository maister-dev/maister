// M36 Phase 5 (ADR-097): the project-less scratch-at-local-package run is the
// riskiest change in the plan — a run with runs.project_id NULL must NOT crash
// any run_kind consumer. This suite is the fan-out guard against a real
// Postgres testcontainer:
//   - the scratch_runs XOR CHECK rejects both-set and neither-set owners;
//   - run-kind-invariants admits the local-package-only variant;
//   - runReconcileSweep does NOT mark a project-less run Crashed even though it
//     is in NO project's `git worktree list` (it has no workspace row);
//   - the reconcile classifier routes a project-less scratch run to skip on a
//     live session and never to reattach (resume-driver), matching the
//     project-scratch contract;
//   - a launched run snapshots runs.local_package_id and emits NOTHING
//     project-scoped on a terminal transition (markScratchCrashed no-ops the
//     domain/webhook outbox for a null project).

import type { WorktreeInfo } from "@/lib/worktree";

import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { and, eq, isNull } from "drizzle-orm";
import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import * as schemaModule from "@/lib/db/schema";
import { testPlatformRunnerRow } from "@/lib/__tests__/runner-fixtures";
import { acquireLock, assertHoldsLock } from "@/lib/local-packages/lock";
import { settlePendingFlowAssistantActions } from "@/lib/studio/flow-assistant/turn";
import { classifyRunReconcile, runReconcileSweep } from "@/lib/reconcile";
import { assertRunScratchMetadataInvariant } from "@/lib/runs/run-kind-invariants";
import { parseScratchMessageContent } from "@/lib/scratch-runs/transcript";
import { FLOW_ASSISTANT_ACTION_SCHEMA_VERSION } from "@/lib/studio/flow-assistant/protocol";
import { packageFileHash } from "@/lib/studio/flow-assistant/actions";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";
import {
  createFakeExecutionHost,
  fakeExecutionHosts,
  type FakeExecutionHost,
} from "@/test-support/fake-execution-host";

// markScratchCrashed lives in scratch-runs/service, which transitively imports
// @/lib/authz → next-auth. Mock authz + the db client (same pattern as
// workbench-stop.integration.test.ts) so the service is importable under
// vitest, then dynamic-import it in beforeAll after the mocks are installed.
vi.mock("@/lib/db/client", () => ({ getDb: () => db }));
vi.mock("@/lib/authz", () => ({
  requireActiveSession: vi.fn(async () => ({
    id: "lp-user",
    email: "lp@test",
    role: "admin",
  })),
  requireProjectAction: vi.fn(async () => undefined),
}));

// The supervisor is stubbed: the launch + turn path never spawns a real ACP
// session. `createSession`/`sendPrompt`/`streamSession`/`deleteSession` are
// mutable so each test drives launch success, a file-writing "turn", or a turn
// failure (to assert the deferred-release tears the session down). `events.ts`
// builds its default api from these imports, so this mock covers the turn path.
// `vi.hoisted` so the (hoisted) `vi.mock` factory below can reference it.
const supervisorMock = vi.hoisted(() => ({
  createSession: vi.fn(),
  deleteSession: vi.fn(),
  checkSupervisorHealth: vi.fn(),
  streamSession: vi.fn(),
  sendPrompt: vi.fn(),
  cancelPermission: vi.fn(),
  listSessions: vi.fn(),
}));

// Partial: the execution-host transport binds the whole client surface at
// module load; only the members this suite scripts are replaced.
vi.mock("@/lib/supervisor-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/supervisor-client")>()),
  ...supervisorMock,
}));

let markScratchCrashed: typeof import("@/lib/scratch-runs/service").markScratchCrashed;
let launchLocalPackageAssistant: typeof import("@/lib/scratch-runs/service").launchLocalPackageAssistant;
let launchLocalPackageAssistantStaged: typeof import("@/lib/scratch-runs/service").launchLocalPackageAssistantStaged;
let sendLocalPackageAssistantMessage: typeof import("@/lib/scratch-runs/service").sendLocalPackageAssistantMessage;
let listLocalPackageAssistantRunners: typeof import("@/lib/scratch-runs/service").listLocalPackageAssistantRunners;
let stopScratchWorkbench: typeof import("@/lib/scratch-runs/service").stopScratchWorkbench;
let createLocalPackage: typeof import("@/lib/local-packages/service").createLocalPackage;
let diffWorkingDir: typeof import("@/lib/local-packages/service").diffWorkingDir;
let getLocalPackage: typeof import("@/lib/local-packages/service").getLocalPackage;

const schema = schemaModule as unknown as Record<string, any>;
const {
  domainEvents,
  localPackages,
  runs,
  runSessions,
  scratchMessages,
  scratchRuns,
  webhookEvents,
} = schema;

let container: StartedPostgresTestDb["container"];
let testDatabase: StartedPostgresTestDb;
let db: NodePgDatabase;
let originalDbUrl: string | undefined;
let originalHome: string | undefined;
let homeDir: string;
let userId: string;
let runnerId: string;
let localPackageId: string;
let fake: FakeExecutionHost;

const RECON_GRACE_SECONDS = 90;

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "lp_assistant_test",
  });
  container = testDatabase.container;
  db = testDatabase.db;
  // ADR-166: the assistant launch/turn/stop ride the execution-host client; a
  // fake host registered as THE local host routes every wire call to this
  // suite's mutable supervisor spies (handle-form payloads on the wire).
  fake = createFakeExecutionHost();

  Object.assign(fake.transport, {
    createSession: async (envelope: {
      command: { id: string };
      fence: { runId: string; assignmentEpoch: number };
      payload: {
        executionWorkspaceId: string;
        stepId?: string;
        sessionName?: string;
      };
    }) => {
      const result = (await supervisorMock.createSession(envelope.payload)) as {
        sessionId: string;
        pid: number;
        acpSessionId: string;
      };

      fake.sessions.set(result.sessionId, {
        sessionId: result.sessionId,
        runId: envelope.fence.runId,
        stepId: envelope.payload.stepId ?? "assistant",
        sessionName: envelope.payload.sessionName ?? "default",
        acpSessionId: result.acpSessionId,
        executionWorkspaceId: envelope.payload.executionWorkspaceId,
        assignmentEpoch: envelope.fence.assignmentEpoch,
        createdByCommandId: envelope.command.id,
        status: "live",
      });

      return result;
    },
    streamSession: (sessionId: string, opts?: unknown) =>
      supervisorMock.streamSession(sessionId, opts),
    listSessions: () => supervisorMock.listSessions(),
    deleteSession: async (sessionId: string) => {
      await supervisorMock.deleteSession(sessionId);

      return { outcome: "terminated" as const };
    },
    deliverInput: async (
      sessionId: string,
      envelope: { payload: { requestId: string; reason?: string } },
    ) => {
      await supervisorMock.cancelPermission(
        sessionId,
        envelope.payload.requestId,
        envelope.payload.reason,
      );

      return { ok: true as const, replayed: false };
    },
  });
  fake.setPromptBehavior(async ({ sessionId, envelope }) => {
    const result = await supervisorMock.sendPrompt(sessionId, envelope.payload);

    for await (const event of supervisorMock.streamSession(sessionId)) {
      fake.pushEvent(sessionId, event);
    }

    return result;
  });
  await fakeExecutionHosts(db, { fake });

  ({
    markScratchCrashed,
    launchLocalPackageAssistant,
    launchLocalPackageAssistantStaged,
    sendLocalPackageAssistantMessage,
    listLocalPackageAssistantRunners,
    stopScratchWorkbench,
  } = await import("@/lib/scratch-runs/service"));
  ({ createLocalPackage, diffWorkingDir, getLocalPackage } = await import(
    "@/lib/local-packages/service"
  ));

  originalDbUrl = process.env.DB_URL;
  process.env.DB_URL = container.getConnectionUri();
  // createLocalPackage scaffolds + git-inits a real working dir under
  // ~/.maister/local — point HOME at a temp dir for the launch/turn tests.
  originalHome = process.env.HOME;
  homeDir = await mkdtemp(join(tmpdir(), "lp-assistant-home-"));
  process.env.HOME = homeDir;

  userId = "lp-user";
  runnerId = randomUUID();

  await db.insert(schema.users).values({
    id: userId,
    email: `lp-${userId}@maister.local`,
    role: "member",
    accountStatus: "active",
  });
  await db
    .insert(schema.platformAcpRunners)
    .values(testPlatformRunnerRow(runnerId, "claude"));
  // launchLocalPackageAssistant resolves the platform-default runner.
  await db.insert(schema.platformRuntimeSettings).values({
    id: "singleton",
    defaultRunnerId: runnerId,
  });

  const lpRows = await db
    .insert(localPackages)
    .values({
      name: "Bugfix Local",
      slug: `bugfix-local-${randomUUID().slice(0, 8)}`,
      workingDir: `/Users/test/.maister/local/bugfix-${randomUUID().slice(0, 8)}`,
      status: "active",
      createdBy: userId,
    })
    .returning({ id: localPackages.id });

  localPackageId = lpRows[0].id;
}, 180_000);

afterAll(async () => {
  if (originalDbUrl === undefined) delete process.env.DB_URL;
  else process.env.DB_URL = originalDbUrl;
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  await testDatabase?.stop();
  await rm(homeDir, { recursive: true, force: true }).catch(() => undefined);
});

beforeEach(async () => {
  await db.delete(domainEvents);
  await db.delete(webhookEvents);
  await db.delete(scratchRuns);
  await db.delete(runs);

  // Reset the supervisor stub to its happy-path defaults each test.
  supervisorMock.createSession.mockReset().mockResolvedValue({
    sessionId: "sup-1",
    pid: 1,
    acpSessionId: "acp-1",
  });
  supervisorMock.deleteSession.mockReset().mockResolvedValue(undefined);
  supervisorMock.checkSupervisorHealth
    .mockReset()
    .mockResolvedValue({ kind: "ready", health: {} });
  supervisorMock.streamSession
    .mockReset()
    .mockImplementation(async function* () {
      return;
    });
  supervisorMock.sendPrompt
    .mockReset()
    .mockResolvedValue({ stopReason: "end_turn" });
  supervisorMock.cancelPermission.mockReset().mockResolvedValue({ ok: true });
  supervisorMock.listSessions.mockReset().mockResolvedValue([]);
});

// Insert a project-less local-package scratch run mirroring the single launch
// insert in launchLocalPackageAssistant (no project, no workspace row).
async function seedLocalPackageRun(
  opts: {
    status?: string;
    dialogStatus?: string;
    acpSessionId?: string | null;
    startedAt?: Date;
  } = {},
): Promise<string> {
  const runId = randomUUID();

  await db.insert(runs).values({
    id: runId,
    runKind: "scratch",
    taskId: null,
    projectId: null,
    localPackageId,
    flowId: null,
    runnerId,
    capabilityAgent: "claude",
    status: opts.status ?? "Running",
    acpSessionId: opts.acpSessionId ?? null,
    currentStepId: "scratch",
    flowVersion: "scratch",
    flowRevision: "manual",
    flowRevisionId: null,
    createdByUserId: userId,
    startedAt: opts.startedAt ?? new Date(),
  });
  await db.insert(scratchRuns).values({
    runId,
    projectId: null,
    localPackageId,
    name: "assistant",
    initialPrompt: "edit the flow",
    baseBranch: "main",
    baseCommit: "deadbeef",
    targetBranch: "main",
    dialogStatus: opts.dialogStatus ?? "Running",
    createdByUserId: userId,
  });

  return runId;
}

describe("listLocalPackageAssistantRunners", () => {
  it("labels ready runners by runner id and model", async () => {
    const result = await listLocalPackageAssistantRunners(db);
    const option = result.runners.find((runner) => runner.id === runnerId);

    expect(option?.label).toBe(`${runnerId} · claude-sonnet-4-6`);
  });
});

describe("scratch_runs owner XOR CHECK (ADR-097)", () => {
  it("accepts a project-less local-package row (local_package_id only)", async () => {
    const runId = await seedLocalPackageRun();
    const rows = await db
      .select({ localPackageId: scratchRuns.localPackageId })
      .from(scratchRuns)
      .where(eq(scratchRuns.runId, runId));

    expect(rows[0].localPackageId).toBe(localPackageId);
  });

  it("rejects a row with BOTH project_id and local_package_id set", async () => {
    // A real project for the both-set attempt.
    const projectId = randomUUID();

    await db.insert(schema.projects).values({
      id: projectId,
      slug: `both-${randomUUID().slice(0, 8)}`,
      name: "Both",
      repoPath: `/repos/both-${randomUUID()}`,
      taskKey: `B${randomUUID().slice(0, 7)}`.toUpperCase(),
    });

    const runId = randomUUID();

    await db.insert(runs).values({
      id: runId,
      runKind: "scratch",
      projectId,
      localPackageId,
      status: "Running",
      currentStepId: "scratch",
      flowVersion: "scratch",
      flowRevision: "manual",
      createdByUserId: userId,
    });

    await expect(
      db.insert(scratchRuns).values({
        runId,
        projectId,
        localPackageId,
        name: "both",
        initialPrompt: "x",
        baseBranch: "main",
        baseCommit: "deadbeef",
        dialogStatus: "Running",
        createdByUserId: userId,
      }),
    ).rejects.toThrow(/scratch_runs_owner_xor_check/);

    await db.delete(runs).where(eq(runs.id, runId));
    await db.delete(schema.projects).where(eq(schema.projects.id, projectId));
  });

  it("rejects a row with NEITHER project_id nor local_package_id set", async () => {
    const runId = randomUUID();

    await db.insert(runs).values({
      id: runId,
      runKind: "scratch",
      projectId: null,
      localPackageId: null,
      status: "Running",
      currentStepId: "scratch",
      flowVersion: "scratch",
      flowRevision: "manual",
      createdByUserId: userId,
    });

    await expect(
      db.insert(scratchRuns).values({
        runId,
        projectId: null,
        localPackageId: null,
        name: "neither",
        initialPrompt: "x",
        baseBranch: "main",
        baseCommit: "deadbeef",
        dialogStatus: "Running",
        createdByUserId: userId,
      }),
    ).rejects.toThrow(/scratch_runs_owner_xor_check/);

    await db.delete(runs).where(eq(runs.id, runId));
  });
});

describe("run-kind-invariants admit the project-less variant (ADR-097)", () => {
  it("admits a local-package-only scratch run", () => {
    expect(() =>
      assertRunScratchMetadataInvariant({
        runKind: "scratch",
        scratchRunId: "run-1",
        projectId: null,
        localPackageId,
      }),
    ).not.toThrow();
  });
});

describe("launch snapshots runs.local_package_id (ADR-097)", () => {
  it("carries the local package id on the runs row", async () => {
    const runId = await seedLocalPackageRun();
    const rows = await db
      .select({
        projectId: runs.projectId,
        localPackageId: runs.localPackageId,
        runKind: runs.runKind,
      })
      .from(runs)
      .where(eq(runs.id, runId));

    expect(rows[0]).toEqual({
      projectId: null,
      localPackageId,
      runKind: "scratch",
    });
  });
});

describe("reconcile does NOT crash a project-less run (ADR-097)", () => {
  it("leaves a project-less run untouched even with NO worktree and NO live session", async () => {
    const runId = await seedLocalPackageRun({ status: "Running" });

    // No project ⇒ loadCandidates iterates projects and never selects this run
    // (it has project_id NULL); listWorktrees/listSessions are empty.
    const listWorktrees = async (): Promise<WorktreeInfo[]> => [];

    const summary = await runReconcileSweep({
      db,
      listWorktrees,
      runFlow: () => {
        throw new Error("runFlow must not be called for a project-less run");
      },
      scheduleResumedSessionDrive: () => {
        throw new Error("resume driver must not run for a project-less run");
      },
    });

    expect(summary.crashed).toBe(0);

    const rows = await db
      .select({ status: runs.status })
      .from(runs)
      .where(eq(runs.id, runId));

    expect(rows[0].status).toBe("Running");
  });

  it("classifier skips a live project-less scratch session and never reattaches", () => {
    const decision = classifyRunReconcile({
      runStatus: "Running",
      runKind: "scratch",
      acpSessionId: "acp-1",
      currentStepId: "scratch",
      currentNodeKind: null,
      worktreeExists: true,
      liveSession: true,
      resumeStartedAt: null,
      latestAttemptStartedAt: null,
      nowMs: Date.now(),
      graceSeconds: RECON_GRACE_SECONDS,
    });

    expect(decision.action).toBe("skip");
    expect(decision.reason).toBe("live-scratch-session");
  });
});

describe("terminal transition emits nothing project-scoped (ADR-097)", () => {
  it("markScratchCrashed crashes a project-less run without a domain/webhook emit", async () => {
    const runId = await seedLocalPackageRun({ status: "Running" });

    await markScratchCrashed({
      db,
      runId,
      err: new Error("boom"),
    });

    const runRows = await db
      .select({ status: runs.status })
      .from(runs)
      .where(eq(runs.id, runId));
    const scratchRows = await db
      .select({ dialogStatus: scratchRuns.dialogStatus })
      .from(scratchRuns)
      .where(eq(scratchRuns.runId, runId));

    expect(runRows[0].status).toBe("Crashed");
    expect(scratchRows[0].dialogStatus).toBe("Crashed");

    // No project ⇒ NO project-scoped outbox rows for this run.
    const domainRows = await db
      .select({ id: domainEvents.id })
      .from(domainEvents)
      .where(eq(domainEvents.runId, runId));
    const webhookRows = await db
      .select({ id: webhookEvents.id })
      .from(webhookEvents)
      .where(eq(webhookEvents.runId, runId));

    expect(domainRows).toHaveLength(0);
    expect(webhookRows).toHaveLength(0);
  });
});

describe("project-less rows are invisible to project-scoped queries (ADR-097)", () => {
  it("a project-less scratch run never appears with a non-null project_id", async () => {
    await seedLocalPackageRun();

    const projectScoped = await db
      .select({ id: runs.id })
      .from(runs)
      .where(and(eq(runs.runKind, "scratch"), isNull(runs.projectId)));

    expect(projectScoped.length).toBeGreaterThanOrEqual(1);
  });
});

// --- T5.9: launch + turn at a real local-package working dir ----------------

describe("launchLocalPackageAssistant + a turn (ADR-097 T5.7)", () => {
  it("launches read-only and applies a streamed structured action in place", async () => {
    const pkg = await createLocalPackage({
      name: `assistant-launch-${randomUUID().slice(0, 8)}`,
      createdBy: userId,
      db: db as never,
    });

    streamAssistantText(
      assistantActionMarkdown({
        actionId: "act_launch",
        summary: "Add launch flow",
        path: "flows/new/flow.yaml",
        content: validFlowYaml("new"),
      }),
    );
    const sessionId = await lockLocalPackage(pkg.id, "assistant-launch");

    const result = await launchLocalPackageAssistant({
      body: { localPackageId: pkg.id, sessionId, prompt: "add a flow" },
      userId,
    });

    expect(result.runId).toBeTruthy();
    expect(result.actionResult?.status).toBe("applied");
    expect(supervisorMock.createSession).toHaveBeenCalledTimes(1);
    // The launch confines the session to the working dir (no repo/worktree
    // widening) and the ACP adapter is read-only; mutations only happen through
    // the server-side structured action apply path.
    const createArg = (
      supervisorMock.createSession.mock.calls as unknown as Array<
        [
          {
            confineRoot?: string;
            readOnlySession?: boolean;
            worktreePath?: string;
          },
        ]
      >
    )[0][0];

    // ADR-166 (Q4): the confinement rides the adopted handle — the package
    // working dir is adopted as a `directory` workspace; the create carries
    // only the read-only flag, never a path.
    expect(createArg).toMatchObject({ readOnlySession: true });
    expect(createArg).not.toHaveProperty("worktreePath");
    expect(createArg).not.toHaveProperty("confineRoot");
    const adopts = fake
      .callsOf("adoptWorkspace")
      .map((call) => call.envelope?.payload as { kind: string; path: string });

    expect(adopts.at(-1)).toMatchObject({
      kind: "directory",
      path: pkg.workingDir,
    });

    // The run is project-less and snapshots the local package id.
    const runRows = await db
      .select({
        projectId: runs.projectId,
        localPackageId: runs.localPackageId,
      })
      .from(runs)
      .where(eq(runs.id, result.runId));

    expect(runRows[0]).toEqual({ projectId: null, localPackageId: pkg.id });
    // ADR-166: the launch tx mints exactly ONE `launch` generation (epoch 1).
    expect(
      await db
        .select({
          epoch: schema.executionAssignments.epoch,
          state: schema.executionAssignments.state,
          placementReason: schema.executionAssignments.placementReason,
        })
        .from(schema.executionAssignments)
        .where(eq(schema.executionAssignments.runId, result.runId)),
    ).toEqual([{ epoch: 1, state: "active", placementReason: "launch" }]);

    const messages = await db
      .select({
        role: scratchMessages.role,
        content: scratchMessages.content,
      })
      .from(scratchMessages)
      .where(eq(scratchMessages.runId, result.runId));
    const assistantRows = messages.filter((row) => row.role === "assistant");

    expect(assistantRows.at(-1)?.content).not.toContain(
      "maister_flow_assistant_action",
    );
    expect(
      messages
        .map((row) => parseScratchMessageContent(row.role, row.content))
        .some((message) => message.kind === "flow_action_result"),
    ).toBe(true);

    // The server-applied action is visible in the working-tree diff (drives the
    // editor's changed-count + canvas refresh).
    const fresh = await getLocalPackage(pkg.id, db as never);
    const diff = await diffWorkingDir(fresh!);

    expect(diff.changedCount).toBeGreaterThanOrEqual(1);
    expect(diff.files.some((f) => f.path.endsWith("flows/new/flow.yaml"))).toBe(
      true,
    );
  });

  it("returns a sanitized rejected action if the editor lock is lost before apply", async () => {
    const pkg = await createLocalPackage({
      name: `assistant-lock-lost-${randomUUID().slice(0, 8)}`,
      createdBy: userId,
      db: db as never,
    });
    const sessionId = await lockLocalPackage(pkg.id, "assistant-lock-lost");

    streamAssistantText(
      assistantActionMarkdown({
        actionId: "act_lock_lost",
        summary: "Add lost-lock rule",
        path: "rules/lost-lock.md",
        content: "# lost lock\n",
      }),
    );
    supervisorMock.sendPrompt.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await acquireLock(pkg.id, userId, `${sessionId}-takeover`, db as never);

      return { stopReason: "end_turn" };
    });

    const result = await launchLocalPackageAssistant({
      body: { localPackageId: pkg.id, sessionId, prompt: "add a rule" },
      userId,
    });

    expect(result.actionResult?.status).toBe("rejected");
    expect(result.actionResult?.message).toContain("editor lock");
    await expect(
      readFile(join(pkg.workingDir, "rules", "lost-lock.md"), "utf8"),
    ).rejects.toThrow();
  });

  it("seeds the flow-authoring skill into the session working dir", async () => {
    const pkg = await createLocalPackage({
      name: `assistant-skill-${randomUUID().slice(0, 8)}`,
      createdBy: userId,
      db: db as never,
    });
    const sessionId = await lockLocalPackage(pkg.id, "assistant-skill");

    await launchLocalPackageAssistant({
      body: { localPackageId: pkg.id, sessionId, prompt: "hi" },
      userId,
    });

    // claude (cwd-dir) materializes the skill under the working dir .claude/skills.
    const skillMd = await readFile(
      join(pkg.workingDir, ".claude", "skills", "flow-authoring", "SKILL.md"),
      "utf8",
    );

    expect(skillMd).toContain("name: flow-authoring");
  });

  it("reclaims local-package assistant materialization when the session is stopped", async () => {
    const pkg = await createLocalPackage({
      name: `assistant-stop-cleanup-${randomUUID().slice(0, 8)}`,
      createdBy: userId,
      db: db as never,
    });
    const sessionId = await lockLocalPackage(pkg.id, "assistant-stop-cleanup");
    const launched = await launchLocalPackageAssistant({
      body: { localPackageId: pkg.id, sessionId, prompt: "" },
      userId,
    });
    const capabilityRoot = join(
      pkg.workingDir,
      ".maister",
      "capabilities",
      launched.runId,
    );
    const authoringSkill = join(
      pkg.workingDir,
      ".claude",
      "skills",
      "flow-authoring",
    );

    await expect(stat(capabilityRoot)).resolves.toBeDefined();
    await expect(stat(authoringSkill)).resolves.toBeDefined();

    const stopped = await stopScratchWorkbench(launched.runId, { db });

    expect(stopped).toMatchObject({
      runStatus: "Abandoned",
      dialogStatus: "Abandoned",
    });
    await expect(stat(capabilityRoot)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(stat(authoringSkill)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("compensates materialization when the pre-session run transaction fails", async () => {
    const pkg = await createLocalPackage({
      name: `assistant-insert-failure-${randomUUID().slice(0, 8)}`,
      createdBy: userId,
      db: db as never,
    });
    const sessionId = await lockLocalPackage(
      pkg.id,
      "assistant-insert-failure",
    );

    // Warm the local-host memo first so the one-shot tx fault below lands on
    // the run-insert transaction, not on a cold host registration.
    await fakeExecutionHosts(db, { fake });
    const transaction = vi
      .spyOn(db, "transaction")
      .mockRejectedValueOnce(new Error("run insert failed"));

    try {
      await expect(
        launchLocalPackageAssistant({
          body: { localPackageId: pkg.id, sessionId, prompt: "" },
          userId,
        }),
      ).rejects.toThrow("run insert failed");
    } finally {
      transaction.mockRestore();
    }

    // The invariant is "no materialized capability survives the failed launch".
    // Compensation now removes the capabilities DIRECTORY rather than emptying
    // it, so asserting `readdir(...) === []` demanded a leftover empty dir the
    // cleanup deliberately does not leave. Assert the invariant, which both
    // shapes satisfy, and which a future change to either shape still upholds.
    const capabilitiesDir = join(pkg.workingDir, ".maister", "capabilities");
    const leftovers = await readdir(capabilitiesDir).catch(
      (err: NodeJS.ErrnoException) => {
        if (err.code === "ENOENT") return [] as string[];

        throw err;
      },
    );

    expect(leftovers).toEqual([]);
    await expect(
      stat(join(pkg.workingDir, ".claude", "skills", "flow-authoring")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("a turn on the assistant run (loadScratchRows) works WITHOUT a workspace row", async () => {
    const pkg = await createLocalPackage({
      name: `assistant-turn-${randomUUID().slice(0, 8)}`,
      createdBy: userId,
      db: db as never,
    });
    const sessionId = await lockLocalPackage(pkg.id, "assistant-turn");
    const launched = await launchLocalPackageAssistant({
      body: { localPackageId: pkg.id, sessionId, prompt: "first" },
      userId,
    });

    // There is NO workspaces row for a local-package assistant run.
    const workspaceRows = await db
      .select({ runId: schema.workspaces.runId })
      .from(schema.workspaces)
      .where(eq(schema.workspaces.runId, launched.runId));

    expect(workspaceRows).toHaveLength(0);

    // A follow-up turn streams a structured action; the turn path must read the
    // cwd from the local package (not a workspace row) and let the server apply.
    streamAssistantText(
      assistantActionMarkdown({
        actionId: "act_turn",
        summary: "Add rule",
        path: "rules/more.md",
        content: "# more\n",
      }),
    );

    const res = await sendLocalPackageAssistantMessage({
      runId: launched.runId,
      body: { localPackageId: pkg.id, sessionId, content: "do more" },
    });

    expect(res.ok).toBe(true);
    expect(res.actionResult?.status).toBe("applied");

    const fresh = await getLocalPackage(pkg.id, db as never);
    const diff = await diffWorkingDir(fresh!);

    expect(diff.files.some((f) => f.path.endsWith("rules/more.md"))).toBe(true);
  });

  it("refreshes file inventory hashes before a follow-up edit", async () => {
    const pkg = await createLocalPackage({
      name: `assistant-hash-refresh-${randomUUID().slice(0, 8)}`,
      createdBy: userId,
      db: db as never,
    });
    const sessionId = await lockLocalPackage(pkg.id, "assistant-hash-refresh");
    const firstFlow = validFlowYaml("first");

    streamAssistantText(
      assistantActionMarkdown({
        actionId: "act_hash_first",
        summary: "Add review flow",
        path: "flows/review/flow.yaml",
        content: firstFlow,
      }),
    );

    const launched = await launchLocalPackageAssistant({
      body: { localPackageId: pkg.id, sessionId, prompt: "add review flow" },
      userId,
    });

    expect(launched.actionResult?.status).toBe("applied");

    const firstHash = packageFileHash(firstFlow);
    const updatedFlow = validFlowYaml("second");

    streamAssistantText(
      assistantActionMarkdown({
        actionId: "act_hash_second",
        summary: "Update review flow",
        path: "flows/review/flow.yaml",
        baseHash: firstHash,
        content: updatedFlow,
      }),
    );

    const res = await sendLocalPackageAssistantMessage({
      runId: launched.runId,
      body: {
        localPackageId: pkg.id,
        sessionId,
        content: "rename the review flow",
        focus: { path: "flows/review/flow.yaml" },
      },
    });

    const followUpPrompt = (
      supervisorMock.sendPrompt.mock.calls.at(-1)?.[1] as
        | { prompt?: string }
        | undefined
    )?.prompt;

    expect(res.actionResult?.status).toBe("applied");
    expect(followUpPrompt).toContain(
      "Prior file hashes in the conversation may be stale",
    );
    expect(followUpPrompt).toContain(
      `flows/review/flow.yaml | asset | ${firstHash}`,
    );

    await expect(
      readFile(join(pkg.workingDir, "flows", "review", "flow.yaml"), "utf8"),
    ).resolves.toBe(updatedFlow);
  });
});

describe("flow assistant action journal (S2.9)", () => {
  async function seedPendingAction(label: string) {
    const pkg = await createLocalPackage({
      name: `assistant-${label}-${randomUUID().slice(0, 8)}`,
      createdBy: userId,
      db: db as never,
    });

    streamAssistantText("no action in this turn");
    const sessionId = await lockLocalPackage(pkg.id, `assistant-${label}`);
    const launched = await launchLocalPackageAssistant({
      body: { localPackageId: pkg.id, sessionId, prompt: "hello" },
      userId,
    });
    const [message] = await db
      .select({ id: scratchMessages.id })
      .from(scratchMessages)
      .where(
        and(
          eq(scratchMessages.runId, launched.runId),
          eq(scratchMessages.role, "assistant"),
        ),
      );
    const actionId = `act_${label}`;

    // Exactly the evidence a process leaves when it dies after consuming the
    // action block but before the package apply: a sanitized message plus a
    // retained pending intent.
    await db.insert(schema.flowAssistantActions).values({
      id: randomUUID(),
      runId: launched.runId,
      localPackageId: pkg.id,
      lockGeneration: sessionId,
      messageId: message.id,
      action: {
        schemaVersion: FLOW_ASSISTANT_ACTION_SCHEMA_VERSION,
        actionId,
        summary: "Add recovered flow",
        operations: [
          {
            op: "upsert_file",
            path: `flows/${label}/flow.yaml`,
            baseHash: null,
            content: validFlowYaml(label),
          },
        ],
      },
    });

    return { pkg, sessionId, runId: launched.runId, label };
  }

  it("owner-scratch-package-recovery: a retained action applies exactly once", async () => {
    const seeded = await seedPendingAction("recovered");
    const fresh = await getLocalPackage(seeded.pkg.id, db as never);

    expect((await diffWorkingDir(fresh!)).changedCount).toBe(0);
    const applied = await settlePendingFlowAssistantActions({
      db: db as never,
      localPackage: fresh!,
      runId: seeded.runId,
      lockGeneration: seeded.sessionId,
      assertCanApply: () =>
        assertHoldsLock(seeded.pkg.id, seeded.sessionId, db as never),
    });

    expect(applied?.status).toBe("applied");
    const [row] = await db
      .select()
      .from(schema.flowAssistantActions)
      .where(eq(schema.flowAssistantActions.runId, seeded.runId));

    expect(row.state).toBe("applied");
    const afterFirst = await diffWorkingDir(
      (await getLocalPackage(seeded.pkg.id, db as never))!,
    );

    expect(
      afterFirst.files.some((file) =>
        file.path.endsWith("flows/recovered/flow.yaml"),
      ),
    ).toBe(true);

    // A second recovery pass is a no-op: the settled intent is never re-applied.
    expect(
      await settlePendingFlowAssistantActions({
        db: db as never,
        localPackage: fresh!,
        runId: seeded.runId,
        lockGeneration: seeded.sessionId,
        assertCanApply: () =>
          assertHoldsLock(seeded.pkg.id, seeded.sessionId, db as never),
      }),
    ).toBeNull();
    const results = await db
      .select({ content: scratchMessages.content })
      .from(scratchMessages)
      .where(
        and(
          eq(scratchMessages.runId, seeded.runId),
          eq(scratchMessages.role, "system"),
        ),
      );

    expect(
      results.filter(
        (message) =>
          parseScratchMessageContent("system", message.content).kind ===
          "flow_action_result",
      ),
    ).toHaveLength(1);
  }, 120_000);

  it("owner-scratch-package-lock-takeover: a superseded generation never edits", async () => {
    const seeded = await seedPendingAction("takeover");
    const takeover = await lockLocalPackage(seeded.pkg.id, "assistant-newlock");
    const fresh = await getLocalPackage(seeded.pkg.id, db as never);

    expect(
      await settlePendingFlowAssistantActions({
        db: db as never,
        localPackage: fresh!,
        runId: seeded.runId,
        lockGeneration: takeover,
        assertCanApply: () =>
          assertHoldsLock(seeded.pkg.id, takeover, db as never),
      }),
    ).toBeNull();
    const [row] = await db
      .select()
      .from(schema.flowAssistantActions)
      .where(eq(schema.flowAssistantActions.runId, seeded.runId));

    expect(row.state).toBe("skipped");
    expect(
      (
        await diffWorkingDir(
          (await getLocalPackage(seeded.pkg.id, db as never))!,
        )
      ).changedCount,
    ).toBe(0);
  }, 120_000);
});

function streamAssistantText(text: string): void {
  supervisorMock.streamSession.mockImplementation(async function* () {
    yield {
      type: "session.update" as const,
      sessionId: "sup-1",
      monotonicId: 1,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text },
      },
    };
  });
  supervisorMock.sendPrompt.mockImplementation(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));

    return { stopReason: "end_turn" };
  });
}

async function lockLocalPackage(
  localPackageId: string,
  label: string,
): Promise<string> {
  const sessionId = `${label}-${randomUUID().slice(0, 8)}`;

  await acquireLock(localPackageId, userId, sessionId, db as never);

  return sessionId;
}

function assistantActionMarkdown(args: {
  actionId: string;
  summary: string;
  path: string;
  baseHash?: string | null;
  content: string;
}): string {
  return [
    "I prepared the update.",
    "",
    "```maister-flow-assistant-action",
    JSON.stringify({
      schemaVersion: FLOW_ASSISTANT_ACTION_SCHEMA_VERSION,
      actionId: args.actionId,
      summary: args.summary,
      operations: [
        {
          op: "upsert_file",
          path: args.path,
          baseHash: args.baseHash ?? null,
          content: args.content,
        },
      ],
    }),
    "```",
  ].join("\n");
}

function validFlowYaml(name: string): string {
  return `schemaVersion: 1
name: ${name}
nodes:
  - id: s1
    type: cli
    action:
      command: echo hi
    transitions:
      success: done
`;
}

describe("deferred-release on a failure path (ADR-097 T5.6)", () => {
  it("a launch turn failure tears down the supervisor session (releasing any deferred)", async () => {
    const pkg = await createLocalPackage({
      name: `assistant-fail-${randomUUID().slice(0, 8)}`,
      createdBy: userId,
      db: db as never,
    });

    // The turn rejects after the session exists — the launch catch MUST release
    // it by deleting the supervisor session (purgeSession cancels open deferreds).
    supervisorMock.sendPrompt.mockRejectedValue(new Error("turn boom"));
    const sessionId = await lockLocalPackage(pkg.id, "assistant-fail");

    await expect(
      launchLocalPackageAssistant({
        body: { localPackageId: pkg.id, sessionId, prompt: "go" },
        userId,
      }),
    ).rejects.toThrow(/turn boom/);

    expect(supervisorMock.deleteSession).toHaveBeenCalledWith("sup-1");

    // The run lands Crashed. The host session stays in run_sessions as immutable
    // audit/recovery state; scratch metadata no longer mirrors it.
    const rows = await db
      .select({
        status: runs.status,
      })
      .from(runs)
      .innerJoin(scratchRuns, eq(scratchRuns.runId, runs.id))
      .where(eq(runs.localPackageId, pkg.id));

    expect(rows[0].status).toBe("Crashed");
  });

  it("a follow-up turn failure also releases the supervisor session", async () => {
    const pkg = await createLocalPackage({
      name: `assistant-turn-fail-${randomUUID().slice(0, 8)}`,
      createdBy: userId,
      db: db as never,
    });
    const sessionId = await lockLocalPackage(pkg.id, "assistant-turn-fail");
    const launched = await launchLocalPackageAssistant({
      body: { localPackageId: pkg.id, sessionId, prompt: "first" },
      userId,
    });

    supervisorMock.deleteSession.mockClear();
    // A non-retryable crash on the turn path releases the deferred.
    supervisorMock.sendPrompt.mockRejectedValue(new Error("turn crash"));

    await expect(
      sendLocalPackageAssistantMessage({
        runId: launched.runId,
        body: { localPackageId: pkg.id, sessionId, content: "again" },
      }),
    ).rejects.toThrow(/turn crash/);

    expect(supervisorMock.deleteSession).toHaveBeenCalledWith("sup-1");
  });
});

// --- ADR-110 addendum: staged-stream launch (surface runId before turn 1) ----

type StagedEvent = { stage: string; runId?: string; dialogUrl?: string };

describe("launchLocalPackageAssistantStaged (staged-stream, ADR-110 addendum)", () => {
  it("yields ordered stages and session_ready(runId) before sendPrompt (AC1)", async () => {
    const pkg = await createLocalPackage({
      name: `staged-order-${randomUUID().slice(0, 8)}`,
      createdBy: userId,
      db: db as never,
    });
    const sessionId = await lockLocalPackage(pkg.id, "staged-order");

    streamAssistantText("done");

    const gen = launchLocalPackageAssistantStaged({
      body: { localPackageId: pkg.id, sessionId, prompt: "hi" },
      userId,
    });
    const stages: string[] = [];
    let readyRunId: string | undefined;
    let sendPromptCallsAtReady = -1;
    let step = await gen.next();

    while (!step.done) {
      const ev = step.value as StagedEvent;

      stages.push(ev.stage);
      if (ev.stage === "session_ready") {
        readyRunId = ev.runId;
        sendPromptCallsAtReady = supervisorMock.sendPrompt.mock.calls.length;
      }
      step = await gen.next();
    }

    expect(stages).toEqual([
      "precondition",
      "materializing",
      "spawning",
      "session_ready",
    ]);
    expect(readyRunId).toBeTruthy();
    expect(sendPromptCallsAtReady).toBe(0);
    expect(supervisorMock.sendPrompt).toHaveBeenCalledTimes(1);
    expect(step.value.runId).toBe(readyRunId);

    const exclude = await readFile(
      join(pkg.workingDir, ".git", "info", "exclude"),
      "utf8",
    );

    expect(exclude).toContain(".maister/");
    expect(exclude).toContain(".claude/");
  });

  it("persists Running run + acpSessionId at session_ready, before the turn (AC2)", async () => {
    const pkg = await createLocalPackage({
      name: `staged-persist-${randomUUID().slice(0, 8)}`,
      createdBy: userId,
      db: db as never,
    });
    const sessionId = await lockLocalPackage(pkg.id, "staged-persist");

    streamAssistantText("done");

    const gen = launchLocalPackageAssistantStaged({
      body: { localPackageId: pkg.id, sessionId, prompt: "hi" },
      userId,
    });
    let step = await gen.next();

    while (
      !step.done &&
      (step.value as StagedEvent).stage !== "session_ready"
    ) {
      step = await gen.next();
    }

    expect(step.done).toBe(false);

    const runId = (step.value as StagedEvent).runId as string;

    expect(runId).toBeTruthy();
    // The status tx committed before session_ready; the turn has NOT started.
    expect(supervisorMock.sendPrompt).not.toHaveBeenCalled();

    const runRows = await db
      .select({ status: runs.status })
      .from(runs)
      .where(eq(runs.id, runId));
    const sessRows = await db
      .select({ acpSessionId: runSessions.acpSessionId })
      .from(runSessions)
      .where(eq(runSessions.runId, runId));
    const scratchRows = await db
      .select({ dialogStatus: scratchRuns.dialogStatus })
      .from(scratchRuns)
      .where(eq(scratchRuns.runId, runId));

    expect(runRows[0].status).toBe("Running");
    expect(sessRows[0].acpSessionId).toBe("acp-1");
    expect(scratchRows[0].dialogStatus).toBe("Running");

    while (!step.done) step = await gen.next();
    expect(step.value.runId).toBe(runId);
  });

  it("promptless launch yields session_ready then WaitingForUser, no turn (FR3)", async () => {
    const pkg = await createLocalPackage({
      name: `staged-promptless-${randomUUID().slice(0, 8)}`,
      createdBy: userId,
      db: db as never,
    });
    const sessionId = await lockLocalPackage(pkg.id, "staged-promptless");

    const gen = launchLocalPackageAssistantStaged({
      body: { localPackageId: pkg.id, sessionId, prompt: "" },
      userId,
    });
    const stages: string[] = [];
    let step = await gen.next();

    while (!step.done) {
      stages.push((step.value as StagedEvent).stage);
      step = await gen.next();
    }

    expect(stages).toEqual([
      "precondition",
      "materializing",
      "spawning",
      "session_ready",
    ]);
    expect(step.value.status.dialogStatus).toBe("WaitingForUser");
    expect(supervisorMock.sendPrompt).not.toHaveBeenCalled();
  });

  it("keeps the durable first turn running on a client abort after session_ready", async () => {
    const pkg = await createLocalPackage({
      name: `staged-abort-${randomUUID().slice(0, 8)}`,
      createdBy: userId,
      db: db as never,
    });
    const sessionId = await lockLocalPackage(pkg.id, "staged-abort");

    streamAssistantText("done");

    const controller = new AbortController();
    const gen = launchLocalPackageAssistantStaged(
      { body: { localPackageId: pkg.id, sessionId, prompt: "hi" }, userId },
      { signal: controller.signal },
    );
    let step = await gen.next();

    while (
      !step.done &&
      (step.value as StagedEvent).stage !== "session_ready"
    ) {
      step = await gen.next();
    }

    expect(step.done).toBe(false);

    const runId = (step.value as StagedEvent).runId as string;

    // The session exists (spawned before session_ready) but the turn has not run.
    expect(supervisorMock.createSession).toHaveBeenCalledTimes(1);
    expect(supervisorMock.sendPrompt).not.toHaveBeenCalled();

    // Client disconnects after the run is visible. The launch stream is gone,
    // but the durable run keeps its first turn alive.
    controller.abort();
    const done = await gen.next();

    expect(done.done).toBe(true);
    expect(supervisorMock.deleteSession).not.toHaveBeenCalled();
    expect(supervisorMock.sendPrompt).toHaveBeenCalledTimes(1);

    const rows = await db
      .select({ status: runs.status, dialogStatus: scratchRuns.dialogStatus })
      .from(runs)
      .innerJoin(scratchRuns, eq(scratchRuns.runId, runs.id))
      .where(eq(runs.id, runId));

    expect(rows[0]).toMatchObject({
      status: "Running",
      dialogStatus: "WaitingForUser",
    });
  });

  it("drain wrapper returns the same terminal result as today (AC3)", async () => {
    const pkg = await createLocalPackage({
      name: `staged-drain-${randomUUID().slice(0, 8)}`,
      createdBy: userId,
      db: db as never,
    });
    const sessionId = await lockLocalPackage(pkg.id, "staged-drain");

    streamAssistantText(
      assistantActionMarkdown({
        actionId: "act_drain",
        summary: "Add drain rule",
        path: "rules/drain.md",
        content: "# drain\n",
      }),
    );

    const result = await launchLocalPackageAssistant({
      body: { localPackageId: pkg.id, sessionId, prompt: "do" },
      userId,
    });

    expect(result.runId).toBeTruthy();
    expect(result.actionResult?.status).toBe("applied");
    expect(result.status.dialogStatus).toBeTruthy();
  });
});
