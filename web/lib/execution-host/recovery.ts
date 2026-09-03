import type { Db } from "./db";
import type { ExecutionCommand, ExecutionHost } from "@/lib/db/schema";
import type { CommandReceipt, ExecutionHostTransport } from "./contracts";
import type { CommandEnvelope, CommandKind } from "./types";
import type { LegacyBackfillSummary } from "./legacy";

import { and, eq, inArray, lt, notInArray } from "drizzle-orm";
import pino, { type Logger } from "pino";

import { setAssignmentWorkspace } from "./assignments";
import {
  loadOpenCommands,
  markFailed,
  markFenced,
  markSucceeded,
  pruneTerminalCommands,
} from "./commands";
import { deliverCommand } from "./deliverer";
import { getHostById, LIVE_DRIVER_RUN_STATUSES } from "./hosts";
import { buildEnvelope } from "./ledger";
import { defaultTransport } from "./default-transport";
import { adoptLegacyActiveRuns } from "./legacy";
import {
  DELIVERING_IN_FLIGHT_GRACE_MS,
  EXECUTION_COMMAND_RETENTION_DAYS,
} from "./types";

import { persistRunSessionHostBinding } from "@/lib/runs/active-run-session";
import { executionAssignments, runs } from "@/lib/db/schema";
import { getDb } from "@/lib/db/client";

const defaultLog = pino({
  name: "execution-host",
  level: process.env.LOG_LEVEL ?? "info",
}).child({ component: "recovery" });

export type ExecutionCommandRecoverySummary = {
  scanned: number;
  redelivered: number;
  orphaned: number;
  folded: number;
  turnLost: number;
  skippedInFlight: number;
  errors: string[];
};

export type RecoveryOptions = {
  db?: Db;
  transport?: ExecutionHostTransport;
  now?: () => Date;
  // Rows touched more recently than this are a LIVE driver's (in-flight
  // protection, X-EH-16). Startup passes 0 — no driver of this process exists
  // yet; the periodic pass keeps the 60 s default.
  graceMs?: number;
  logger?: Logger;
};

function ageMs(row: ExecutionCommand, now: Date): number {
  const since = row.deliveringSince ?? row.updatedAt;

  return now.getTime() - since.getTime();
}

function envelopeFor(
  row: ExecutionCommand,
  host: ExecutionHost,
): CommandEnvelope {
  return buildEnvelope({
    commandId: row.id,
    kind: row.kind as CommandKind,
    hostKey: host.hostKey,
    assignmentId: row.executionAssignmentId,
    assignmentEpoch: row.assignmentEpoch,
    runId: row.runId,
    payload: row.payload,
    issuedAt: row.createdAt,
  });
}

// The deliverer is the ONE send path — recovery only re-enters it for the
// driverless kinds (their effect needs no waiting driver).
function driverlessSend(
  row: ExecutionCommand,
  transport: ExecutionHostTransport,
): ((envelope: CommandEnvelope<unknown>) => Promise<unknown>) | null {
  const target = row.targetSessionId;

  if (!target) return null;
  switch (row.kind as CommandKind) {
    case "session.delete":
      return (envelope) =>
        transport.deleteSession(
          target,
          envelope as CommandEnvelope<Record<string, never>>,
        );
    case "workspace.release":
      return (envelope) =>
        transport.releaseWorkspace(
          target,
          envelope as CommandEnvelope<Record<string, never>>,
        );
    default:
      return null;
  }
}

