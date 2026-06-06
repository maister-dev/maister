import { beforeEach, describe, expect, it, vi } from "vitest";

const runSweepTickMock = vi.hoisted(() => vi.fn());
const runReconcileSweepMock = vi.hoisted(() => vi.fn());
const runWorkspaceGcSweepMock = vi.hoisted(() => vi.fn());
const runRevisionGcSweepMock = vi.hoisted(() => vi.fn());
const runCapabilitiesCleanupSweepMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/runs/keepalive-sweeper", () => ({
  runSweepTick: runSweepTickMock,
}));
vi.mock("@/lib/reconcile", () => ({
  runReconcileSweep: runReconcileSweepMock,
}));
vi.mock("@/lib/gc/workspace-gc", () => ({
  runWorkspaceGcSweep: runWorkspaceGcSweepMock,
}));
vi.mock("@/lib/gc/revision-gc", () => ({
  runRevisionGcSweep: runRevisionGcSweepMock,
}));
vi.mock("@/lib/capabilities/cleanup", () => ({
  runCapabilitiesCleanupSweep: runCapabilitiesCleanupSweepMock,
}));

const workspaceSummary = {
  scanned: 0,
  preserved: 0,
  pruned: 0,
  skippedUnpreserved: 0,
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
    runReconcileSweepMock.mockReset().mockResolvedValue({ reconciled: 0 });
    runWorkspaceGcSweepMock.mockReset().mockResolvedValue(workspaceSummary);
    runRevisionGcSweepMock.mockReset().mockResolvedValue(revisionSummary);
    runCapabilitiesCleanupSweepMock
      .mockReset()
      .mockResolvedValue({ failed: 0 });
  });

  it("runGcCompatibilitySweep runs GC + capabilities but NOT keepalive/reconcile", async () => {
    const { runGcCompatibilitySweep } = await import("../system-sweeps");

    const summary = await runGcCompatibilitySweep();

    expect(runWorkspaceGcSweepMock).toHaveBeenCalledTimes(1);
    expect(runRevisionGcSweepMock).toHaveBeenCalledTimes(1);
    expect(runCapabilitiesCleanupSweepMock).toHaveBeenCalledTimes(1);
    expect(runSweepTickMock).not.toHaveBeenCalled();
    expect(runReconcileSweepMock).not.toHaveBeenCalled();
    expect(summary).toEqual({
      worktreesPreserved: 0,
      worktreesRemoved: 0,
      revisionsRemoved: 0,
      errors: [],
    });
  });

  it("surfaces a thrown workspace sweep as an error (207 contract)", async () => {
    runWorkspaceGcSweepMock.mockRejectedValueOnce(new Error("workspace boom"));
    const { runGcCompatibilitySweep } = await import("../system-sweeps");

    const summary = await runGcCompatibilitySweep();

    expect(
      summary.errors.some((e) => e.includes("workspace sweep failed")),
    ).toBe(true);
  });

  it("runSystemSweep runs the full composition including keepalive + reconcile", async () => {
    const { runSystemSweep } = await import("../system-sweeps");

    await runSystemSweep();

    expect(runSweepTickMock).toHaveBeenCalledTimes(1);
    expect(runReconcileSweepMock).toHaveBeenCalledTimes(1);
    expect(runWorkspaceGcSweepMock).toHaveBeenCalledTimes(1);
    expect(runRevisionGcSweepMock).toHaveBeenCalledTimes(1);
    expect(runCapabilitiesCleanupSweepMock).toHaveBeenCalledTimes(1);
  });
});
