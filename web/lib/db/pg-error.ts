import { DrizzleQueryError } from "drizzle-orm";

import { MaisterError } from "@/lib/errors-core";

/** The Postgres driver error fields MAIster branches on. */
export type PgDriverError = {
  code: string;
  constraint?: string;
  message?: string;
};

// Five characters with at least one digit, so "CRASH" or "EPIPE" never pass.
const SQLSTATE = /^(?=.*\d)[0-9A-Z]{5}$/u;

/**
 * The Postgres driver error behind `err`, or null. drizzle-orm >= 0.44 wraps
 * every failed query in a `DrizzleQueryError` whose `cause` is the driver error,
 * so a bare `err.code` check no longer sees the SQLSTATE.
 */
export function pgErrorOf(err: unknown): PgDriverError | null {
  let current: unknown = err;

  for (let depth = 0; depth < 5 && current; depth += 1) {
    const { code } = current as { code?: unknown };

    if (typeof code === "string" && SQLSTATE.test(code)) {
      return current as PgDriverError;
    }
    current = (current as { cause?: unknown }).cause;
  }

  return null;
}

export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  const pg = pgErrorOf(err);

  return (
    pg?.code === "23505" &&
    (constraint === undefined || pg.constraint === constraint)
  );
}

/** Safe diagnostics for queries whose parameters may contain protected input. */
export function queryErrorDiagnostics(error: unknown): {
  errorType: string;
  sqlState?: string;
  constraint?: string;
} {
  const pg = pgErrorOf(error);

  return {
    errorType: error instanceof Error ? error.name : typeof error,
    sqlState: pg?.code,
    constraint: pg?.constraint,
  };
}

/** Drop query parameters and the raw cause before errors reach logs or public state. */
export function redactQueryError(error: unknown): unknown {
  if (!(error instanceof DrizzleQueryError)) return error;

  return new MaisterError("CRASH", "Database operation failed", {
    details: queryErrorDiagnostics(error),
  });
}