// ADR-165 D5 W2/W4: fold a host receipt into the ledger together with the
// result-derived domain writes the lost ack tx would have made.
async function foldReceipt(
  db: Db,
  row: ExecutionCommand,
  receipt: CommandReceipt,
  now: Date,
  logger: Logger,
): Promise<"folded" | "turnLost" | "skippedInFlight"> {
  if (receipt.phase === "completed") {
    await db.transaction(async (tx) => {
      const txDb = tx as unknown as Db;

      await markSucceeded(txDb, row.id, null, receipt.body, { logger, now });
      if (row.kind === "session.create") {
        const payload = row.payload as { sessionName?: unknown };
        const body = receipt.body as {
          sessionId?: unknown;
          acpSessionId?: unknown;
        };

        if (typeof body.sessionId === "string") {
          await persistRunSessionHostBinding(txDb, {
            runId: row.runId,
            sessionName:
              typeof payload.sessionName === "string"
                ? payload.sessionName
                : "default",
            hostSessionId: body.sessionId,
            acpSessionId:
              typeof body.acpSessionId === "string" ? body.acpSessionId : null,
            executionAssignmentId: row.executionAssignmentId,
          });
        }
      }
      if (row.kind === "workspace.adopt") {
        const body = receipt.body as { executionWorkspaceId?: unknown };

        if (typeof body.executionWorkspaceId === "string") {
          await setAssignmentWorkspace(
            txDb,
            row.executionAssignmentId,
            body.executionWorkspaceId,
            now,
          );
        }
      }
    });
    logger.info(
      {
        commandId: row.id,
        commandKind: row.kind,
        runId: row.runId,
        outcome: "succeeded",
      },
      "command-recovered-from-receipt",
    );

    return "folded";
  }

  if (receipt.phase === "rejected") {
    const body = receipt.body as { code?: unknown };
    const fenced = body.code === "FENCED";

    await (fenced ? markFenced : markFailed)(db, row.id, null, receipt.body, {
      logger,
      now,
    });
    logger.warn(
      {
        commandId: row.id,
        commandKind: row.kind,
        runId: row.runId,
        outcome: fenced ? "fenced" : "failed",
      },
      "command-recovered-from-receipt",
    );

    return "folded";
  }

  if (receipt.inflight) return "skippedInFlight";

  await markFailed(
    db,
    row.id,
    null,
    { code: "ACP_PROTOCOL", reason: "turn_lost" },
    { logger, now },
  );
  logger.warn(
    {
      commandId: row.id,
      commandKind: row.kind,
      runId: row.runId,
      outcome: "failed",
    },
    "command-turn-lost",
  );

  return "turnLost";
}

async function orphan(
  db: Db,
  row: ExecutionCommand,
  reason: "ORPHANED" | "receipt_missing",
  now: Date,
  logger: Logger,
): Promise<void> {
  await markFailed(
    db,
    row.id,
    null,
    { code: "CRASH", reason },
    { logger, now },
  );
  logger.warn(
    { commandId: row.id, commandKind: row.kind, runId: row.runId, reason },
    "command-orphaned",
  );
}

// ADR-165 D5 crash windows W1/W2/W4 — startup and the periodic sweep pass.
export async function recoverExecutionCommands(
  opts: RecoveryOptions = {},
): Promise<ExecutionCommandRecoverySummary> {
  const db = opts.db ?? getDb();
  const transport = opts.transport ?? defaultTransport();
  const logger = opts.logger ?? defaultLog;
  const now = opts.now ?? (() => new Date());
  const graceMs = opts.graceMs ?? DELIVERING_IN_FLIGHT_GRACE_MS;
  const summary: ExecutionCommandRecoverySummary = {
    scanned: 0,
    redelivered: 0,
    orphaned: 0,
    folded: 0,
    turnLost: 0,
    skippedInFlight: 0,
    errors: [],
  };
  const hosts = new Map<string, ExecutionHost | null>();
  const hostFor = async (id: string) => {
    if (!hosts.has(id)) hosts.set(id, await getHostById(db, id));

    return hosts.get(id) ?? null;
  };

  for (const row of await loadOpenCommands(db)) {
    summary.scanned += 1;
    const at = now();

    if (ageMs(row, at) < graceMs) {
      summary.skippedInFlight += 1;
      continue;
    }

    try {
      const host = await hostFor(row.executionHostId);

      if (!host) {
        await orphan(db, row, "ORPHANED", at, logger);
        summary.orphaned += 1;
        continue;
      }

      const redeliver = async (): Promise<boolean> => {
        const send = row.driverless ? driverlessSend(row, transport) : null;

        if (!send) {
          await orphan(db, row, "ORPHANED", at, logger);
          summary.orphaned += 1;

          return false;
        }
        await deliverCommand({
          db,
          command: row,
          envelope: envelopeFor(row, host),
          send,
          logger,
          now,
        });
        summary.redelivered += 1;

        return true;
      };

      if (row.state === "queued") {
        await redeliver();
        continue;
      }

      const receipt = await transport.getCommandReceipt(row.id);

      if (!receipt) {
        // W2 with no receipt: the host never saw it → treat as W1.
        await redeliver();
        continue;
      }
      summary[await foldReceipt(db, row, receipt, at, logger)] += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);

      summary.errors.push(`${row.kind} ${row.id}: ${message}`);
      logger.error(
        { commandId: row.id, commandKind: row.kind, err: message },
        "command-recovery-failed",
      );
    }
  }

  logger.info(
    { ...summary, errorCount: summary.errors.length },
    "execution-command-recovery",
  );

  return summary;
}

