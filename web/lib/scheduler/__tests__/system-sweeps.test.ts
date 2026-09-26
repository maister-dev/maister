import { beforeEach, describe, expect, it, vi } from "vitest";

// The sweep's logger is module-scoped, so the only way to assert a LINE (as
// opposed to the value behind it) is to own the pino factory for this file.
const logLines = vi.hoisted(
  () => [] as Array<{ payload: unknown; msg: unknown }>,
);

vi.mock("pino", () => {
  const record =
    (bucket: typeof logLines) =>
    (payload: unknown, msg?: unknown): void => {
      bucket.push({ payload, msg });
    };
  const logger = {
    info: record(logLines),
    error: record(logLines),
    warn: record(logLines),
    debug: record(logLines),
    trace: record(logLines),
    fatal: record(logLines),
    child: () => logger,
    level: "info",
  };

  return { default: () => logger };
});

const runSweepTickMock = vi.hoisted(() => vi.fn());
const runReconcileSweepMock = vi.hoisted(() => vi.fn());
const reconcileTerminalCostRollupsMock = vi.hoisted(() => vi.fn());
const runWorkspaceGcSweepMock = vi.hoisted(() => vi.fn());
const runWorkspaceReconciliationSweepMock = vi.hoisted(() => vi.fn());
const runRevisionGcSweepMock = vi.hoisted(() => vi.fn());
const runCapabilitiesCleanupSweepMock = vi.hoisted(() => vi.fn());
const runEphemeralAgentGcSweepMock = vi.hoisted(() => vi.fn());
const runContextMountGcSweepMock = vi.hoisted(() => vi.fn());
const runAgentMaterializationCleanupSweepMock = vi.hoisted(() => vi.fn());
const runSyncRecoverySweepMock = vi.hoisted(() => vi.fn());
const runBrainDecaySweepMock = vi.hoisted(() => vi.fn());
const runBrainReindexSweepMock = vi.hoisted(() => vi.fn());
const sweepEvaluationEvidenceMock = vi.hoisted(() => vi.fn());
const runPlainAgentDirectoryGcSweepMock = vi.hoisted(() => vi.fn());
const ensureLocalExecutionDataPlaneMock = vi.hoisted(() => vi.fn());
const collectExecutionEventLagMock = vi.hoisted(() => vi.fn());
const platformStatusMock = vi.hoisted(() => vi.fn());
const executionCommandReconcilePassMock = vi.hoisted(() => vi.fn());
const recordHostPressureSampleMock = vi.hoisted(() => vi.fn());
const resumeHostPausedInterruptsMock = vi.hoisted(() => vi.fn());
const promoteNextPendingMock = vi.hoisted(() => vi.fn());
const runLibrarianTurnSweepMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/runs/keepalive-sweeper", () => ({
  runSweepTick: runSweepTickMock,
}));
vi.mock("@/lib/reconcile", () => ({
  runReconcileSweep: runReconcileSweepMock,
}));
vi.mock("@/lib/runs/cost-reconcile-sweep", () => ({
  reconcileTerminalCostRollups: reconcileTerminalCostRollupsMock,
}));
vi.mock("@/lib/gc/workspace-gc", () => ({
  runWorkspaceGcSweep: runWorkspaceGcSweepMock,
}));
vi.mock("@/lib/gc/workspace-reconciler", () => ({
  runWorkspaceReconciliationSweep: runWorkspaceReconciliationSweepMock,
}));
vi.mock("@/lib/gc/revision-gc", () => ({
  runRevisionGcSweep: runRevisionGcSweepMock,
}));
vi.mock("@/lib/capabilities/cleanup", () => ({
  runCapabilitiesCleanupSweep: runCapabilitiesCleanupSweepMock,
}));
vi.mock("@/lib/gc/ephemeral-agent-gc", () => ({
  runEphemeralAgentGcSweep: runEphemeralAgentGcSweepMock,
}));
vi.mock("@/lib/gc/context-mount-gc", () => ({
  runContextMountGcSweep: runContextMountGcSweepMock,
}));
vi.mock("@/lib/gc/agent-materialization-gc", () => ({
  runAgentMaterializationCleanupSweep: runAgentMaterializationCleanupSweepMock,
}));
// #M10: this composition added `runSyncRecoverySweep` and never mocked it, so it
// ran for real, hit getDb(), threw, and was swallowed into `errors[]` — which
// nothing asserted. The sweep was effectively absent from its own test.
vi.mock("@/lib/runs/sync-recovery", () => ({
  runSyncRecoverySweep: runSyncRecoverySweepMock,
}));
// ADR-183 (D19/D20): the librarian backstop reads the DB; mocked for the same
// reason, so `errors: []` keeps guarding the composition.
vi.mock("@/lib/librarian/turn-recovery", () => ({
  runLibrarianTurnSweep: runLibrarianTurnSweepMock,
}));
// ADR-166: the execution-host reconcile pass needs the DB + the local host;
// mocked like every other arm so `errors: []` stays a real guard.
vi.mock("@/lib/execution-host", () => ({
  ensureLocalExecutionDataPlane: ensureLocalExecutionDataPlaneMock,
  executionHosts: {
    local: () => ({ platformStatus: platformStatusMock }),
  },
  executionCommandReconcilePass: executionCommandReconcilePassMock,
}));
vi.mock("@/lib/db/client", () => ({ getDb: () => ({}) }));
// ADR-183 amendment 2026-09-28: the pressure step's collaborators, so its
// orchestration (isolation, drain on every admitting sample) is observable.
vi.mock("@/lib/execution-host/host-pressure", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  recordHostPressureSample: recordHostPressureSampleMock,
}));
vi.mock("@/lib/services/hitl", () => ({
  resumeHostPausedInterrupts: resumeHostPausedInterruptsMock,
}));
vi.mock("@/lib/scheduler", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  promoteNextPending: promoteNextPendingMock,
  effectivePoolCap: vi.fn(async () => ({ cap: 2, fence: null })),
}));
vi.mock("@/lib/execution-host/events/lag-read-model", () => ({
  collectExecutionEventLag: collectExecutionEventLagMock,
}));
// Same exposure, PRE-EXISTING (ADR-122, not this branch): both brain sweeps were
// un-mocked too, so they threw on getDb() into the same swallowed `errors[]`.
// Mocked here so `errors: []` below is a real guard for EVERY arm — otherwise
// the next sweep to go silently broken hides behind them.
vi.mock("@/lib/execution-host/events/stream-health", () => ({
  runEventStreamHealthSweep: vi.fn(async () => ({
    checked: 0,
    stalled: 0,
    degraded: 0,
    errors: [],
  })),
}));
// D-M3: the stranded-turn report reads Postgres; its own suite covers it.
vi.mock("@/lib/agents/stranded-turns", () => ({
  reportStrandedAgentTurns: vi.fn(async () => ({
    count: 0,
    rows: [],
    errors: [],
  })),
}));
vi.mock("@/lib/brain/decay", () => ({
  runBrainDecaySweep: runBrainDecaySweepMock,
}));
vi.mock("@/lib/brain/reindex", () => ({
  runBrainReindexSweep: runBrainReindexSweepMock,
}));
vi.mock("@/lib/evaluations/evidence/gc", () => ({
  sweepEvaluationEvidence: sweepEvaluationEvidenceMock,
}));
// ADR-173: the digest notification trigger joined this bundle. Mocked like every
// other participant — it is a database pass, and the unit test has no database.
vi.mock("@/lib/notifications/digest-trigger", () => ({
  runDigestTrigger: vi.fn(async () => ({
    candidates: 0,
    emitted: 0,
    skippedTooSoon: 0,
    skippedEmpty: 0,
    errors: [],
  })),
  // The delta backstop shares the module and the bundle's error contract: its
  // per-reader failures land in `errors`, never in `bundleErrors`.
  runDecisionsDeltaBackstop: vi.fn(async () => ({
    candidates: 0,
    emitted: 0,
    errors: [],
  })),
}));

