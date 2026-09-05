import "server-only";

import pino from "pino";

import { runSchedulerTick } from "@/lib/scheduler/tick-service";
import { schedulerTickIntervalSeconds } from "@/lib/scheduler/timer-config";
import { isApplicationStopping } from "@/lib/server-lifecycle";

type SchedulerTimerState = {
  handle: NodeJS.Timeout | null;
  intervalSeconds: number;
  active: Promise<void> | null;
};

const TIMER_GLOBAL_KEY = Symbol.for("maister.scheduler-timer.v1");

const log = pino({
  name: "scheduler-timer",
  level: process.env.LOG_LEVEL ?? "info",
});

export function startSchedulerTimer(): void {
  if (isApplicationStopping()) return;
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
    if (state.active) return;
    state.active = runSchedulerTick()
      .then(() => {})
      .catch((err: unknown) => {
        log.error(
          { err: err instanceof Error ? err.message : String(err) },
          "scheduler fallback tick threw",
        );
      })
      .finally(() => {
        state.active = null;
      });
  }, intervalSeconds * 1_000);
  state.handle.unref?.();

  log.info({ intervalSeconds }, "scheduler fallback timer started");
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
    g[TIMER_GLOBAL_KEY] = { handle: null, intervalSeconds: 0, active: null };
  }

  return g[TIMER_GLOBAL_KEY];
}
