import "server-only";

import type { Db } from "./db";
import type { ExecutionHosts } from "./client";

import { and, asc, eq, gt, inArray, isNull, lt, or, sql } from "drizzle-orm";
import pino, { type Logger } from "pino";

import { executionHosts as defaultExecutionHosts } from "./client";
import { TERMINAL_COMMAND_STATES } from "./types";

import {
  executionCommands,
  executionEventStreams,
  executionEvents,
  runs,
} from "@/lib/db/schema";
import { getDb } from "@/lib/db/client";
import { isMaisterError } from "@/lib/errors";
import { isApplicationStopping } from "@/lib/server-lifecycle";

// Retirement is bounded by the SAME window the ledger already promises for a
// legal retry. Widening it silently would widen the idempotency claim too.
export const COMMAND_REPLAY_GRACE_DAYS = 7;

const RETIREMENT_BATCH_SIZE = 100;

const defaultLog = pino({
  name: "execution-host",
  level: process.env.LOG_LEVEL ?? "info",
}).child({ component: "command-retirement" });

// A run whose commands may still be replayed by a driver. Retirement waits for
// the run to leave every live status, not merely for its age.
const RETAINED_RUN_STATUSES = [
  "Pending",
  "Running",
  "NeedsInput",
  "NeedsInputIdle",
  "HumanWorking",
  "Review",
] as const;

export type CommandProtectedReason =
  | "pre_activation_unowned"
  | "owner_unapplied"
  | "terminal_evidence_missing"
  | "terminal_event_unacked"
  | "run_retained"
  | "replay_grace"
  | "host_evidence_missing"
  | "host_refused";

export type CommandRetirementSummary = {
  examined: number;
  retired: number;
  protected: number;
  failed: number;
  reasons: Partial<Record<CommandProtectedReason, number>>;
  cursor: RetirementCursor | null;
};

export type RetirementCursor = { completedAt: Date; id: string };

export type CommandRetirementOptions = {
  db?: Db;
  hosts?: ExecutionHosts;
  now?: Date;
  limit?: number;
  after?: RetirementCursor;
  logger?: Logger;
};

type Candidate = {
  id: string;
  runId: string;
  executionHostId: string;
  kind: string;
  ownerKind: string | null;
  assignmentEpoch: number;
  state: string;
  applicationState: string;
  requestSha256: string | null;
  terminalEvidenceSha256: string | null;
  completedAt: Date;
  terminalEventId: string | null;
  terminalHostSequence: bigint | null;
  ackConfirmedSequence: bigint | null;
  runStatus: string;
};

// Every disqualifying fact is read in ONE keyset page so the scan cost is a
// function of the page, not of how many rows happen to be protected.
async function loadCandidates(
  db: Db,
  opts: { limit: number; after?: RetirementCursor },
): Promise<Candidate[]> {
  const predicate = [
    isNull(executionCommands.retiredAt),
    inArray(executionCommands.state, [...TERMINAL_COMMAND_STATES]),
    sql`${executionCommands.completedAt} IS NOT NULL`,
  ];

  if (opts.after) {
    predicate.push(
      or(
        gt(executionCommands.completedAt, opts.after.completedAt),
        and(
          eq(executionCommands.completedAt, opts.after.completedAt),
          gt(executionCommands.id, opts.after.id),
        ),
      )!,
    );
  }

  const rows = await db
    .select({
      id: executionCommands.id,
      runId: executionCommands.runId,
      executionHostId: executionCommands.executionHostId,
      kind: executionCommands.kind,
      ownerKind: executionCommands.ownerKind,
      assignmentEpoch: executionCommands.assignmentEpoch,
      state: executionCommands.state,
      applicationState: executionCommands.applicationState,
      requestSha256: executionCommands.requestSha256,
      terminalEvidenceSha256: executionCommands.terminalEvidenceSha256,
      completedAt: executionCommands.completedAt,
      terminalEventId: executionCommands.terminalEventId,
      terminalHostSequence: executionEvents.hostSequence,
      ackConfirmedSequence: executionEventStreams.lastAckConfirmedSequence,
      runStatus: runs.status,
    })
    .from(executionCommands)
    .innerJoin(runs, eq(runs.id, executionCommands.runId))
    .leftJoin(
      executionEvents,
      eq(executionEvents.id, executionCommands.terminalEventId),
    )
    .leftJoin(
      executionEventStreams,
      eq(executionEventStreams.id, executionEvents.eventStreamId),
    )
    .where(and(...predicate))
    .orderBy(asc(executionCommands.completedAt), asc(executionCommands.id))
    .limit(opts.limit);

  return rows as Candidate[];
}

// Eligibility is derived, never asserted. Each branch names the concrete
// obligation still outstanding so a stuck row is diagnosable without
// re-deriving the predicate by hand. An owned prompt is the only kind carrying
// a continuation obligation and a canonical terminal event; an UNOWNED prompt
// is a pre-v2 row whose classification belongs to the staged activation, never
// to age.
export function classifyCommandRetirement(
  row: Candidate,
  opts: { now: Date; graceMs: number },
): CommandProtectedReason | null {
  if (RETAINED_RUN_STATUSES.includes(row.runStatus as never)) {
    return "run_retained";
  }
  if (row.completedAt.getTime() + opts.graceMs > opts.now.getTime()) {
    return "replay_grace";
  }
  if (row.kind === "session.prompt") {
    // S2.12 preserved these unreconstructed: no owner ever existed, so there is
    // no obligation to discharge and no proof to retire against. They are a
    // bounded historical set that stops growing at activation.
    if (!row.ownerKind) return "pre_activation_unowned";
    if (
      row.applicationState !== "applied" &&
      row.applicationState !== "superseded"
    ) {
      return "owner_unapplied";
    }
    if (!row.terminalEventId || row.terminalHostSequence === null) {
      return "terminal_evidence_missing";
    }
    if (
      row.ackConfirmedSequence === null ||
      row.ackConfirmedSequence < row.terminalHostSequence
    ) {
      return "terminal_event_unacked";
    }
  }

  return null;
}

