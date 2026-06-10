import "server-only";

import { Cron } from "croner";

import { MaisterError } from "@/lib/errors";

const CRON_FIELD_COUNT = 5;

export function validateTimezone(timezone: string): void {
  if (timezone.trim().length === 0) {
    throw new MaisterError("CONFIG", "timezone must be a non-empty IANA name");
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
  } catch {
    throw new MaisterError(
      "CONFIG",
      `unknown IANA timezone: ${JSON.stringify(timezone)}`,
    );
  }
}

function buildCron(cronExpr: string, timezone: string): Cron {
  const fields = cronExpr.trim().split(/\s+/);

  if (fields.length !== CRON_FIELD_COUNT) {
    throw new MaisterError(
      "CONFIG",
      `cron expression must be 5-field (minute hour day month weekday), got ${JSON.stringify(cronExpr)}`,
    );
  }
  try {
    return new Cron(cronExpr, { timezone });
  } catch (err) {
    throw new MaisterError(
      "CONFIG",
      `invalid cron expression ${JSON.stringify(cronExpr)}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export function validateCronExpression(
  cronExpr: string,
  timezone: string,
): void {
  validateTimezone(timezone);
  const cron = buildCron(cronExpr, timezone);

  if (cron.nextRun() === null) {
    throw new MaisterError(
      "CONFIG",
      `cron expression ${JSON.stringify(cronExpr)} never matches`,
    );
  }
}

export function nextFireAt(
  cronExpr: string,
  timezone: string,
  from: Date,
): Date {
  validateTimezone(timezone);
  const next = buildCron(cronExpr, timezone).nextRun(from);

  if (next === null) {
    throw new MaisterError(
      "CONFIG",
      `cron expression ${JSON.stringify(cronExpr)} never matches`,
    );
  }

  return next;
}
