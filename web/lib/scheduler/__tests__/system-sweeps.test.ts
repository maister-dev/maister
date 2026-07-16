import { beforeEach, describe, expect, it, vi } from "vitest";

const runSweepTickMock = vi.hoisted(() => vi.fn());
const runReconcileSweepMock = vi.hoisted(() => vi.fn());
const reconcileTerminalCostRollupsMock = vi.hoisted(() => vi.fn());
const runWorkspaceGcSweepMock = vi.hoisted(() => vi.fn());
const runWorkspaceReconciliationSweepMock = vi.hoisted(() => vi.fn());
const runRevisionGcSweepMock = vi.hoisted(() => vi.fn());
const runCapabilitiesCleanupSweepMock = vi.hoisted(() => vi.fn());
const runEphemeralAgentGcSweepMock = vi.hoisted(() => vi.fn());
const runAgentMaterializationCleanupSweepMock = vi.hoisted(() => vi.fn());
const runSyncRecoverySweepMock = vi.hoisted(() => vi.fn());
const runBrainDecaySweepMock = vi.hoisted(() => vi.fn());
const runBrainReindexSweepMock = vi.hoisted(() => vi.fn());
const sweepEvaluationEvidenceMock = vi.hoisted(() => vi.fn());
const runPlainAgentDirectoryGcSweepMock = vi.hoisted(() => vi.fn());

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
vi.mock("@/lib/gc/agent-materialization-gc", () => ({
  runAgentMaterializationCleanupSweep: runAgentMaterializationCleanupSweepMock,
}));
// #M10: this composition added `runSyncRecoverySweep` and never mocked it, so it
// ran for real, hit getDb(), threw, and was swallowed into `errors[]` — which
// nothing asserted. The sweep was effectively absent from its own test.
vi.mock("@/lib/runs/sync-recovery", () => ({
  runSyncRecoverySweep: runSyncRecoverySweepMock,
}));
// Same exposure, PRE-EXISTING (ADR-122, not this branch): both brain sweeps were
// un-mocked too, so they threw on getDb() into the same swallowed `errors[]`.
// Mocked here so `errors: []` below is a real guard for EVERY arm — otherwise
// the next sweep to go silently broken hides behind them.
vi.mock("@/lib/brain/decay", () => ({
  runBrainDecaySweep: runBrainDecaySweepMock,
}));
vi.mock("@/lib/brain/reindex", () => ({
  runBrainReindexSweep: runBrainReindexSweepMock,
}));
vi.mock("@/lib/evaluations/evidence/gc", () => ({
  sweepEvaluationEvidence: sweepEvaluationEvidenceMock,
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

describe("scheduler system sweeps", () => {
  beforeEach(() => {
    vi.resetModules();
    runSweepTickMock.mockReset().mockResolvedValue({ idled: 0 });
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
    runAgentMaterializationCleanupSweepMock
      .mockReset()
      .mockResolvedValue({ scanned: 0, restored: 0, live: 0, failed: 0 });
    sweepEvaluationEvidenceMock
      .mockReset()
      .mockResolvedValue({ orphansMarked: 0, deleted: 0 });
    runPlainAgentDirectoryGcSweepMock
      .mockReset()
      .mockResolvedValue({ scanned: 0, removed: 0, missing: 0, failed: 0 });
  });

  it("runs every cleanup service once as part of the canonical system sweep", async () => {
    const { runSystemSweep } = await import("../system-sweeps");

    await runSystemSweep();

    expect(runWorkspaceGcSweepMock).toHaveBeenCalledTimes(1);
    expect(runWorkspaceReconciliationSweepMock).toHaveBeenCalledTimes(1);
    expect(runRevisionGcSweepMock).toHaveBeenCalledTimes(1);
    expect(runCapabilitiesCleanupSweepMock).toHaveBeenCalledTimes(1);
    expect(runEphemeralAgentGcSweepMock).toHaveBeenCalledTimes(1);
    expect(runAgentMaterializationCleanupSweepMock).toHaveBeenCalledTimes(1);
    expect(sweepEvaluationEvidenceMock).toHaveBeenCalledTimes(1);
    expect(runPlainAgentDirectoryGcSweepMock).toHaveBeenCalledTimes(1);
    expect(runSweepTickMock).toHaveBeenCalledTimes(1);
    expect(runReconcileSweepMock).toHaveBeenCalledTimes(1);
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
    expect(runAgentMaterializationCleanupSweepMock).toHaveBeenCalledTimes(1);
    expect(runSyncRecoverySweepMock).toHaveBeenCalledTimes(1);
    expect(sweepEvaluationEvidenceMock).toHaveBeenCalledTimes(1);
    expect(runPlainAgentDirectoryGcSweepMock).toHaveBeenCalledTimes(1);
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
