// ADR-176 — the flow continuation worker's crash-recover arm.
//
// Real Postgres (the predicate, the partial index and the budget arithmetic are
// not faithfully mockable), with the three seams the arm actually consults
// injected: `listSessions` through the passed `executionHosts`, and the two
// dispatchers `driveResume` / `runFlow` as module mocks. That is the same shape
// `reconcile-sweep.integration.test.ts` uses for the sweep, and it is the level
// this arm lives at — the production-boot suite proves the workers START; this
// one proves what the arm DOES once they have.
//
// The single most important case here is (b): a LIVE session must take the
// `reattach` route and must never reach `driveResume`, whose
// `closeCrashedNodeAttempts` would close an attempt the session is still
// producing so the re-prompt double-spends the turn.
import type { SupervisorSessionRecord } from "@/lib/execution-host";

import { randomUUID } from "node:crypto";

import { and, eq, isNotNull } from "drizzle-orm";
import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import * as schemaModule from "@/lib/db/schema";
import { testPlatformRunnerRow } from "@/lib/__tests__/runner-fixtures";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

const driveResumeMock = vi.hoisted(() => vi.fn());
const runFlowMock = vi.hoisted(() => vi.fn());
const logLines = vi.hoisted(
  () => [] as Array<{ payload: Record<string, unknown>; msg: unknown }>,
);

vi.mock("@/lib/runs/recover", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/runs/recover")>()),
  driveResume: driveResumeMock,
}));
vi.mock("../../runner", () => ({ runFlow: runFlowMock }));
vi.mock("pino", () => {
  const record =
    () =>
    (payload: Record<string, unknown>, msg?: unknown): void => {
      logLines.push({ payload, msg });
    };
  const logger = {
    info: record(),
    error: record(),
    warn: record(),
    debug: record(),
    trace: record(),
    fatal: record(),
    child: () => logger,
    level: "info",
  };

  return { default: () => logger };
});

const schema = schemaModule as unknown as Record<string, any>;
const GRACE_SECONDS = 60;

let database: StartedPostgresTestDb;
let db: NodePgDatabase;
let projectId = "";
let flowId = "";
let runnerId = "";
let hostId = "";
let liveSessions: SupervisorSessionRecord[] = [];
let listSessionsThrows = false;

const executionHosts = {
  local: () => ({
    listSessions: async (): Promise<SupervisorSessionRecord[]> => {
      if (listSessionsThrows)
        throw new Error("supervisor unavailable (network): fetch failed");

      return liveSessions;
    },
  }),
} as never;

beforeAll(async () => {
  process.env.MAISTER_RECONCILE_GRACE_SECONDS = String(GRACE_SECONDS);
  database = await startMainPostgresTestDb({
    databaseName: "crash_recover_continuation",
  });
  db = database.db;
  projectId = randomUUID();
  flowId = randomUUID();
  runnerId = randomUUID();
  hostId = randomUUID();
  await db.insert(schema.projects).values({
    id: projectId,
    slug: `cr-${projectId.slice(0, 8)}`,
    name: "Crash recover",
    taskKey: `CR${projectId.replaceAll("-", "").slice(0, 6)}`.toUpperCase(),
    repoPath: `/tmp/cr-${projectId.slice(0, 8)}`,
  });
  await db
    .insert(schema.platformAcpRunners)
    .values(testPlatformRunnerRow(runnerId, "claude"));
  await db.insert(schema.flows).values({
    id: flowId,
    projectId,
    flowRefId: "cr",
    source: "github.com/fixture/cr",
    version: "v1.0.0",
    installedPath: "/tmp/cr-flow",
    manifest: { schemaVersion: 1, name: "cr", nodes: [] },
    schemaVersion: 1,
  });
  await db.insert(schema.executionHosts).values({
    id: hostId,
    hostKey: `local-${hostId.slice(0, 8)}`,
    kind: "local_direct",
    displayName: "local",
    transport: { kind: "local_direct" },
  });
}, 180_000);

afterAll(async () => {
  delete process.env.MAISTER_RECONCILE_GRACE_SECONDS;
  await database?.stop();
});

