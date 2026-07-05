import "server-only";

import type { SchedulerClockStatus } from "@/types/scheduler";

export function readSchedulerClockStatus(
  env: NodeJS.ProcessEnv = process.env,
): SchedulerClockStatus {
  const fallbackTimerEnabled = env.MAISTER_SCHEDULER_TIMER_ENABLED === "true";
  const cronTokenConfigured = Boolean(env.MAISTER_CRON_TOKEN);

  return {
    cronTokenConfigured,
    driver: fallbackTimerEnabled
      ? "fallback_timer"
      : cronTokenConfigured
        ? "external_tick"
        : "missing_tick",
    fallbackTimerEnabled,
    tickIntervalSeconds: schedulerTickIntervalSeconds(env),
    tickPath: "/api/cron/tick",
  };
}

export function schedulerTickIntervalSeconds(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env.MAISTER_SCHEDULER_TICK_INTERVAL_SECONDS;
  const parsed = raw ? Number.parseInt(raw, 10) : 60;

  if (!Number.isFinite(parsed) || parsed < 1) return 60;

  return parsed;
}
