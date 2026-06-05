// M19 Phase 3 (T3.1 / T3.4): resumeCrashedRun + driveResume against a real
// Postgres testcontainer. The Phase-1 advisory-lock CAS (Crashed→Running /
// Crashed→Pending), the cap re-admission count, and the durable-marker-before-
// side-effect ordering are not faithfully mockable, so the DB is real; the
// supervisor (`createSession`), the re-attach driver
// (`scheduleResumedSessionDrive`), and the re-dispatcher (`runFlow`) are
// INJECTED via opts and asserted via the returned RecoverResult + DB state.
//
// Contract source: plan §3.2 + the QA Phase-3 contract block.
//   - resume-agent happy (slot free): Crashed agent run + acpSessionId →
//     Phase-1 flips Running + resume_started_at set + current_step_id set
//     BEFORE createSession is invoked → {state:"resumed"} + driver scheduled.
//   - redispatch: Crashed run on a `check` node → {state:"redispatched"},
//     runFlow called, NO createSession.
//   - discard-only: Crashed agent run + null acpSessionId → {state:"discard-only"},
//     no flip (still Crashed), no createSession.
//   - cap full: cap=1 + one live Running + a Crashed agent run → {state:"queued"},
//     run is Pending with acpSessionId retained + resume_started_at set, NO
//     createSession.
//   - queued→resumed via scheduler: the queued Pending+acpSessionId run, when a
//     slot frees and promoteNextPending runs, is RESUMED via driveResume
//     (createSession called, not a fresh runFlow).
//   - concurrent 2nd recover → {state:"conflict"} (CAS lost); only ONE
//     createSession across two concurrent resumeCrashedRun calls.
//   - transient: createSession throws EXECUTOR_UNAVAILABLE → {state:"transient"},
//     run LEFT Running (not rolled back), resume_started_at still set.
//   - unresumable: createSession throws CHECKPOINT → {state:"unresumable"},
//     run back to Crashed with resume_started_at CLEARED.

import type { CreateSessionResult } from "@/lib/supervisor-client";

import { randomUUID } from "node:crypto";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
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
import {
  testPlatformRunnerRow,
  testRunnerSnapshot,
} from "@/lib/__tests__/runner-fixtures";
import { MaisterError } from "@/lib/errors";
import { driveResume, resumeCrashedRun } from "@/lib/runs/recover";
import { promoteNextPending } from "@/lib/scheduler";

const schema = schemaModule as unknown as Record<string, any>;
const { flowRevisions, flows, projects, runs, tasks, users, workspaces } =
  schema;

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;
let originalDbUrl: string | undefined;
let projectId: string;
let projectRepoPath: string;
let executorId: string;
let flowId: string;
let flowRevisionId: string;
let userId: string;
let originalCap: string | undefined;

// A graph manifest with an agent node + a session-less gate node so a run's
// currentStepId selects which recovery plan resolves.
const MANIFEST = {
  schemaVersion: 1,
  name: "recover",
  nodes: [
    {
      id: "implement",
      type: "ai_coding",
      action: { prompt: "/aif-implement" },
      transitions: { success: "verify" },
    },
    {
      id: "verify",
      type: "check",
      action: { command: "true" },
      // M19: opt-in → a crashed `verify` is redispatch-recoverable.
      retry_safe: true,
      transitions: { success: "guarded" },
    },
    {
      id: "guarded",
      type: "check",
      action: { command: "true" },
      // No retry_safe → a crashed `guarded` is discard-only.
      transitions: { success: "done" },
    },
  ],
};

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("recover_test")
    .withUsername("test")
    .withPassword("test")
    .start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);
  await migrate(db, { migrationsFolder: "./lib/db/migrations" });

  // The scheduler advisory lock only engages on a postgres DB_URL.
  originalDbUrl = process.env.DB_URL;
  process.env.DB_URL = container.getConnectionUri();

  projectId = randomUUID();
  projectRepoPath = `/repos/recover-${randomUUID()}`;
  executorId = randomUUID();
  flowId = randomUUID();
  flowRevisionId = randomUUID();
  userId = randomUUID();

  await db.insert(users).values({
    id: userId,
    email: `recover-${userId}@maister.local`,
    role: "member",
    accountStatus: "active",
  });

  await db.insert(projects).values({
    id: projectId,
    slug: "recover-app",
    name: "Recover App",
    repoPath: projectRepoPath,
    maisterYamlPath: `${projectRepoPath}/maister.yaml`,
  });

  await db
    .insert(schema.platformAcpRunners)
    .values(testPlatformRunnerRow(executorId, "claude"));

  await db.insert(flows).values({
    id: flowId,
    projectId,
    flowRefId: "recover",
    source: "github.com/x/recover",
    version: "v1.0.0",
    installedPath: "/tmp/flows/recover",
    manifest: MANIFEST,
    schemaVersion: 1,
  });

  await db.insert(flowRevisions).values({
    id: flowRevisionId,
    flowRefId: "recover",
    source: "github.com/x/recover",
    versionLabel: "v1.0.0",
    resolvedRevision: "deadbeef",
    manifestDigest: "sha256:recover",
    manifest: MANIFEST,
    schemaVersion: 1,
    installedPath: "/tmp/flows/recover",
    packageStatus: "Installed",
  });

  originalCap = process.env.MAISTER_MAX_CONCURRENT_RUNS;
  process.env.MAISTER_MAX_CONCURRENT_RUNS = "3";
}, 180_000);

