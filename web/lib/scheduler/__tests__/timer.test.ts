import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runSchedulerTickMock = vi.hoisted(() => vi.fn());
const logger = vi.hoisted(() => ({
  debug: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("pino", () => ({ default: () => logger }));
vi.mock("@/lib/scheduler/tick-service", () => ({
  runSchedulerTick: runSchedulerTickMock,
}));
vi.mock("@/lib/server-lifecycle", () => ({
  isApplicationStopping: () => false,
}));

import {
  getSchedulerClockHealth,
  schedulerTickFinished,
  schedulerTickStarted,
} from "@/lib/scheduler/clock-health";
import { startSchedulerTimer, stopSchedulerTimer } from "@/lib/scheduler/timer";

describe("scheduler fallback timer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    delete (globalThis as unknown as Record<symbol, unknown>)[
      Symbol.for("maister.scheduler-timer.v2")
    ];
    delete (globalThis as unknown as Record<symbol, unknown>)[
      Symbol.for("maister.scheduler-clock-health.v1")
    ];
    process.env.MAISTER_SCHEDULER_TIMER_ENABLED = "true";
    process.env.MAISTER_SCHEDULER_TICK_INTERVAL_SECONDS = "1";
    delete process.env.MAISTER_CRON_TOKEN;
    runSchedulerTickMock.mockReset();
    for (const method of Object.values(logger)) method.mockReset();
  });

  afterEach(async () => {
    await stopSchedulerTimer();
    vi.useRealTimers();
    delete process.env.MAISTER_SCHEDULER_TIMER_ENABLED;
    delete process.env.MAISTER_SCHEDULER_TICK_INTERVAL_SECONDS;
    delete process.env.MAISTER_KEEPALIVE_SWEEP_INTERVAL_SECONDS;
    delete process.env.MAISTER_RECONCILE_SWEEP_INTERVAL_SECONDS;
  });

  it("counts a slow-tick overlap and emits one warning for the streak", async () => {
    let finish!: () => void;

    runSchedulerTickMock.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );

    startSchedulerTimer();
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(3_000);

    const duringOverlap = getSchedulerClockHealth();

    finish();
    await stopSchedulerTimer();

    expect(runSchedulerTickMock).toHaveBeenCalledOnce();
    expect(duringOverlap).toMatchObject({
      skippedOverlapCurrentStreak: 3,
      skippedOverlapTotal: 3,
    });
    expect(
      logger.warn.mock.calls.filter(
        ([, message]) =>
          message === "scheduler tick skipped: previous tick still running",
      ),
    ).toHaveLength(1);

    expect(getSchedulerClockHealth()).toMatchObject({
      skippedOverlapCurrentStreak: 0,
      skippedOverlapLastStreak: 3,
      skippedOverlapTotal: 3,
    });
  });

  it("keeps overlapping invocation fields coherent", () => {
    const first = schedulerTickStarted(
      "cron",
      new Date("2026-09-22T10:00:00Z"),
    );
    const second = schedulerTickStarted(
      "manual",
      new Date("2026-09-22T10:00:01Z"),
    );

    schedulerTickFinished(second, "partial", new Date("2026-09-22T10:00:02Z"));
    schedulerTickFinished(first, "completed", new Date("2026-09-22T10:00:03Z"));

    expect(getSchedulerClockHealth()).toMatchObject({
      activeCount: 0,
      lastCompleted: {
        invocationId: first.invocationId,
        outcome: "completed",
        startedAt: "2026-09-22T10:00:00.000Z",
        finishedAt: "2026-09-22T10:00:03.000Z",
      },
    });
  });

  it("warns once for each present retired interval without refusing boot", async () => {
    process.env.MAISTER_KEEPALIVE_SWEEP_INTERVAL_SECONDS = "not-a-number";
    process.env.MAISTER_RECONCILE_SWEEP_INTERVAL_SECONDS = "";
    runSchedulerTickMock.mockResolvedValue({
      failedCount: 0,
      skippedCount: 0,
    });

    startSchedulerTimer();
    startSchedulerTimer();

    const warnings = logger.warn.mock.calls.filter(
      ([, message]) =>
        message ===
        "scheduler interval variable ignored; work runs inside system_sweep",
    );

    expect(warnings).toHaveLength(2);
    expect(warnings.map(([fields]) => fields)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          variable: "MAISTER_KEEPALIVE_SWEEP_INTERVAL_SECONDS",
        }),
        expect.objectContaining({
          variable: "MAISTER_RECONCILE_SWEEP_INTERVAL_SECONDS",
        }),
      ]),
    );
  });
});
