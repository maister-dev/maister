import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getDb = vi.hoisted(() => vi.fn());

vi.mock("@/lib/db/check-migrations", () => ({
  findPendingBrainMigrations: vi.fn().mockResolvedValue([]),
  findPendingMigrations: vi.fn().mockResolvedValue([]),
}));
vi.mock("@/lib/db/client", () => ({ getDb }));
vi.mock("@/lib/runs/resume-recovery", () => ({
  runResumeRecoverySweep: vi.fn().mockResolvedValue(undefined),
  runTakeoverReturnRecoverySweep: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/reconcile", () => ({
  runReconcileSweep: vi.fn().mockResolvedValue(undefined),
  startReconcileSweeper: vi.fn(),
}));
vi.mock("@/lib/agents/registry", () => ({
  resyncAgents: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/projector/catch-up-sweep", () => ({
  runProjectorCatchUpSweep: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/runs/keepalive-sweeper", () => ({
  startKeepaliveSweeper: vi.fn(),
}));
vi.mock("@/lib/gc/sweeper", () => ({ startGcSweeper: vi.fn() }));
vi.mock("@/lib/scheduler/timer", () => ({ startSchedulerTimer: vi.fn() }));
vi.mock("@/lib/packages/catalog", () => ({
  ensureDefaultPackageSources: vi.fn().mockResolvedValue(undefined),
  refreshStaleSources: vi.fn().mockResolvedValue(undefined),
}));

import { register } from "../../instrumentation";

const originalRuntime = process.env.NEXT_RUNTIME;

describe("instrumentation DB boot boundary", () => {
  beforeEach(() => {
    process.env.NEXT_RUNTIME = "nodejs";
    getDb.mockReset();
  });

  afterEach(() => {
    if (originalRuntime === undefined) delete process.env.NEXT_RUNTIME;
    else process.env.NEXT_RUNTIME = originalRuntime;
  });

  it("rejects boot when DB client initialization fails", async () => {
    getDb.mockImplementation(() => {
      throw new Error("database unavailable");
    });

    await expect(register()).rejects.toThrow("database unavailable");
  });
});
