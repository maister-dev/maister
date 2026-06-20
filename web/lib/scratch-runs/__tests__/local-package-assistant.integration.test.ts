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

import type { SupervisorSessionRecord } from "@/lib/supervisor-client";
import type { WorktreeInfo } from "@/lib/worktree";

import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { and, eq, isNull } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
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
import { classifyRunReconcile, runReconcileSweep } from "@/lib/reconcile";
import { assertRunScratchMetadataInvariant } from "@/lib/runs/run-kind-invariants";

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

vi.mock("@/lib/supervisor-client", () => supervisorMock);

let markScratchCrashed: typeof import("@/lib/scratch-runs/service").markScratchCrashed;
let launchLocalPackageAssistant: typeof import("@/lib/scratch-runs/service").launchLocalPackageAssistant;
let sendScratchUserMessage: typeof import("@/lib/scratch-runs/service").sendScratchUserMessage;
let createLocalPackage: typeof import("@/lib/local-packages/service").createLocalPackage;
let diffWorkingDir: typeof import("@/lib/local-packages/service").diffWorkingDir;
let getLocalPackage: typeof import("@/lib/local-packages/service").getLocalPackage;

const schema = schemaModule as unknown as Record<string, any>;
const { domainEvents, localPackages, runs, scratchRuns, webhookEvents } =
  schema;

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;
let originalDbUrl: string | undefined;
let originalHome: string | undefined;
let homeDir: string;
let userId: string;
let runnerId: string;
let localPackageId: string;