afterAll(async () => {
  if (originalCap === undefined) {
    delete process.env.MAISTER_MAX_CONCURRENT_RUNS;
  } else {
    process.env.MAISTER_MAX_CONCURRENT_RUNS = originalCap;
  }
  if (originalDbUrl === undefined) {
    delete process.env.DB_URL;
  } else {
    process.env.DB_URL = originalDbUrl;
  }
  await pool?.end();
  await container?.stop();
});

beforeEach(async () => {
  await db.delete(workspaces);
  await db.delete(runs);
  await db.delete(tasks);
  process.env.MAISTER_MAX_CONCURRENT_RUNS = "3";
});

type SeedRunOpts = {
  status?: string;
  runKind?: "flow" | "scratch";
  acpSessionId?: string | null;
  currentStepId?: string | null;
  resumeStartedAt?: Date | null;
  startedAt?: Date;
};

async function seedRun(opts: SeedRunOpts = {}): Promise<string> {
  const taskId = randomUUID();
  const runId = randomUUID();

  await db.insert(tasks).values({
    id: taskId,
    projectId,
    title: "t",
    prompt: "p",
    flowId,
    status: "InFlight",
  });

  await db.insert(runs).values({
    id: runId,
    taskId,
    projectId,
    flowId,
    flowRevisionId,
    runnerId: executorId,
    capabilityAgent: "claude",
    runnerSnapshot: testRunnerSnapshot(executorId),
    runKind: opts.runKind ?? "flow",
    status: opts.status ?? "Crashed",
    acpSessionId:
      opts.acpSessionId === undefined ? "acp-default" : opts.acpSessionId,
    currentStepId:
      opts.currentStepId === undefined ? "implement" : opts.currentStepId,
    flowVersion: "v1",
    startedAt: opts.startedAt ?? new Date(),
    resumeStartedAt: opts.resumeStartedAt ?? null,
  });

  await db.insert(workspaces).values({
    id: randomUUID(),
    runId,
    projectId,
    branch: `maister/${runId}`,
    worktreePath: `/worktrees/${runId}`,
    parentRepoPath: projectRepoPath,
  });

  return runId;
}

async function readRun(runId: string): Promise<any> {
  const rows = await db.select().from(runs).where(eq(runs.id, runId));

  return rows[0];
}

function sessionResult(acpSessionId = "acp-resumed"): CreateSessionResult {
  return { sessionId: "sup-resumed", pid: 4242, acpSessionId };
}

describe("resumeCrashedRun — resume-agent happy path (slot free)", () => {
  it("flips Crashed→Running + stamps resume_started_at + current_step_id BEFORE createSession, then {state:'resumed'}", async () => {
    const runId = await seedRun({
      status: "Crashed",
      currentStepId: "implement",
      acpSessionId: "acp-old",
    });

    // Capture the DB state at the instant createSession is invoked: the
    // durable marker MUST be committed before the supervisor side-effect.
    let statusAtCreate: string | null = null;
    let resumeStartedAtAtCreate: Date | null = null;
    let currentStepIdAtCreate: string | null = null;

    const createSession = vi.fn(async (): Promise<CreateSessionResult> => {
      const row = await readRun(runId);

      statusAtCreate = row.status;
      resumeStartedAtAtCreate = row.resumeStartedAt;
      currentStepIdAtCreate = row.currentStepId;

      return sessionResult();
    });
    const scheduleResumedSessionDrive = vi.fn(() => "drive-id");
    const runFlow = vi.fn(async () => {});

    const result = await resumeCrashedRun(runId, {
      db,
      createSession,
      scheduleResumedSessionDrive,
      runFlow,
    });

    expect(result).toEqual({ state: "resumed" });
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(statusAtCreate).toBe("Running");
    expect(resumeStartedAtAtCreate).not.toBeNull();
    expect(currentStepIdAtCreate).toBe("implement");
    expect(scheduleResumedSessionDrive).toHaveBeenCalledTimes(1);
    expect(runFlow).not.toHaveBeenCalled();
  }, 60_000);
});

