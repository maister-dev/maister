import "server-only";

import type {
  TerminalCause,
  TerminalCauseStatus,
} from "@/lib/domain-events/taxonomy";

import { and, desc, eq } from "drizzle-orm";
import pino from "pino";

import { domainEvents } from "@/lib/db/schema";
import { isMaisterErrorCode } from "@/lib/errors-core";
import {
  causeReason,
  isTerminalCauseStatus,
  parseTerminalCause,
  TERMINAL_CAUSE_KIND_FOR_STATUS,
} from "@/lib/domain-events/taxonomy";

const log = pino({
  name: "terminal-cause",
  level: process.env.LOG_LEVEL ?? "info",
});

// FIXME(any): dual drizzle-orm peer-dep variants.
type Db = any;

// Kind-matched: a run that crashed, recovered and then failed reads its
// `run.failed`, never the older `run.crashed` — and a recovered run that ended
// `Done` reads nothing at all.

/** An event written before `cause` existed (and the 0094 cut-over rows) is
 * read from its own `reason` / `errorCode` keys. An old reason could be prose
 * (an error message): only a well-formed token survives, so the read keeps the
 * tokens-only rule the writers keep. */
function legacyCause(payload: Record<string, unknown>): TerminalCause | null {
  const reason =
    typeof payload.reason === "string" ? payload.reason : undefined;
  const errorCode =
    typeof payload.errorCode === "string" ? payload.errorCode : undefined;
  const code =
    reason !== undefined && isMaisterErrorCode(reason)
      ? reason
      : errorCode !== undefined && isMaisterErrorCode(errorCode)
        ? errorCode
        : null;

  if (code === null && reason === undefined) return null;
  const token =
    reason !== undefined && reason !== code ? causeReason(reason) : undefined;

  return (
    parseTerminalCause({ code, reason: token, source: "legacy" }) ?? {
      code,
      source: "legacy",
    }
  );
}

/**
 * Why a `Failed | Crashed | Abandoned` run ended, derived on read from its
 * newest terminal domain event of the matching kind (served by
 * `domain_events_run_terminal_idx`). Null for every other status and when no
 * matching event exists — a project-less run never has one.
 */
export async function loadRunTerminalCause(
  db: Db,
  runId: string,
  status: string,
): Promise<TerminalCause | null> {
  if (!isTerminalCauseStatus(status)) return null;
  const [event] = await terminalCauseEventQuery(db, runId, status);

  if (!event) return null;
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  const cause = parseTerminalCause(payload.cause);

  if (cause) return cause;
  if (payload.cause !== undefined)
    log.warn({ runId, status }, "terminal-cause-unreadable");

  return legacyCause(payload);
}

/** The newest event of the kind `status` records — the one query the read
 * issues, exported so its plan can be checked against the index. */
export function terminalCauseEventQuery(
  db: Db,
  runId: string,
  status: TerminalCauseStatus,
) {
  return db
    .select({ payload: domainEvents.payload })
    .from(domainEvents)
    .where(
      and(
        eq(domainEvents.runId, runId),
        eq(domainEvents.kind, TERMINAL_CAUSE_KIND_FOR_STATUS[status]),
      ),
    )
    .orderBy(desc(domainEvents.occurredAt), desc(domainEvents.id))
    .limit(1);
}

/**
 * A scratch dialog's cause: the run's own event when it has one, else — a
 * project-less assistant run emits no event — the dialog's stored error code.
 * Only for a crash or a failure: an abandon (stop, discard, TTL) is never the
 * dialog's error, and a retryable failure's code may still sit on the row.
 */
export async function loadScratchTerminalCause(
  db: Db,
  runId: string,
  status: string,
  errorCode: string | null,
): Promise<TerminalCause | null> {
  if (!isTerminalCauseStatus(status)) return null;
  const cause = await loadRunTerminalCause(db, runId, status);

  if (cause || status === "Abandoned") return cause;

  return errorCode !== null && isMaisterErrorCode(errorCode)
    ? { code: errorCode, source: "scratch" }
    : null;
}
