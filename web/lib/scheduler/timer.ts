import "server-only";

import pino from "pino";

import { runSchedulerTick } from "@/lib/scheduler/tick-service";
import { schedulerTickIntervalSeconds } from "@/lib/scheduler/timer-config";

type SchedulerTimerState = {
  handle: NodeJS.Timeout | null;
  intervalSeconds: number;
};

const TIMER_GLOBAL_KEY = Symbol.for("maister.scheduler-timer.v1");

const log = pino({
  name: "scheduler-timer",
  level: process.env.LOG_LEVEL ?? "info",
});

export function startSchedulerTimer(): void {
  if (process.env.MAISTER_SCHEDULER_TIMER_ENABLED !== "true") {
    log.debug({}, "scheduler fallback timer disabled");

    return;
  }

  const state = globalState();
  const intervalSeconds = schedulerTickIntervalSeconds();

  if (state.handle) {
    if (state.intervalSeconds === intervalSeconds) return;

    clearInterval(state.handle);
    state.handle = null;
  }

  state.intervalSeconds = intervalSeconds;
  state.handle = setInterval(() => {
    void runSchedulerTick().catch((err: unknown) => {
      log.error(
        { err: err instanceof Error ? err.message : String(err) },
        "scheduler fallback tick threw",
      );
    });
  }, intervalSeconds * 1_000);
  state.handle.unref?.();

  log.info({ intervalSeconds }, "scheduler fallback timer started");
}

export function stopSchedulerTimer(): void {
  const state = globalState();

  if (!state.handle) return;

  clearInterval(state.handle);
  state.handle = null;
  log.info({}, "scheduler fallback timer stopped");
}

function globalState(): SchedulerTimerState {
  const g = globalThis as unknown as Record<symbol, SchedulerTimerState>;

  if (!g[TIMER_GLOBAL_KEY]) {
    g[TIMER_GLOBAL_KEY] = { handle: null, intervalSeconds: 0 };
  }

  return g[TIMER_GLOBAL_KEY];
}
