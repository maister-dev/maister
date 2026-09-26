import pino from "pino";

import { MaisterError } from "@/lib/errors";

const log = pino({
  name: "librarian.config",
  level: process.env.LOG_LEVEL ?? "info",
});

export interface LibrarianConfig {
  maxConcurrentTurns: number;
  turnMaxMinutes: number;
  contextMaxChars: number;
  dailyTurnsPerUser: number;
  operationReconcileSeconds: number;
  historyRetentionDays: number;
  snapshotRetentionDays: number;
  confirmationTtlMinutes: number;
}

const ENV_NAMES: Record<keyof LibrarianConfig, string> = {
  maxConcurrentTurns: "MAISTER_MAX_CONCURRENT_LIBRARIAN_TURNS",
  turnMaxMinutes: "MAISTER_LIBRARIAN_TURN_MAX_MINUTES",
  contextMaxChars: "MAISTER_LIBRARIAN_CONTEXT_MAX_CHARS",
  dailyTurnsPerUser: "MAISTER_LIBRARIAN_DAILY_TURNS_PER_USER",
  operationReconcileSeconds: "MAISTER_LIBRARIAN_OPERATION_RECONCILE_SECONDS",
  historyRetentionDays: "MAISTER_LIBRARIAN_HISTORY_RETENTION_DAYS",
  snapshotRetentionDays: "MAISTER_LIBRARIAN_SNAPSHOT_RETENTION_DAYS",
  confirmationTtlMinutes: "MAISTER_LIBRARIAN_CONFIRMATION_TTL_MINUTES",
};

export const LIBRARIAN_CONFIG_DEFAULTS: Readonly<LibrarianConfig> =
  Object.freeze({
    maxConcurrentTurns: 3,
    turnMaxMinutes: 10,
    contextMaxChars: 60_000,
    dailyTurnsPerUser: 200,
    operationReconcileSeconds: 120,
    historyRetentionDays: 365,
    snapshotRetentionDays: 30,
    confirmationTtlMinutes: 60,
  });

// D17: every budget is finite. A value that is not a plain positive integer
// refuses with CONFIG instead of silently falling back to the default, so a
// typo cannot quietly lift a bound.
function readPositiveInteger(
  env: Record<string, string | undefined>,
  name: string,
  fallback: number,
): number {
  const raw = env[name];

  if (raw === undefined) return fallback;
  if (
    !/^\d+$/.test(raw) ||
    Number(raw) <= 0 ||
    !Number.isSafeInteger(Number(raw))
  ) {
    throw new MaisterError(
      "CONFIG",
      `${name} must be a positive integer, got ${JSON.stringify(raw)}`,
      { details: { variable: name } },
    );
  }

  return Number(raw);
}

export function readLibrarianConfig(
  env: Record<string, string | undefined> = process.env,
): LibrarianConfig {
  const resolved = {} as LibrarianConfig;

  for (const key of Object.keys(ENV_NAMES) as (keyof LibrarianConfig)[]) {
    resolved[key] = readPositiveInteger(
      env,
      ENV_NAMES[key],
      LIBRARIAN_CONFIG_DEFAULTS[key],
    );
  }

  return resolved;
}

let cached: LibrarianConfig | null = null;

export function librarianConfig(): LibrarianConfig {
  if (cached) return cached;
  cached = readLibrarianConfig();
  log.info({ config: cached }, "librarian-config-resolved");

  return cached;
}

export function resetLibrarianConfigForTests(): void {
  cached = null;
}