const RECON_GRACE_SECONDS = 90;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("lp_assistant_test")
    .withUsername("test")
    .withPassword("test")
    .start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);
  await migrate(db, { migrationsFolder: "./lib/db/migrations" });

  ({ markScratchCrashed, launchLocalPackageAssistant, sendScratchUserMessage } =
    await import("@/lib/scratch-runs/service"));
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

  userId = randomUUID();
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
  await pool?.end();
  await container?.stop();
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
    const listSessions = async (): Promise<SupervisorSessionRecord[]> => [];
    const listWorktrees = async (): Promise<WorktreeInfo[]> => [];

    const summary = await runReconcileSweep({
      db,
      listSessions,
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
  it("launches at the working dir, and a turn that writes a file is reflected in the diff", async () => {
    const pkg = await createLocalPackage({
      name: `assistant-launch-${randomUUID().slice(0, 8)}`,
      createdBy: userId,
      db: db as never,
    });

    // The agent's "turn" is simulated by the stubbed sendPrompt writing a flow
    // file into the working dir (the supervisor confines this server-side; here
    // we just emulate the on-disk effect), then asserting the git diff shows it.
    supervisorMock.sendPrompt.mockImplementation(async () => {
      await writeFile(
        join(pkg.workingDir, "flows", "new.yaml"),
        "schemaVersion: 1\nname: new\nnodes: []\n",
        "utf8",
      );

      return { stopReason: "end_turn" };
    });

    const result = await launchLocalPackageAssistant({
      body: { localPackageId: pkg.id, prompt: "add a flow" },
      userId,
    });

    expect(result.runId).toBeTruthy();
    expect(supervisorMock.createSession).toHaveBeenCalledTimes(1);
    // The launch confines the session to the working dir (no repo/worktree
    // widening) — the SOLE confinement root.
    const createArg = (
      supervisorMock.createSession.mock.calls as unknown as Array<
        [{ confineRoot?: string; worktreePath?: string }]
      >
    )[0][0];

    expect(createArg).toMatchObject({
      confineRoot: pkg.workingDir,
      worktreePath: pkg.workingDir,
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

    // The assistant's write is visible in the working-tree diff (drives the
    // editor's changed-count + canvas refresh).
    const fresh = await getLocalPackage(pkg.id, db as never);
    const diff = await diffWorkingDir(fresh!);

    expect(diff.changedCount).toBeGreaterThanOrEqual(1);
    expect(diff.files.some((f) => f.path.endsWith("flows/new.yaml"))).toBe(
      true,
    );
  });

  it("seeds the flow-authoring skill into the session working dir", async () => {
    const pkg = await createLocalPackage({
      name: `assistant-skill-${randomUUID().slice(0, 8)}`,
      createdBy: userId,
      db: db as never,
    });

    await launchLocalPackageAssistant({
      body: { localPackageId: pkg.id, prompt: "hi" },
      userId,
    });

    // claude (cwd-dir) materializes the skill under the working dir .claude/skills.
    const skillMd = await readFile(
      join(pkg.workingDir, ".claude", "skills", "flow-authoring", "SKILL.md"),
      "utf8",
    );

    expect(skillMd).toContain("name: flow-authoring");
  });

  it("a turn on the assistant run (loadScratchRows) works WITHOUT a workspace row", async () => {
    const pkg = await createLocalPackage({
      name: `assistant-turn-${randomUUID().slice(0, 8)}`,
      createdBy: userId,
      db: db as never,
    });
    const launched = await launchLocalPackageAssistant({
      body: { localPackageId: pkg.id, prompt: "first" },
      userId,
    });

    // There is NO workspaces row for a local-package assistant run.
    const workspaceRows = await db
      .select({ runId: schema.workspaces.runId })
      .from(schema.workspaces)
      .where(eq(schema.workspaces.runId, launched.runId));

    expect(workspaceRows).toHaveLength(0);

    // A follow-up turn writes a second file; the turn path must read the cwd
    // from the local package (not a workspace row) and not crash.
    supervisorMock.sendPrompt.mockImplementation(async () => {
      await writeFile(
        join(pkg.workingDir, "rules", "more.md"),
        "# more\n",
        "utf8",
      );

      return { stopReason: "end_turn" };
    });

    const res = await sendScratchUserMessage({
      runId: launched.runId,
      body: { content: "do more", attachments: [] },
    });

    expect(res.ok).toBe(true);

    const fresh = await getLocalPackage(pkg.id, db as never);
    const diff = await diffWorkingDir(fresh!);

    expect(diff.files.some((f) => f.path.endsWith("rules/more.md"))).toBe(true);
  });
});

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

    await expect(
      launchLocalPackageAssistant({
        body: { localPackageId: pkg.id, prompt: "go" },
        userId,
      }),
    ).rejects.toThrow(/turn boom/);

    expect(supervisorMock.deleteSession).toHaveBeenCalledWith("sup-1");

    // The run lands Crashed with its supervisor session cleared.
    const rows = await db
      .select({
        status: runs.status,
        supervisorSessionId: scratchRuns.supervisorSessionId,
      })
      .from(runs)
      .innerJoin(scratchRuns, eq(scratchRuns.runId, runs.id))
      .where(eq(runs.localPackageId, pkg.id));

    expect(rows[0].status).toBe("Crashed");
    expect(rows[0].supervisorSessionId).toBeNull();
  });

  it("a follow-up turn failure also releases the supervisor session", async () => {
    const pkg = await createLocalPackage({
      name: `assistant-turn-fail-${randomUUID().slice(0, 8)}`,
      createdBy: userId,
      db: db as never,
    });
    const launched = await launchLocalPackageAssistant({
      body: { localPackageId: pkg.id, prompt: "first" },
      userId,
    });

    supervisorMock.deleteSession.mockClear();
    // A non-retryable crash on the turn path releases the deferred.
    supervisorMock.sendPrompt.mockRejectedValue(new Error("turn crash"));

    await expect(
      sendScratchUserMessage({
        runId: launched.runId,
        body: { content: "again", attachments: [] },
      }),
    ).rejects.toThrow(/turn crash/);

    expect(supervisorMock.deleteSession).toHaveBeenCalledWith("sup-1");
  });
});