function retirementPhase(state: string): "completed" | "rejected" {
  return state === "succeeded" ? "completed" : "rejected";
}

// The tombstone: identity, digests and outcome disposition survive; the
// executable request does not. A stale replay can still be recognised and
// fenced, but it can no longer be re-issued from this row.
async function compact(db: Db, commandId: string, retiredAt: Date) {
  await db
    .update(executionCommands)
    .set({
      retiredAt,
      requestCanonicalJson: null,
      createIntent: null,
      receiptEvidence: null,
      result: null,
      lastError: null,
      payload: {},
      updatedAt: retiredAt,
    })
    .where(
      and(
        eq(executionCommands.id, commandId),
        isNull(executionCommands.retiredAt),
      ),
    );
}

export async function retireEligibleCommands(
  opts: CommandRetirementOptions = {},
): Promise<CommandRetirementSummary> {
  const db = opts.db ?? getDb();
  const hosts = opts.hosts ?? defaultExecutionHosts;
  const now = opts.now ?? new Date();
  const log = opts.logger ?? defaultLog;
  const graceMs = COMMAND_REPLAY_GRACE_DAYS * 24 * 60 * 60 * 1000;
  const summary: CommandRetirementSummary = {
    examined: 0,
    retired: 0,
    protected: 0,
    failed: 0,
    reasons: {},
    cursor: opts.after ?? null,
  };
  const candidates = await loadCandidates(db, {
    limit: opts.limit ?? RETIREMENT_BATCH_SIZE,
    ...(opts.after ? { after: opts.after } : {}),
  });
  const admin = hosts.local();

  for (const row of candidates) {
    if (isApplicationStopping()) break;
    summary.examined += 1;
    // The cursor advances past protected rows too: a permanently protected
    // command must never stall the rows behind it (D5 fairness).
    summary.cursor = { completedAt: row.completedAt, id: row.id };

    const note = (reason: CommandProtectedReason) => {
      summary.protected += 1;
      summary.reasons[reason] = (summary.reasons[reason] ?? 0) + 1;
      log.debug(
        {
          commandId: row.id,
          runId: row.runId,
          kind: row.kind,
          reason,
          applicationState: row.applicationState,
          state: row.state,
        },
        "command-retirement-protected",
      );
    };
    const local = classifyCommandRetirement(row, { now, graceMs });

    if (local) {
      note(local);
      continue;
    }

    const phase = retirementPhase(row.state);
    let ack;

    try {
      ack = await admin.retireCommand(row.id, {
        expectedRequestSha256: row.requestSha256,
        expectedPhase: phase,
        assignmentEpoch: row.assignmentEpoch,
      });
    } catch (error) {
      const reason: CommandProtectedReason = isMaisterError(error)
        ? error.details?.reason === "retirement_evidence_missing"
          ? "host_evidence_missing"
          : "host_refused"
        : "host_refused";

      note(reason);
      summary.failed += 1;
      log.warn(
        {
          commandId: row.id,
          runId: row.runId,
          kind: row.kind,
          reason,
          code: isMaisterError(error) ? error.code : "UNKNOWN",
        },
        "command-retirement-refused",
      );
      continue;
    }

    await compact(db, row.id, now);
    summary.retired += 1;
    log.info(
      {
        commandId: row.id,
        runId: row.runId,
        kind: row.kind,
        applicationState: row.applicationState,
        phase: ack.phase,
        requestSha256: ack.requestSha256,
        terminalEvidenceSha256: row.terminalEvidenceSha256,
        hostCompacted: ack.compacted,
      },
      "command-retired",
    );
  }

  if (summary.examined > 0) {
    log.info(
      {
        examined: summary.examined,
        retired: summary.retired,
        protected: summary.protected,
        failed: summary.failed,
        reasons: summary.reasons,
      },
      "command-retirement-pass",
    );
  }

  return summary;
}

// A terminal command whose host receipt vanished is reconciliation work, not a
// silent wait: it is reported on every pass until an operator resolves it.
export async function reportUnreconciledCommands(
  opts: { db?: Db; now?: Date; logger?: Logger; limit?: number } = {},
): Promise<number> {
  const db = opts.db ?? getDb();
  const now = opts.now ?? new Date();
  const log = opts.logger ?? defaultLog;
  const rows = await db
    .select({
      id: executionCommands.id,
      runId: executionCommands.runId,
      kind: executionCommands.kind,
      state: executionCommands.state,
      applicationState: executionCommands.applicationState,
      completedAt: executionCommands.completedAt,
    })
    .from(executionCommands)
    .where(
      and(
        isNull(executionCommands.retiredAt),
        inArray(executionCommands.state, [...TERMINAL_COMMAND_STATES]),
        eq(executionCommands.kind, "session.prompt"),
        isNull(executionCommands.terminalEventId),
        lt(
          executionCommands.completedAt,
          new Date(
            now.getTime() - COMMAND_REPLAY_GRACE_DAYS * 24 * 60 * 60 * 1000,
          ),
        ),
      ),
    )
    .limit(opts.limit ?? RETIREMENT_BATCH_SIZE);

  for (const row of rows) {
    log.warn(
      {
        commandId: row.id,
        runId: row.runId,
        kind: row.kind,
        state: row.state,
        applicationState: row.applicationState,
        completedAt: row.completedAt?.toISOString(),
      },
      "command-terminal-evidence-missing",
    );
  }

  return rows.length;
}