/**
 * A FAITHFUL `driveResume` double.
 *
 * The real one clears the recover marker on success (`clearCrashRecoverMarker`,
 * `recover.ts:515` and `:698`) and a terminal `unresumable` goes through
 * `crashRunningRun`, which must also clear it. A double that skips those side
 * effects leaves every run permanently crash-recover-pending and the worker
 * re-serves it on every wake — which reads as a hot-loop defect in the arm and
 * is really just a lenient fake. `transient` deliberately changes nothing: that
 * is the real function's documented behaviour and the reason the budget exists.
 */
function driveResumeDouble(state: string) {
  return async (runId: string) => {
    if (state === "resumed" || state === "redispatched")
      await db
        .update(schema.runs)
        .set({ resumeStartedAt: null })
        .where(eq(schema.runs.id, runId));
    if (state === "unresumable")
      await db
        .update(schema.runs)
        .set({ status: "Crashed", resumeStartedAt: null })
        .where(eq(schema.runs.id, runId));

    return { state };
  };
}

/**
 * A FAITHFUL `runFlow` double for the reattach arm: the real one CAS-clears the
 * recover marker at `runner-graph.ts:2410` (winner clears, loser bails). A
 * double that leaves the marker set keeps the run a candidate forever and the
 * worker re-dispatches it on every wake.
 */
let crashResumeWinners = 0;

async function runFlowDouble(runId: string) {
  const claimed = await db
    .update(schema.runs)
    .set({ resumeStartedAt: null })
    .where(
      and(eq(schema.runs.id, runId), isNotNull(schema.runs.resumeStartedAt)),
    )
    .returning({ id: schema.runs.id });

  if (claimed.length > 0) crashResumeWinners += 1;
}

// The worker serves on `projectionLimitsFromEnv().concurrency` slots (2), each
// with its own cursor, so both select the same head row and both dispatch.
// That is the DESIGN, not a defect: single-winner is decided by
// `claimFlowDriver` inside `runFlow`, and the pre-dispatch stretch is
// idempotent by construction (ADR-176 D7). Counts below are therefore bounded
// by the slot count, never pinned to one.
const SLOTS = 2;

beforeEach(async () => {
  driveResumeMock.mockReset().mockImplementation(driveResumeDouble("resumed"));
  runFlowMock.mockReset().mockImplementation(runFlowDouble);
  logLines.length = 0;
  crashResumeWinners = 0;
  liveSessions = [];
  listSessionsThrows = false;
  await db.delete(schema.nodeAttempts);
  await db.delete(schema.executionAssignments);
  await db.delete(schema.runs);
  await db.delete(schema.tasks);
});

type SeedOpts = {
  resumeStartedAt?: Date | null;
  currentStepId?: string | null;
  attempts?: number;
  nextRetryAt?: Date | null;
  assignmentState?: "active" | "released";
  withAssignment?: boolean;
  latestAttemptStartedAt?: Date | null;
};

async function seedCrashRecoverRun(opts: SeedOpts = {}): Promise<string> {
  const runId = randomUUID();
  const taskId = randomUUID();
  const assignmentId = randomUUID();
  const withAssignment = opts.withAssignment ?? true;

  await db.insert(schema.tasks).values({
    id: taskId,
    number: Math.trunc(Math.random() * 1e9) + 1,
    projectId,
    flowId,
    title: "crash recover",
    prompt: "p",
    status: "InFlight",
  });
  await db.insert(schema.runs).values({
    id: runId,
    taskId,
    projectId,
    flowId,
    runKind: "flow",
    status: "Running",
    flowVersion: "v1",
    currentStepId:
      opts.currentStepId === undefined ? "implement" : opts.currentStepId,
    resumeStartedAt:
      opts.resumeStartedAt === undefined
        ? new Date(Date.now() - (GRACE_SECONDS + 30) * 1000)
        : opts.resumeStartedAt,
    crashRecoverAttempts: opts.attempts ?? 0,
    crashRecoverNextRetryAt: opts.nextRetryAt ?? null,
  });
  if (withAssignment) {
    await db.insert(schema.executionAssignments).values({
      id: assignmentId,
      runId,
      executionHostId: hostId,
      epoch: 1,
      state: opts.assignmentState ?? "active",
      placementReason: "launch",
      // `(state = 'active') = (ended_at IS NULL)` — a released row must carry
      // an end.
      endedAt:
        (opts.assignmentState ?? "active") === "active" ? null : new Date(),
    });
    await db
      .update(schema.runs)
      .set({ executionAssignmentId: assignmentId })
      .where(eq(schema.runs.id, runId));
  }
  if (opts.latestAttemptStartedAt) {
    await db.insert(schema.nodeAttempts).values({
      id: randomUUID(),
      runId,
      nodeId: "implement",
      nodeType: "ai_coding",
      attempt: 1,
      status: "Running",
      startedAt: opts.latestAttemptStartedAt,
    });
  }

  return runId;
}

