import "server-only";

import pino from "pino";

import {
  getSchedulerClockHealth,
  noteSchedulerTimerOverlap,
  settleSchedulerTimerOverlap,
} from "@/lib/scheduler/clock-health";
import { runSchedulerTick } from "@/lib/scheduler/tick-service";
import {
  readSchedulerClockStatus,
  schedulerTickIntervalSeconds,
} from "@/lib/scheduler/timer-config";
import { isApplicationStopping } from "@/lib/server-lifecycle";

type SchedulerTimerState = {
  handle: NodeJS.Timeout | null;
  intervalSeconds: number;
  active: Promise<void> | null;
  retiredEnvWarned: boolean;
};

// v1 survives HMR without retiredEnvWarned, so reusing it would skip the
// shape initialization and make the retirement warning nondeterministic.
const TIMER_GLOBAL_KEY = Symbol.for("maister.scheduler-timer.v2");

const log = pino({
  name: "scheduler-timer",
  level: process.env.LOG_LEVEL ?? "info",
});

export function startSchedulerTimer(): void {
  if (isApplicationStopping()) return;
  const state = globalState();

  if (!state.retiredEnvWarned) {
    for (const variable of [
      "MAISTER_RECONCILE_SWEEP_INTERVAL_SECONDS",
      "MAISTER_KEEPALIVE_SWEEP_INTERVAL_SECONDS",
    ] as const) {
      if (Object.hasOwn(process.env, variable))
        log.warn(
          {
            variable,
            retirement: "P0-6 (2026-09-22)",
          },
          "scheduler interval variable ignored; work runs inside system_sweep",
        );
    }
    state.retiredEnvWarned = true;
  }
  const clock = readSchedulerClockStatus();

  if (!clock.fallbackTimerEnabled) {
    if (clock.driver === "missing_tick")
      log.warn(
        {
          driver: clock.driver,
          configuration: [
            "MAISTER_SCHEDULER_TIMER_ENABLED",
            "MAISTER_CRON_TOKEN",
          ],
        },
        "scheduler clock is not configured",
      );
    else
      log.debug({ driver: clock.driver }, "scheduler fallback timer disabled");

    return;
  }

  const intervalSeconds = schedulerTickIntervalSeconds();

  if (state.handle) {
    if (state.intervalSeconds === intervalSeconds) return;

    clearInterval(state.handle);
    state.handle = null;
  }

  state.intervalSeconds = intervalSeconds;
  state.handle = setInterval(() => {
    if (state.active) {
      const overlap = noteSchedulerTimerOverlap();

      if (overlap.currentStreak === 1)
        log.warn(
          {
            skippedOverlapTotal: overlap.total,
            streakLength: overlap.currentStreak,
          },
          "scheduler tick skipped: previous tick still running",
        );

      return;
    }
    state.active = runSchedulerTick({ source: "timer" })
      .then(() => {})
      .catch((err: unknown) => {
        log.error(
          { err: err instanceof Error ? err.message : String(err) },
          "scheduler fallback tick threw",
        );
      })
      .finally(() => {
        const settledStreak = settleSchedulerTimerOverlap();
        const health = getSchedulerClockHealth();

        if (settledStreak > 0)
          log.info(
            {
              durationMs: health.lastCompleted?.durationMs ?? null,
              outcome: health.lastCompleted?.outcome ?? null,
              streakLength: settledStreak,
            },
            "scheduler overlap streak settled",
          );
        state.active = null;
      });
  }, intervalSeconds * 1_000);
  state.handle.unref?.();

  log.info(
    { driver: clock.driver, intervalSeconds },
    "scheduler fallback timer started",
  );
}

export async function stopSchedulerTimer(): Promise<void> {
  const state = globalState();

  if (state.handle) clearInterval(state.handle);
  state.handle = null;
  await state.active;
  log.info({}, "scheduler fallback timer stopped");
}

function globalState(): SchedulerTimerState {
  const g = globalThis as unknown as Record<symbol, SchedulerTimerState>;

  if (!g[TIMER_GLOBAL_KEY]) {
    g[TIMER_GLOBAL_KEY] = {
      handle: null,
      intervalSeconds: 0,
      active: null,
      retiredEnvWarned: false,
    };
  }

  return g[TIMER_GLOBAL_KEY];
}