describe("resumeCrashedRun — redispatch (session-less retry_safe node)", () => {
  it("Crashed run on a retry_safe check node → {state:'redispatched'}, runFlow called WITH crashResume target, NO createSession", async () => {
    const runId = await seedRun({
      status: "Crashed",
      currentStepId: "verify", // retry_safe check node
      acpSessionId: "acp-check",
    });

    const createSession = vi.fn(async () => sessionResult());
    const scheduleResumedSessionDrive = vi.fn(() => "drive-id");
    const runFlow = vi.fn(async () => {});

    const result = await resumeCrashedRun(runId, {
      db,
      createSession,
      scheduleResumedSessionDrive,
      runFlow,
    });

    expect(result).toEqual({ state: "redispatched" });
    // The crash-resume signal carries the retained target so the runner resumes
    // FROM that node (re-runs it once) rather than no-op'ing or restarting.
    expect(runFlow).toHaveBeenCalledWith(runId, {
      crashResume: { targetStepId: "verify" },
    });
    expect(createSession).not.toHaveBeenCalled();
    expect((await readRun(runId)).status).toBe("Running");
  }, 60_000);

  it("Crashed run on a NON-retry_safe check node → {state:'discard-only'}, no flip, no runFlow", async () => {
    const runId = await seedRun({
      status: "Crashed",
      currentStepId: "guarded", // check node WITHOUT retry_safe
      acpSessionId: null,
    });

    const createSession = vi.fn(async () => sessionResult());
    const runFlow = vi.fn(async () => {});

    const result = await resumeCrashedRun(runId, {
      db,
      createSession,
      runFlow,
    });

    expect(result).toEqual({ state: "discard-only" });
    expect(runFlow).not.toHaveBeenCalled();
    expect(createSession).not.toHaveBeenCalled();
    expect((await readRun(runId)).status).toBe("Crashed");
  }, 60_000);
});

describe("resumeCrashedRun — discard-only (agent node, null acpSessionId)", () => {
  it("→ {state:'discard-only'}, NO flip (still Crashed), no createSession", async () => {
    const runId = await seedRun({
      status: "Crashed",
      currentStepId: "implement",
      acpSessionId: null,
    });

    const createSession = vi.fn(async () => sessionResult());
    const runFlow = vi.fn(async () => {});

    const result = await resumeCrashedRun(runId, {
      db,
      createSession,
      runFlow,
    });

    expect(result).toEqual({ state: "discard-only" });
    expect(createSession).not.toHaveBeenCalled();
    expect(runFlow).not.toHaveBeenCalled();
    const row = await readRun(runId);

    expect(row.status).toBe("Crashed");
    expect(row.resumeStartedAt).toBeNull();
  }, 60_000);
});

describe("resumeCrashedRun — cap full → queued (Codex F2)", () => {
  it("cap=1, one live Running + a Crashed agent run → {state:'queued'}, run Pending w/ acpSessionId retained + resume_started_at set, NO createSession", async () => {
    process.env.MAISTER_MAX_CONCURRENT_RUNS = "1";

    // Fill the single slot with a live Running run.
    const live = await seedRun({ status: "Running", acpSessionId: "acp-live" });

    const crashed = await seedRun({
      status: "Crashed",
      currentStepId: "implement",
      acpSessionId: "acp-queued",
    });

    const createSession = vi.fn(async () => sessionResult());
    const runFlow = vi.fn(async () => {});

    const result = await resumeCrashedRun(crashed, {
      db,
      createSession,
      runFlow,
    });

    expect(result).toEqual({ state: "queued" });
    expect(createSession).not.toHaveBeenCalled();
    const row = await readRun(crashed);

    expect(row.status).toBe("Pending");
    expect(row.acpSessionId).toBe("acp-queued");
    expect(row.resumeStartedAt).not.toBeNull();
    // The live run is untouched.
    expect((await readRun(live)).status).toBe("Running");
  }, 60_000);
});