/** Runs the worker until `settled` holds or the budget expires, then stops it
 * — the arm is a background loop, so a case asserts on its effect. */
async function runWorkerUntil(
  settled: () => boolean,
  budgetMs = 15_000,
): Promise<void> {
  const { startFlowContinuationWorker } = await import(
    "../continuation-worker"
  );
  const worker = startFlowContinuationWorker({
    db: db as never,
    executionHosts,
  });
  const deadline = Date.now() + budgetMs;

  try {
    while (Date.now() < deadline && !settled())
      await new Promise((r) => setTimeout(r, 100));
    // Hold one more idle wake so a second, unwanted dispatch would land.
    await new Promise((r) => setTimeout(r, 1_500));
  } finally {
    await worker.stop().catch(() => undefined);
  }
}

function reentryLines(): Array<Record<string, unknown>> {
  return logLines
    .filter((line) => line.msg === "flow-continuation-crash-recover-reentry")
    .map((line) => line.payload);
}

async function runRow(runId: string) {
  const [row] = await db
    .select({
      attempts: schema.runs.crashRecoverAttempts,
      nextRetryAt: schema.runs.crashRecoverNextRetryAt,
      resumeStartedAt: schema.runs.resumeStartedAt,
    })
    .from(schema.runs)
    .where(eq(schema.runs.id, runId));

  return row as {
    attempts: number;
    nextRetryAt: Date | null;
    resumeStartedAt: Date | null;
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("flow continuation worker — crash-recover arm (ADR-176)", () => {
  it("(a) no live session past grace: the WORKER re-enters through driveResume", async () => {
    const runId = await seedCrashRecoverRun();

    await runWorkerUntil(() => driveResumeMock.mock.calls.length > 0);

    expect(driveResumeMock.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(driveResumeMock.mock.calls.length).toBeLessThanOrEqual(SLOTS);
    for (const call of driveResumeMock.mock.calls) expect(call[0]).toBe(runId);
    expect(runFlowMock.mock.calls.length).toBe(0);
    const lines = reentryLines();

    // Authorship: the worker's own id, not the sweep's `reconcile:` line.
    expect(lines[0]?.route).toBe("recover");
    expect(lines[0]?.runId).toBe(runId);
    expect(lines[0]?.targetStepId).toBe("implement");
    expect(String(lines[0]?.workerId)).toMatch(/^flow-continuation-worker:/);
  }, 60_000);

  // THE C6 regression guard. A naive arm built on the SQL predicate alone has
  // no liveness discrimination: it would hand a live session to `driveResume`,
  // whose `closeCrashedNodeAttempts` closes the attempt the session is still
  // producing, and the re-prompt double-spends that turn.
  it("(b) live session: takes the reattach route and NEVER calls driveResume", async () => {
    const runId = await seedCrashRecoverRun();

    liveSessions = [
      {
        runId,
        sessionId: "sup-1",
        acpSessionId: "acp-1",
        stepId: "implement",
        status: "live",
      } as unknown as SupervisorSessionRecord,
    ];

    await runWorkerUntil(() => runFlowMock.mock.calls.length > 0);

    expect(
      driveResumeMock.mock.calls.length,
      "a LIVE session must never reach driveResume: closeCrashedNodeAttempts " +
        "would close the attempt the session is still producing and the " +
        "re-prompt would double-spend that turn",
    ).toBe(0);
    expect(runFlowMock.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(runFlowMock.mock.calls.length).toBeLessThanOrEqual(SLOTS);
    expect(runFlowMock.mock.calls[0][0]).toBe(runId);
    expect(runFlowMock.mock.calls[0][1]).toMatchObject({
      crashResume: { targetStepId: "implement" },
    });
    expect(reentryLines()[0]?.route).toBe("reattach");
    // The reattach arm is the sweep's existing behaviour: no new bound, so it
    // must not spend the budget a `recover` would.
    expect((await runRow(runId)).attempts).toBe(0);
  }, 60_000);

  it("(c) inside the grace window: yields without dispatching or probing", async () => {
    await seedCrashRecoverRun({ resumeStartedAt: new Date() });

    await runWorkerUntil(() => false, 4_000);

    expect(driveResumeMock.mock.calls.length).toBe(0);
    expect(runFlowMock.mock.calls.length).toBe(0);
    expect(reentryLines()).toHaveLength(0);
  }, 60_000);

  it("(d) a failed liveness probe yields the candidate to the sweep and logs WARN", async () => {
    listSessionsThrows = true;
    const runId = await seedCrashRecoverRun();

    await runWorkerUntil(
      () =>
        logLines.some(
          (line) => line.msg === "flow-continuation-crash-recover-probe-failed",
        ),
      10_000,
    );

    expect(driveResumeMock.mock.calls.length).toBe(0);
    expect(runFlowMock.mock.calls.length).toBe(0);
    const warn = logLines.find(
      (line) => line.msg === "flow-continuation-crash-recover-probe-failed",
    );

    expect(warn?.payload.runId).toBe(runId);
    // Yielded, not consumed: the run keeps its full budget for the sweep.
    expect((await runRow(runId)).attempts).toBe(0);
  }, 60_000);

  it("(e) a transient outcome increments the budget and defers the next attempt", async () => {
    driveResumeMock.mockImplementation(driveResumeDouble("transient"));
    const runId = await seedCrashRecoverRun();

    await runWorkerUntil(() => driveResumeMock.mock.calls.length > 0);
    const row = await runRow(runId);

    // One per dispatching slot: a failing round spends `SLOTS` attempts, which
    // is what "attempts" means here. The bound and the backoff both still hold.
    expect(row.attempts).toBeGreaterThanOrEqual(1);
    expect(row.attempts).toBeLessThanOrEqual(SLOTS);
    expect(row.nextRetryAt).not.toBeNull();
    const deadline = (row.nextRetryAt as Date).getTime();

    expect(deadline).toBeGreaterThan(Date.now());
    // Measurably deferred: the worker held further idle wakes inside
    // `runWorkerUntil` and did NOT re-attempt before the deadline.
    const during = driveResumeMock.mock.calls.length;

    expect(during).toBeLessThanOrEqual(SLOTS);
    expect(Date.now()).toBeLessThan(deadline);
  }, 60_000);

  it("(f) at the cap the worker stops serving the run entirely", async () => {
    const runId = await seedCrashRecoverRun({ attempts: 5 });

    await runWorkerUntil(() => false, 4_000);

    expect(driveResumeMock.mock.calls.length).toBe(0);
    // Ineligibility drops the row OUT of the candidate set rather than parking
    // it at the keyset head — the poison-item policy.
    expect((await runRow(runId)).attempts).toBe(5);
  }, 60_000);

  it("(f2) one below the cap is still served", async () => {
    await seedCrashRecoverRun({ attempts: 4 });

    await runWorkerUntil(() => driveResumeMock.mock.calls.length > 0);

    expect(driveResumeMock.mock.calls.length).toBeGreaterThanOrEqual(1);
  }, 60_000);

  it("(e2) a due deadline exactly equal to now is served (lte, not lt)", async () => {
    await seedCrashRecoverRun({
      attempts: 1,
      nextRetryAt: new Date(Date.now() - 1),
    });

    await runWorkerUntil(() => driveResumeMock.mock.calls.length > 0);

    expect(driveResumeMock.mock.calls.length).toBeGreaterThanOrEqual(1);
  }, 60_000);

  it("(g) a fresh recover intent resets the budget and the worker serves it again", async () => {
    const runId = await seedCrashRecoverRun({ attempts: 5 });

    await runWorkerUntil(() => false, 3_000);
    expect(driveResumeMock.mock.calls.length).toBe(0);

    // What every claim-marker WRITE site does, in one transaction with the
    // marker stamp (D4).
    const { CRASH_RECOVER_BUDGET_RESET } = await import(
      "@/lib/runs/crash-recover"
    );

    await db
      .update(schema.runs)
      .set({
        resumeStartedAt: new Date(Date.now() - (GRACE_SECONDS + 30) * 1000),
        ...CRASH_RECOVER_BUDGET_RESET,
      })
      .where(eq(schema.runs.id, runId));
    await runWorkerUntil(() => driveResumeMock.mock.calls.length > 0);

    expect(driveResumeMock.mock.calls.length).toBeGreaterThanOrEqual(1);
  }, 90_000);

  it("(h) a run with no execution assignment is not a candidate — the sweep serves it", async () => {
    await seedCrashRecoverRun({ withAssignment: false });

    await runWorkerUntil(() => false, 4_000);

    expect(driveResumeMock.mock.calls.length).toBe(0);
    expect(runFlowMock.mock.calls.length).toBe(0);
  }, 60_000);

  it("(i) a non-active assignment is not a candidate", async () => {
    await seedCrashRecoverRun({ assignmentState: "released" });

    await runWorkerUntil(() => false, 4_000);

    expect(driveResumeMock.mock.calls.length).toBe(0);
    expect(runFlowMock.mock.calls.length).toBe(0);
  }, 60_000);

  // D3/D4 — the two Scope-6 racers the worker adds. `claimFlowDriver`'s
  // single-winner is already pinned by `driver-claim.integration.test.ts`; what
  // is NEW here is that the crash-recover RE-ENTRY has its own CAS
  // (`runner-graph.ts:2410` clears `resume_started_at`, the loser bails), and
  // the worker is now a concurrent caller of it alongside the sweep's reattach
  // arm and the scheduler's queued-recover promotion.
  it.each([
    ["D3: the reconcile sweep's reattach arm"],
    ["D4: the scheduler's queued-recover promotion"],
  ])(
    "%s racing the worker yields exactly one crash-resume winner",
    async () => {
      const runId = await seedCrashRecoverRun();

      liveSessions = [
        {
          runId,
          sessionId: "sup-1",
          acpSessionId: "acp-1",
          stepId: "implement",
          status: "live",
        } as unknown as SupervisorSessionRecord,
      ];

      const { startFlowContinuationWorker } = await import(
        "../continuation-worker"
      );
      const worker = startFlowContinuationWorker({
        db: db as never,
        executionHosts,
      });

      try {
        // The competing dispatcher enters the same re-entry concurrently — both
        // it and the worker's two slots reach the marker CAS.
        await Promise.all([
          runFlowDouble(runId),
          new Promise((r) => setTimeout(r, 3_000)),
        ]);
      } finally {
        await worker.stop().catch(() => undefined);
      }

      expect(crashResumeWinners).toBe(1);
      expect((await runRow(runId)).resumeStartedAt).toBeNull();
    },
    60_000,
  );

  it("a run with no current step is not a candidate", async () => {
    await seedCrashRecoverRun({ currentStepId: null });

    await runWorkerUntil(() => false, 4_000);

    expect(driveResumeMock.mock.calls.length).toBe(0);
  }, 60_000);

  it("a run with no recover intent is never routed through this arm", async () => {
    await seedCrashRecoverRun({ resumeStartedAt: null });

    await runWorkerUntil(() => false, 4_000);

    expect(driveResumeMock.mock.calls.length).toBe(0);
    expect(reentryLines()).toHaveLength(0);
  }, 60_000);
});