// ADR-165 sweep backstop (V5): an `active` assignment whose run has no live
// driver (status outside Running/NeedsInput) was left behind by a crashed
// re-entry — release it so the next placement mints cleanly.
export async function releaseStaleAssignments(
  opts: { db?: Db; now?: () => Date; graceMs?: number; logger?: Logger } = {},
): Promise<number> {
  const db = opts.db ?? getDb();
  const now = (opts.now ?? (() => new Date()))();
  const graceMs = opts.graceMs ?? DELIVERING_IN_FLIGHT_GRACE_MS;
  const staleRuns = db
    .select({ id: runs.id })
    .from(runs)
    .where(notInArray(runs.status, [...LIVE_DRIVER_RUN_STATUSES]));
  const released = await db
    .update(executionAssignments)
    .set({
      state: "released",
      releasedReason: "sweep",
      endedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(executionAssignments.state, "active"),
        lt(executionAssignments.createdAt, new Date(now.getTime() - graceMs)),
        inArray(executionAssignments.runId, staleRuns),
      ),
    )
    .returning({
      id: executionAssignments.id,
      runId: executionAssignments.runId,
      epoch: executionAssignments.epoch,
    });

  for (const row of released) {
    (opts.logger ?? defaultLog).warn(
      {
        runId: row.runId,
        assignmentId: row.id,
        assignmentEpoch: row.epoch,
        reason: "sweep",
      },
      "assignment-released",
    );
  }

  return released.length;
}

export async function pruneExecutionCommands(
  opts: { db?: Db; now?: () => Date } = {},
): Promise<number> {
  const db = opts.db ?? getDb();
  const now = (opts.now ?? (() => new Date()))();

  return pruneTerminalCommands(
    db,
    new Date(
      now.getTime() - EXECUTION_COMMAND_RETENTION_DAYS * 24 * 60 * 60 * 1000,
    ),
  );
}

export type ExecutionHostSweepSummary = {
  commands: ExecutionCommandRecoverySummary;
  assignmentsReleased: number;
  commandsPruned: number;
  // D9: the boot-time backfill retried on every pass (a host that was
  // unreachable at boot is picked up here).
  legacy: LegacyBackfillSummary;
};

// Joins `runSystemSweep()` — no new scheduler job kind (D8).
export async function executionCommandReconcilePass(
  opts: RecoveryOptions = {},
): Promise<ExecutionHostSweepSummary> {
  const commands = await recoverExecutionCommands(opts);
  const legacy = await adoptLegacyActiveRuns({
    db: opts.db,
    transport: opts.transport,
    now: opts.now,
    logger: opts.logger,
  });
  const assignmentsReleased = await releaseStaleAssignments({
    db: opts.db,
    now: opts.now,
    logger: opts.logger,
  });
  const commandsPruned = await pruneExecutionCommands({
    db: opts.db,
    now: opts.now,
  });

  return { commands, assignmentsReleased, commandsPruned, legacy };
}