describe("resumeCrashedRun — queued resume via scheduler (Codex F2)", () => {
  it("a queued Pending+acpSessionId run is RESUMED via driveResume (createSession), NOT fresh runFlow, when a slot frees", async () => {
    process.env.MAISTER_MAX_CONCURRENT_RUNS = "1";

    const live = await seedRun({ status: "Running", acpSessionId: "acp-live" });
    const crashed = await seedRun({
      status: "Crashed",
      currentStepId: "implement",
      acpSessionId: "acp-queued",
    });

    // Recover while cap is full → run goes Pending (queued).
    const queuedResult = await resumeCrashedRun(crashed, {
      db,
      createSession: vi.fn(async () => sessionResult()),
      runFlow: vi.fn(async () => {}),
    });

    expect(queuedResult).toEqual({ state: "queued" });

    // Free the slot, then run the scheduler. The promoted Pending+acpSessionId
    // run must be resumed (createSession), not fresh-launched (runFlow).
    await db
      .update(runs)
      .set({ status: "Done", endedAt: new Date() })
      .where(eq(runs.id, live));

    const createSession = vi.fn(async () => sessionResult());
    const scheduleResumedSessionDrive = vi.fn(() => "drive-id");
    const runFlow = vi.fn(async (_id: string) => {});

    await promoteNextPending({
      db,
      runFlow: (id: string) => void runFlow(id),
      resumeRun: (id: string) =>
        void driveResume(id, {
          db,
          createSession,
          scheduleResumedSessionDrive,
          runFlow,
        }),
    });

    // queueMicrotask in promoteNextPending dispatches the resume — let it run.
    await new Promise((r) => setTimeout(r, 50));

    expect((await readRun(crashed)).status).toBe("Running");
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(runFlow).not.toHaveBeenCalledWith(crashed);
  }, 60_000);
});

describe("resumeCrashedRun — concurrent 2nd recover → conflict", () => {
  it("two concurrent recovers: exactly one wins, the other returns {state:'conflict'}; ONE createSession total", async () => {
    const runId = await seedRun({
      status: "Crashed",
      currentStepId: "implement",
      acpSessionId: "acp-race",
    });

    const createSession = vi.fn(async () => sessionResult());
    const scheduleResumedSessionDrive = vi.fn(() => "drive-id");

    const [a, b] = await Promise.all([
      resumeCrashedRun(runId, {
        db,
        createSession,
        scheduleResumedSessionDrive,
      }),
      resumeCrashedRun(runId, {
        db,
        createSession,
        scheduleResumedSessionDrive,
      }),
    ]);

    const states = [a.state, b.state].sort();

    expect(states).toEqual(["conflict", "resumed"]);
    expect(createSession).toHaveBeenCalledTimes(1);
  }, 60_000);

  it("a not-Crashed run → {state:'conflict'} with no side-effect", async () => {
    const runId = await seedRun({
      status: "Running",
      currentStepId: "implement",
      acpSessionId: "acp-running",
    });

    const createSession = vi.fn(async () => sessionResult());

    const result = await resumeCrashedRun(runId, { db, createSession });

    expect(result).toEqual({ state: "conflict" });
    expect(createSession).not.toHaveBeenCalled();
    expect((await readRun(runId)).status).toBe("Running");
  }, 60_000);
});

describe("resumeCrashedRun — transient supervisor failure (no rollback)", () => {
  it("createSession throws EXECUTOR_UNAVAILABLE → {state:'transient'}, run LEFT Running, resume_started_at still set", async () => {
    const runId = await seedRun({
      status: "Crashed",
      currentStepId: "implement",
      acpSessionId: "acp-transient",
    });

    const createSession = vi.fn(async () => {
      throw new MaisterError("EXECUTOR_UNAVAILABLE", "supervisor 503");
    });
    const runFlow = vi.fn(async () => {});

    const result = await resumeCrashedRun(runId, {
      db,
      createSession,
      runFlow,
    });

    expect(result).toEqual({ state: "transient" });
    const row = await readRun(runId);

    expect(row.status).toBe("Running");
    expect(row.resumeStartedAt).not.toBeNull();
  }, 60_000);
});

describe("resumeCrashedRun — unresumable acp session", () => {
  it("createSession throws CHECKPOINT → {state:'unresumable'}, run back to Crashed, resume_started_at CLEARED", async () => {
    const runId = await seedRun({
      status: "Crashed",
      currentStepId: "implement",
      acpSessionId: "acp-checkpoint",
    });

    const createSession = vi.fn(async () => {
      throw new MaisterError("CHECKPOINT", "unresumable session");
    });

    const result = await resumeCrashedRun(runId, { db, createSession });

    expect(result).toEqual({ state: "unresumable" });
    const row = await readRun(runId);

    expect(row.status).toBe("Crashed");
    expect(row.resumeStartedAt).toBeNull();
  }, 60_000);

  it("createSession returns an EMPTY acpSessionId → {state:'unresumable'}, run back to Crashed", async () => {
    const runId = await seedRun({
      status: "Crashed",
      currentStepId: "implement",
      acpSessionId: "acp-empty",
    });

    const createSession = vi.fn(async () => sessionResult(""));

    const result = await resumeCrashedRun(runId, { db, createSession });

    expect(result).toEqual({ state: "unresumable" });
    expect((await readRun(runId)).status).toBe("Crashed");
  }, 60_000);
});