vi.mock("@/lib/gc/plain-agent-directory-gc", () => ({
  runPlainAgentDirectoryGcSweep: runPlainAgentDirectoryGcSweepMock,
}));

const workspaceSummary = {
  scanned: 0,
  preserved: 0,
  pruned: 0,
  skippedUnpreserved: 0,
  skippedClaimed: 0,
  retryableFailed: 0,
  failed: 0,
};
const revisionSummary = {
  scanned: 0,
  deleted: 0,
  skippedReferenced: 0,
  failed: 0,
};

function emptyLagModel() {
  return {
    sampledAt: "2026-09-22T12:00:00.000Z",
    streams: [],
    consumers: {
      eligiblePopulation: 0,
      totalConsumers: 0,
      displayed: 0,
      truncated: 0,
      maximumBacklog: "0",
      diagnosticCount: 0,
      byHost: [],
      top: [],
      diagnostics: [],
    },
    poison: { total: 0, displayed: 0, nextAfter: null, rows: [] },
    commands: {
      total: 0,
      queued: 0,
      delivering: 0,
      accepted: 0,
      acceptedWithoutTimestamp: 0,
      oldestAcceptedAt: null,
      oldestAcceptedAgeMs: null,
    },
  };
}

describe("scheduler system sweeps", () => {
  beforeEach(() => {
    vi.resetModules();
    runSweepTickMock.mockReset().mockResolvedValue({ idled: 0 });
    runLibrarianTurnSweepMock
      .mockReset()
      .mockResolvedValue({ deadlines: 0, restarts: 0, admissions: 0 });
    runSyncRecoverySweepMock.mockReset().mockResolvedValue({
      candidates: 0,
      orphanOperationsAborted: 0,
      durationCapKilled: 0,
    });
    // Both brain sweeps merge their own `errors` into the composition's, so the
    // shape matters, not just the resolution.
    runBrainDecaySweepMock.mockReset().mockResolvedValue({ errors: [] });
    runBrainReindexSweepMock.mockReset().mockResolvedValue({ errors: [] });
    runReconcileSweepMock.mockReset().mockResolvedValue({ reconciled: 0 });
    reconcileTerminalCostRollupsMock
      .mockReset()
      .mockResolvedValue({ candidates: 0, reconciled: 0 });
    runWorkspaceGcSweepMock.mockReset().mockResolvedValue(workspaceSummary);
    runWorkspaceReconciliationSweepMock.mockReset().mockResolvedValue({
      scanned: 0,
      retained: 0,
      recovered: 0,
      preserved: 0,
      removed: 0,
      retryableFailed: 0,
      quarantined: 0,
      resolved: 0,
    });
    runRevisionGcSweepMock.mockReset().mockResolvedValue(revisionSummary);
    runCapabilitiesCleanupSweepMock
      .mockReset()
      .mockResolvedValue({ failed: 0 });
    runEphemeralAgentGcSweepMock
      .mockReset()
      .mockResolvedValue({ scanned: 0, removed: 0, live: 0, failed: 0 });
    runContextMountGcSweepMock.mockReset().mockResolvedValue({
      scanned: 0,
      removed: 0,
      live: 0,
      skipped: 0,
      failed: 0,
      poisoned: 0,
    });
    runAgentMaterializationCleanupSweepMock
      .mockReset()
      .mockResolvedValue({ scanned: 0, restored: 0, live: 0, failed: 0 });
    sweepEvaluationEvidenceMock
      .mockReset()
      .mockResolvedValue({ orphansMarked: 0, deleted: 0 });
    runPlainAgentDirectoryGcSweepMock
      .mockReset()
      .mockResolvedValue({ scanned: 0, removed: 0, missing: 0, failed: 0 });
    ensureLocalExecutionDataPlaneMock.mockReset().mockResolvedValue({
      status: "registered",
      host: { id: "11111111-1111-4111-8111-111111111111" },
      action: "touch",
      restarted: false,
    });
    platformStatusMock.mockReset().mockResolvedValue({
      kind: "unavailable",
      reason: "supervisor_down",
      health: null,
      sessions: [],
    });
    // A DEFAULT model. With `mockReset()` alone the collector resolved
    // `undefined`, every later `createExecutionObservability` threw a
    // TypeError into `errors[]`, and cases asserting a null impasse passed
    // because the whole summary had degraded — not because the arm they
    // targeted failed.
    collectExecutionEventLagMock.mockReset().mockResolvedValue(emptyLagModel());
    executionCommandReconcilePassMock.mockReset().mockResolvedValue({
      commands: {
        scanned: 0,
        redelivered: 0,
        orphaned: 0,
        folded: 0,
        turnLost: 0,
        skippedInFlight: 0,
        impasse: 0,
        errors: [],
      },
      assignmentsReleased: 0,
      commandsPruned: 0,
      legacy: { candidates: 0, runIds: [] },
    });
  });

  describe("ADR-183 amendment 2026-09-28 — the pressure step (R-M5)", () => {
    const readyHealth = () => ({
      kind: "ready" as const,
      health: {
        status: "ready" as const,
        host: {
          hostKey: "eh_test0000000000000000000000000000",
          bootId: "0f0e0d0c-0b0a-4908-8706-050403020100",
          protocolVersion: 1 as const,
        },
        version: "0.0.1",
        uptimeMs: 1,
        checkedAt: new Date().toISOString(),
        sessions: { live: 0, exited: 0, crashed: 0 },
        stream: {
          streamId: "stream-1",
          headSequence: "10",
          unacknowledgedCount: 0,
          retainedCount: 10,
          pressured: false,
          oldestUnacknowledgedAgeMs: null,
          pressure: null,
          newWorkRefusedBy: null,
        },
      },
      sessions: [],
    });
    const observed = (transition: string) => ({
      hostId: "11111111-1111-4111-8111-111111111111",
      transition,
      pressuredSince: null,
      durationMs: null,
      unacknowledgedAtStart: null,
      episodes: 0,
    });

    beforeEach(() => {
      recordHostPressureSampleMock.mockReset();
      resumeHostPausedInterruptsMock
        .mockReset()
        .mockResolvedValue({ resumed: 0, redriven: 0, resumeFailures: [] });
      promoteNextPendingMock
        .mockReset()
        .mockResolvedValue({ promotedRunId: null });
    });

    it("a throwing flow drain does not stop the agent drain, and the failure is reported", async () => {
      const { applyHostPressureSample } = await import("../system-sweeps");

      recordHostPressureSampleMock.mockResolvedValue(observed("cleared"));
      promoteNextPendingMock.mockImplementation(
        async (opts: { pool: string }) => {
          if (opts.pool === "flow") throw new Error("flow drain exploded");

          return { promotedRunId: null };
        },
      );
      const summary = await applyHostPressureSample(readyHealth() as never);

      expect(
        promoteNextPendingMock.mock.calls.map(([opts]) => opts.pool),
      ).toEqual(["flow", "agent"]);
      expect(summary?.errors).toEqual([
        expect.stringContaining("flow drain exploded"),
      ]);
    });

    it("a throwing interrupt resume does not stop the drain", async () => {
      const { applyHostPressureSample } = await import("../system-sweeps");

      recordHostPressureSampleMock.mockResolvedValue(observed("cleared"));
      resumeHostPausedInterruptsMock.mockRejectedValue(
        new Error("resume select failed"),
      );
      const summary = await applyHostPressureSample(readyHealth() as never);

      expect(
        promoteNextPendingMock.mock.calls.map(([opts]) => opts.pool),
      ).toEqual(["flow", "agent"]);
      expect(summary?.errors).toEqual([
        expect.stringContaining("resume select failed"),
      ]);
    });

    it("drains on every admitting sample, not only the one that cleared the record", async () => {
      const { applyHostPressureSample } = await import("../system-sweeps");

      // The record was deleted by a sweep that died before its drain: every
      // later sample reads `clear`, and nothing else would ever drain.
      recordHostPressureSampleMock.mockResolvedValue(observed("clear"));
      await applyHostPressureSample(readyHealth() as never);

      expect(
        promoteNextPendingMock.mock.calls.map(([opts]) => opts.pool),
      ).toEqual(["flow", "agent"]);
    });

    it("drains nothing while the host still refuses new work", async () => {
      const { applyHostPressureSample } = await import("../system-sweeps");

      recordHostPressureSampleMock.mockResolvedValue(observed("held"));
      const summary = await applyHostPressureSample(readyHealth() as never);

      expect(promoteNextPendingMock).not.toHaveBeenCalled();
      expect(summary).toMatchObject({ transition: "held", promoted: 0 });
    });

    it("passes the sample's fetch time, taken before the health request, to the record", async () => {
      const { runSystemSweep } = await import("../system-sweeps");
      let fetchedAt = 0;

      platformStatusMock.mockImplementation(async () => {
        fetchedAt = Date.now();

        return readyHealth();
      });
      recordHostPressureSampleMock.mockResolvedValue(observed("held"));
      await runSystemSweep({
        executionObservation: {
          attemptId: "attempt-current",
          observerId: "observer-a",
          previous: null,
        },
      });

      const [[args]] = recordHostPressureSampleMock.mock.calls as Array<
        [{ sampledAt: Date }]
      >;

      expect(args.sampledAt.getTime()).toBeLessThanOrEqual(fetchedAt);
    });
  });

  it("runs every cleanup service once as part of the canonical system sweep", async () => {
    const { runSystemSweep } = await import("../system-sweeps");

    await runSystemSweep();

    expect(runWorkspaceGcSweepMock).toHaveBeenCalledTimes(1);
    expect(runWorkspaceReconciliationSweepMock).toHaveBeenCalledTimes(1);
    expect(runRevisionGcSweepMock).toHaveBeenCalledTimes(1);
    expect(runCapabilitiesCleanupSweepMock).toHaveBeenCalledTimes(1);
    expect(runEphemeralAgentGcSweepMock).toHaveBeenCalledTimes(1);
    expect(runContextMountGcSweepMock).toHaveBeenCalledTimes(1);
    expect(runAgentMaterializationCleanupSweepMock).toHaveBeenCalledTimes(1);
    expect(sweepEvaluationEvidenceMock).toHaveBeenCalledTimes(1);
    expect(runPlainAgentDirectoryGcSweepMock).toHaveBeenCalledTimes(1);
    expect(runSweepTickMock).toHaveBeenCalledTimes(1);
    expect(runReconcileSweepMock).toHaveBeenCalledTimes(1);
    expect(ensureLocalExecutionDataPlaneMock).toHaveBeenCalledTimes(1);
  });

  it("reactivates canonical event ingestion and reports its host", async () => {
    const { runSystemSweep } = await import("../system-sweeps");

    const summary = await runSystemSweep();

    expect(summary.executionEventPlane).toEqual({
      status: "active",
      executionHostId: "11111111-1111-4111-8111-111111111111",
    });
  });

  it("surfaces an event-plane activation failure for scheduler retry", async () => {
    ensureLocalExecutionDataPlaneMock.mockRejectedValueOnce(
      new Error("supervisor offline"),
    );
    const { runSystemSweep } = await import("../system-sweeps");

    const summary = await runSystemSweep();

    expect(summary.executionEventPlane).toBeNull();
    expect(summary.bundleErrors).toContain(
      "execution event-plane activation failed: supervisor offline",
    );
  });

  // ADR-157 (T32): the context-mount backstop is a REGISTERED member of the
  // system_sweep bundle — its summary reaches the caller and a throw is reported,
  // not swallowed. (Its claim→dispatch execution is proven separately in
  // lib/gc/__tests__/context-mount-gc.integration.test.ts.)
  it("reports the context mount backstop summary and surfaces a throw (207 contract)", async () => {
    runContextMountGcSweepMock.mockResolvedValueOnce({
      scanned: 3,
      removed: 2,
      live: 1,
      skipped: 0,
      failed: 0,
      poisoned: 0,
    });

    const first = await import("../system-sweeps");
    const clean = await first.runSystemSweep();

    expect(clean.errors).toEqual([]);
    expect(clean.contextMount).toEqual({
      scanned: 3,
      removed: 2,
      live: 1,
      skipped: 0,
      failed: 0,
      poisoned: 0,
    });

    runContextMountGcSweepMock.mockRejectedValueOnce(new Error("mount boom"));

    const thrown = await first.runSystemSweep();

    expect(
      thrown.errors.some((e) => e.includes("context mount sweep failed")),
    ).toBe(true);
    expect(thrown.contextMount).toBeNull();
  });

  it("surfaces a thrown workspace sweep as an error (207 contract)", async () => {
    runWorkspaceGcSweepMock.mockRejectedValueOnce(new Error("workspace boom"));
    const { runSystemSweep } = await import("../system-sweeps");

    const summary = await runSystemSweep();

    expect(
      summary.errors.some((e) => e.includes("workspace sweep failed")),
    ).toBe(true);
  });

  it("runSystemSweep runs the full composition including keepalive + reconcile", async () => {
    const { runSystemSweep } = await import("../system-sweeps");

    await runSystemSweep();

    expect(runSweepTickMock).toHaveBeenCalledTimes(1);
    expect(runReconcileSweepMock).toHaveBeenCalledTimes(1);
    expect(reconcileTerminalCostRollupsMock).toHaveBeenCalledTimes(1);
    expect(runWorkspaceGcSweepMock).toHaveBeenCalledTimes(1);
    expect(runWorkspaceReconciliationSweepMock).toHaveBeenCalledTimes(1);
    expect(runRevisionGcSweepMock).toHaveBeenCalledTimes(1);
    expect(runCapabilitiesCleanupSweepMock).toHaveBeenCalledTimes(1);
    expect(runEphemeralAgentGcSweepMock).toHaveBeenCalledTimes(1);
    expect(runContextMountGcSweepMock).toHaveBeenCalledTimes(1);
    expect(runAgentMaterializationCleanupSweepMock).toHaveBeenCalledTimes(1);
    expect(runSyncRecoverySweepMock).toHaveBeenCalledTimes(1);
    expect(sweepEvaluationEvidenceMock).toHaveBeenCalledTimes(1);
    expect(runPlainAgentDirectoryGcSweepMock).toHaveBeenCalledTimes(1);
  });

  // ADR-176 / D3: local durable-worker health rides the sweep summary. The
  // import is deliberately `lib/workers/health.ts` and NOT the composition
  // root — the root pulls the flow runner, which in a partially-mocked suite
  // like this one fails whole files as SKIPS rather than as errors.
  it("logs local durable worker health once per tick, surfacing a degraded worker's reason", async () => {
    const { writeDurableWorkerSlot } = await import("@/lib/workers/health");
    const { runSystemSweep } = await import("../system-sweeps");

    try {
      writeDurableWorkerSlot("flowContinuation", {
        stop: async () => {},
        health: () => ({ state: "degraded", reason: "EXECUTOR_UNAVAILABLE" }),
      });
      logLines.length = 0;

      const summary = await runSystemSweep();
      const health = logLines.filter(
        (line) => line.msg === "system_sweep durable worker health",
      );

      expect(health, "exactly one health line per tick").toHaveLength(1);
      expect(health[0].payload).toEqual({
        workers: {
          promptOwner: { state: "stopped", reason: null },
          flowContinuation: {
            state: "degraded",
            reason: "EXECUTOR_UNAVAILABLE",
          },
          agentContinuation: { state: "stopped", reason: null },
        },
      });
      // Diagnostic only: a health read must never fail the tick.
      expect(summary.errors).toEqual([]);
    } finally {
      writeDurableWorkerSlot("flowContinuation", undefined);
    }
  });

  it("persists an unavailable observation without consuming the scheduler failure budget", async () => {
    collectExecutionEventLagMock.mockRejectedValueOnce(
      new Error("database timed out"),
    );
    const { runSystemSweep } = await import("../system-sweeps");

    const summary = await runSystemSweep({
      executionObservation: {
        attemptId: "attempt-current",
        observerId: "observer-b",
        previous: null,
      },
    });

    expect(summary.bundleErrors).toEqual([]);
    expect(summary.errors).toContain(
      "execution observability unavailable: database timed out",
    );
    expect(summary.executionObservability).toMatchObject({
      schemaVersion: 1,
      attemptId: "attempt-current",
      observerId: "observer-b",
      quality: "unavailable",
      errors: ["lag_collection_failed"],
      stream: null,
    });
  });

  it("records an unknown impasse when command reconciliation fails", async () => {
    executionCommandReconcilePassMock.mockRejectedValueOnce(
      new Error("command query failed"),
    );
    const { runSystemSweep } = await import("../system-sweeps");

    const summary = await runSystemSweep({
      executionObservation: {
        attemptId: "attempt-current",
        observerId: "observer-b",
        previous: null,
      },
    });

    expect(summary.errors).toContain(
      "execution-host reconcile pass failed: command query failed",
    );
    // The collector itself SUCCEEDED here, so the summary must not have
    // degraded through the collector-failure path: only the impasse count is
    // unknown. Without this the case passed on a TypeError from an undefined
    // model, which is a different failure entirely.
    expect(
      summary.errors.some((error) =>
        error.startsWith("execution observability unavailable"),
      ),
    ).toBe(false);
    expect(summary.executionObservability?.errors).not.toContain(
      "lag_collection_failed",
    );
    expect(summary.executionObservability?.commands.impasse).toBeNull();
  });

  // Every arm is individually try/caught into `errors[]`, so a sweep that throws
  // is INVISIBLE unless the composition asserts the summary is clean. That is how
  // the un-mocked sync recovery sweep passed while never running.
  it("(#M10) reports the sync recovery result and swallows nothing", async () => {
    runSyncRecoverySweepMock.mockResolvedValueOnce({
      candidates: 2,
      orphanOperationsAborted: 1,
      durationCapKilled: 0,
    });

    const { runSystemSweep } = await import("../system-sweeps");
    const summary = await runSystemSweep();

    expect(summary.errors).toEqual([]);
    expect(summary.syncRecovery).toEqual({
      candidates: 2,
      orphanOperationsAborted: 1,
      durationCapKilled: 0,
    });
  });

  it("(#M10) surfaces a thrown sync recovery sweep as an error (207 contract)", async () => {
    runSyncRecoverySweepMock.mockRejectedValueOnce(new Error("sync boom"));

    const { runSystemSweep } = await import("../system-sweeps");
    const summary = await runSystemSweep();

    expect(
      summary.errors.some((e) => e.includes("sync recovery sweep failed")),
    ).toBe(true);
    expect(summary.syncRecovery).toBeNull();
  });

  it("ADR-183 D19: reports the librarian backstop summary", async () => {
    runLibrarianTurnSweepMock.mockResolvedValueOnce({
      deadlines: 1,
      restarts: 2,
      admissions: 3,
    });

    const { runSystemSweep } = await import("../system-sweeps");
    const summary = await runSystemSweep();

    expect(runLibrarianTurnSweepMock).toHaveBeenCalledTimes(1);
    expect(summary.errors).toEqual([]);
    expect(summary.librarian).toEqual({
      deadlines: 1,
      restarts: 2,
      admissions: 3,
    });
  });

  it("ADR-183 D19: surfaces a thrown librarian sweep as an error (207 contract)", async () => {
    runLibrarianTurnSweepMock.mockRejectedValueOnce(
      new Error("librarian boom"),
    );

    const { runSystemSweep } = await import("../system-sweeps");
    const summary = await runSystemSweep();

    expect(summary.errors).toContain("librarian sweep failed: librarian boom");
    expect(summary.librarian).toBeNull();
  });

  it("surfaces deferred and quarantined reconciliation findings", async () => {
    runWorkspaceReconciliationSweepMock.mockResolvedValueOnce({
      scanned: 2,
      retained: 0,
      recovered: 0,
      preserved: 0,
      removed: 0,
      retryableFailed: 1,
      quarantined: 1,
      resolved: 0,
    });
    const { runSystemSweep } = await import("../system-sweeps");

    const summary = await runSystemSweep();

    expect(summary.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          "1 workspace reconciliation candidate(s) failed",
        ),
        expect.stringContaining(
          "1 workspace reconciliation candidate(s) quarantined",
        ),
      ]),
    );
  });

  it("runs the cost-rollup reconcile under the same scheduler-owned sweep", async () => {
    const { runSystemSweep } = await import("../system-sweeps");

    await runSystemSweep();

    expect(reconcileTerminalCostRollupsMock).toHaveBeenCalledTimes(1);
  });
});
