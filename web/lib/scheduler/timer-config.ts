import "server-only";

import type { SchedulerClockConfiguration } from "@/types/scheduler";

import { MaisterError } from "@/lib/errors";

type SchedulerTimerEnv = Readonly<Record<string, string | undefined>>;

export function readSchedulerClockStatus(
  env: SchedulerTimerEnv = process.env,
): SchedulerClockConfiguration {
  const configuredTimer =
    env.MAISTER_SCHEDULER_TIMER_ENABLED?.trim() || undefined;
  const cronTokenConfigured = Boolean(env.MAISTER_CRON_TOKEN?.trim());

  if (
    configuredTimer !== undefined &&
    configuredTimer !== "true" &&
    configuredTimer !== "false"
  )
    throw new MaisterError(
      "CONFIG",
      "MAISTER_SCHEDULER_TIMER_ENABLED must be the literal true or false when set",
    );

  const fallbackTimerEnabled =
    configuredTimer === "true" ||
    (configuredTimer === undefined && !cronTokenConfigured);

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
  env: SchedulerTimerEnv = process.env,
): number {
  const raw = env.MAISTER_SCHEDULER_TICK_INTERVAL_SECONDS;
  const parsed = raw ? Number.parseInt(raw, 10) : 60;

  if (!Number.isFinite(parsed) || parsed < 1) return 60;

  return parsed;
}
