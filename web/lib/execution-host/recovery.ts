import type { Db } from "./db";
import type { ExecutionCommand, ExecutionHost } from "@/lib/db/schema";
import type { CommandReceipt, ExecutionHostTransport } from "./contracts";
import type { CommandEnvelope, CommandKind } from "./types";
import type { LegacyRunsSummary } from "./legacy";
import type { CommandRetirementSummary } from "./retirement";

import { and, eq, inArray, lt } from "drizzle-orm";
import pino, { type Logger } from "pino";

import { setAssignmentWorkspace } from "./assignments";
import {
  loadOpenCommands,
  casTransition,
  recordUnknownPromptAdmission,
  markFailed,
  markFenced,
  markSucceeded,
  OPEN_COMMANDS_PAGE_SIZE,
  requeueDelivering,
  type OpenCommandsCursor,
} from "./commands";
import { applyCreateAck } from "./create-ack";
import { deliverCommand, startAsyncPrompt } from "./deliverer";
import {
  COMMAND_REQUEST_SCHEMA,
  promptEnvelopeFromCommand,
} from "./command-request";
import { classifyPromptTransportFailure } from "./prompt-transport";
import { reconcilePromptCommand } from "./prompt-reconciliation";
import { getHostById, STALE_ASSIGNMENT_RUN_STATUSES } from "./hosts";
import { buildEnvelope } from "./ledger";
import { defaultTransport } from "./default-transport";
import { reportLegacyActiveRuns } from "./legacy";
import {
  reportUnreconciledCommands,
  retireEligibleCommands,
} from "./retirement";
import { reconcileStoredPromptEvidence } from "./prompt-evidence";
import { DELIVERING_IN_FLIGHT_GRACE_MS } from "./types";
import {
  reduceRuntimeObjectEvidence,
  RuntimeObjectEvidenceError,
} from "./runtime-object-evidence";
import { runEventWakeBus } from "./events/run-wake";

import { parseRuntimeObjectWireMetadata } from "@/lib/supervisor-client";
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
    case "runtime_object.delete":
      return (envelope) =>
        transport.deleteRuntimeObject(
          target,
          envelope as CommandEnvelope<{ generation: number }>,
        );
    default:
      return null;
  }
}

async function applyRuntimeObjectReceipt(
  tx: Db,
  row: ExecutionCommand,
  body: unknown,
  now: Date,
): Promise<void> {
  if (
    row.kind !== "runtime_object.reserve" &&
    row.kind !== "runtime_object.upload" &&
    row.kind !== "runtime_object.delete"
  )
    return;
  const generation = row.payload.generation;

  if (
    !row.targetSessionId ||
    typeof generation !== "number" ||
    !Number.isSafeInteger(generation) ||
    generation < 1
  )
    throw new RuntimeObjectEvidenceError("identity_conflict");
  const binding = {
    objectId: row.targetSessionId,
    runId: row.runId,
    executionHostId: row.executionHostId,
    executionAssignmentId: row.executionAssignmentId,
    assignmentEpoch: row.assignmentEpoch,
    generation,
  };

  if (row.kind === "runtime_object.delete") {
    await reduceRuntimeObjectEvidence(tx, binding, {
      kind: "state",
      source: "delete_ack",
      state: "deleted",
      deletedAt: now,
    });
  } else {
    const metadata = parseRuntimeObjectWireMetadata(body);

    if (row.kind === "runtime_object.upload" || metadata.state === "available")
      await reduceRuntimeObjectEvidence(tx, binding, {
        kind: "seal",
        source: "ack",
        metadata,
      });
  }
}

// ADR-166 D5 W2/W4: fold a host receipt into the ledger together with the
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

      if (row.kind === "session.create")
        await tx
          .select({ id: runs.id })
          .from(runs)
          .where(eq(runs.id, row.runId))
          .for("update");
      await markSucceeded(txDb, row.id, null, receipt.body, { logger, now });
      if (row.kind === "session.create") {
        const payload = row.payload as {
          sessionName?: unknown;
          nodeAttemptId?: unknown;
        };
        const body = receipt.body as {
          sessionId?: unknown;
          acpSessionId?: unknown;
        };

        if (typeof body.sessionId === "string") {
          const bindingDisposition = await applyCreateAck(txDb, {
            commandId: row.id,
            runId: row.runId,
            sessionName:
              typeof payload.sessionName === "string"
                ? payload.sessionName
                : "default",
            assignmentId: row.executionAssignmentId,
            nodeAttemptId:
              typeof payload.nodeAttemptId === "string"
                ? payload.nodeAttemptId
                : null,
            result: {
              sessionId: body.sessionId,
              acpSessionId:
                typeof body.acpSessionId === "string"
                  ? body.acpSessionId
                  : null,
            },
          });

          logger.info(
            {
              commandId: row.id,
              runId: row.runId,
              assignmentId: row.executionAssignmentId,
              bindingDisposition,
            },
            "create-receipt-binding-reconciled",
          );
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
      await applyRuntimeObjectReceipt(txDb, row, receipt.body, now);
    });
    runEventWakeBus.wake(row.runId);
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
    const body = receipt.body as {
      code?: unknown;
      message?: unknown;
      reason?: unknown;
      details?: unknown;
    };
    const details =
      body.details &&
      typeof body.details === "object" &&
      !Array.isArray(body.details)
        ? body.details
        : null;
    const reason =
      typeof body.reason === "string"
        ? body.reason
        : details && "reason" in details && typeof details.reason === "string"
          ? details.reason
          : null;
    const fenced = body.code === "FENCED";
    const error = {
      code: typeof body.code === "string" ? body.code : "ACP_PROTOCOL",
      ...(typeof body.message === "string" ? { message: body.message } : {}),
      ...(reason ? { reason } : {}),
    };

    await (fenced ? markFenced : markFailed)(db, row.id, null, error, {
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

    return reason === "turn_lost" ? "turnLost" : "folded";
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

// ADR-166 D5 crash windows W1/W2/W4 — startup and the periodic sweep pass.
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

  const recoverRow = async (row: ExecutionCommand): Promise<void> => {
    const at = now();

    if (ageMs(row, at) < graceMs) {
      summary.skippedInFlight += 1;

      return;
    }

    const host = await hostFor(row.executionHostId);

    if (!host) {
      if (row.kind === "session.prompt" || row.createIntent) {
        if (row.createIntent) {
          summary.skippedInFlight += 1;

          return;
        }
        await reconcileStoredPromptEvidence(
          db,
          row.id,
          AbortSignal.timeout(30_000),
        );
        summary.skippedInFlight += 1;

        return;
      }
      await orphan(db, row, "ORPHANED", at, logger);
      summary.orphaned += 1;

      return;
    }

    const redeliver = async (queued: ExecutionCommand): Promise<void> => {
      const send = queued.driverless ? driverlessSend(queued, transport) : null;

      if (!send) {
        await orphan(db, queued, "ORPHANED", at, logger);
        summary.orphaned += 1;

        return;
      }
      const runtimeObjectId =
        queued.kind === "runtime_object.delete" ? queued.targetSessionId : null;

      await deliverCommand({
        db,
        command: queued,
        envelope: envelopeFor(queued, host),
        send,
        onAck: runtimeObjectId
          ? (tx, result) => applyRuntimeObjectReceipt(tx, queued, result, at)
          : undefined,
        logger,
        now,
      });
      if (runtimeObjectId) runEventWakeBus.wake(queued.runId);
      summary.redelivered += 1;
    };

    if (row.kind === "session.prompt") {
      const evidence = await reconcilePromptCommand({
        db,
        commandId: row.id,
        lookupReceipt: (id) => transport.getCommandReceipt(id),
        now,
        logger,
      });

      if (
        evidence.disposition === "waiting" &&
        evidence.command.state !== "accepted" &&
        evidence.command.transportState !== "acknowledged" &&
        (evidence.receiptRead === "unavailable" ||
          (evidence.receiptRead === "missing" &&
            evidence.command.attempts >= evidence.command.maxAttempts))
      ) {
        await recordUnknownPromptAdmission(
          db,
          row.id,
          evidence.command.attempts,
          evidence.command.nextAttemptAt ?? new Date(at.getTime() + 5_000),
          evidence.command.attempts >= evidence.command.maxAttempts
            ? "reconciliation_required"
            : "unknown",
          { logger, now: at },
        );
        summary.skippedInFlight += 1;

        return;
      }

      // Only a reachable missing receipt permits replay, and only from the
      // exact immutable v2 request while its original assignment is current.
      const pending = evidence.command;

      if (
        evidence.disposition === "waiting" &&
        evidence.receiptRead === "missing" &&
        pending.requestSchema === COMMAND_REQUEST_SCHEMA &&
        pending.transportState !== "reconciliation_required" &&
        pending.transportState !== "acknowledged" &&
        pending.attempts < pending.maxAttempts &&
        pending.state !== "accepted"
      ) {
        const [assignment] = await db
          .select({ id: executionAssignments.id })
          .from(executionAssignments)
          .innerJoin(
            runs,
            eq(runs.executionAssignmentId, executionAssignments.id),
          )
          .where(
            and(
              eq(executionAssignments.id, pending.executionAssignmentId),
              eq(executionAssignments.state, "active"),
              eq(executionAssignments.epoch, pending.assignmentEpoch),
              eq(runs.id, pending.runId),
            ),
          )
          .limit(1);

        if (assignment) {
          const envelope = promptEnvelopeFromCommand(pending, host.hostKey);
          const queued =
            pending.state === "delivering"
              ? await casTransition(
                  db,
                  pending.id,
                  ["delivering"],
                  pending.attempts,
                  { state: "queued", deliveringSince: null },
                  { logger, now: at },
                )
              : { changed: true, row: pending };

          if (queued.changed && queued.row) {
            await startAsyncPrompt({
              db,
              command: queued.row,
              envelope,
              start: (original) =>
                transport.startPrompt(
                  envelope.target!.hostSessionId,
                  original as typeof envelope,
                ),
              lookupReceipt: (id) => transport.getCommandReceipt(id),
              logger,
              now,
            });
            summary.redelivered += 1;

            return;
          }
        }
      }
      if (evidence.disposition === "settled") {
        const details = evidence.command.lastError?.details;

        if (
          details &&
          typeof details === "object" &&
          "reason" in details &&
          details.reason === "turn_lost"
        )
          summary.turnLost += 1;
        else summary.folded += 1;
      } else summary.skippedInFlight += 1;

      return;
    }

    if (row.createIntent) {
      // Only the leased Flow driver may re-send the private create request.
      // Generic recovery may settle a receipt, never orphan a retained intent
      // or reconstruct its payload from the diagnostic projection.
      const receipt = await transport.getCommandReceipt(row.id);

      if (receipt)
        summary[await foldReceipt(db, row, receipt, at, logger)] += 1;
      else summary.skippedInFlight += 1;

      return;
    }

    if (row.state === "queued") {
      await redeliver(row);

      return;
    }

    const receipt = await transport.getCommandReceipt(row.id);

    if (!receipt) {
      // W2 with no receipt: the host never saw it. A `delivering` row goes
      // back to `queued` first (the deliverer claims from `queued` only), then
      // follows W1; an `accepted` row without a receipt cannot be re-sent.
      if (row.state === "delivering") {
        const requeued = await requeueDelivering(db, row.id, {
          logger,
          now: at,
        });

        if (requeued.changed && requeued.row) await redeliver(requeued.row);

        return;
      }
      await orphan(db, row, "receipt_missing", at, logger);
      summary.orphaned += 1;

      return;
    }
    summary[await foldReceipt(db, row, receipt, at, logger)] += 1;
  };

  let cursor: OpenCommandsCursor | undefined;

  for (;;) {
    const page = await loadOpenCommands(db, {
      limit: OPEN_COMMANDS_PAGE_SIZE,
      after: cursor,
    });

    for (const row of page) {
      summary.scanned += 1;

      try {
        await recoverRow(row);
      } catch (err) {
        const message =
          row.kind === "session.prompt"
            ? classifyPromptTransportFailure(err).causeCode
            : err instanceof Error
              ? err.message
              : String(err);

        summary.errors.push(`${row.kind} ${row.id}: ${message}`);
        logger.error(
          { commandId: row.id, commandKind: row.kind, err: message },
          "command-recovery-failed",
        );
      }
    }

    if (page.length < OPEN_COMMANDS_PAGE_SIZE) break;
    const last = page[page.length - 1];

    cursor = { createdAt: last.createdAt, id: last.id };
  }

  logger.info(
    { ...summary, errorCount: summary.errors.length },
    "execution-command-recovery",
  );

  return summary;
}

// ADR-166 sweep backstop (V5): an `active` assignment whose run cannot have a
// driver waiting for it (parked, under review, terminal, crashed) was left
// behind by a crashed re-entry — release it so the next placement mints
// cleanly. Allow-listed by status: a queued `Pending` run keeps the assignment
// its claim minted for the driver that will pick it up.
export async function releaseStaleAssignments(
  opts: { db?: Db; now?: () => Date; graceMs?: number; logger?: Logger } = {},
): Promise<number> {
  const db = opts.db ?? getDb();
  const now = (opts.now ?? (() => new Date()))();
  const graceMs = opts.graceMs ?? DELIVERING_IN_FLIGHT_GRACE_MS;
  const staleRuns = db
    .select({ id: runs.id })
    .from(runs)
    .where(inArray(runs.status, [...STALE_ASSIGNMENT_RUN_STATUSES]));
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

export type ExecutionHostSweepSummary = {
  commands: ExecutionCommandRecoverySummary;
  assignmentsReleased: number;
  commandRetirement: CommandRetirementSummary;
  unreconciledCommands: number;
  // D9: pre-ADR-166 runs still executing without a placement, reported on
  // every pass until they leave the live statuses.
  legacy: LegacyRunsSummary;
};

// Joins `runSystemSweep()` — no new scheduler job kind (D8).
export async function executionCommandReconcilePass(
  opts: RecoveryOptions = {},
): Promise<ExecutionHostSweepSummary> {
  const commands = await recoverExecutionCommands(opts);
  const legacy = await reportLegacyActiveRuns({
    db: opts.db,
    logger: opts.logger,
  });
  const assignmentsReleased = await releaseStaleAssignments({
    db: opts.db,
    now: opts.now,
    logger: opts.logger,
  });
  const commandRetirement = await retireEligibleCommands({
    ...(opts.db ? { db: opts.db } : {}),
    ...(opts.now ? { now: opts.now() } : {}),
    ...(opts.logger ? { logger: opts.logger } : {}),
  });
  const unreconciledCommands = await reportUnreconciledCommands({
    ...(opts.db ? { db: opts.db } : {}),
    ...(opts.now ? { now: opts.now() } : {}),
    ...(opts.logger ? { logger: opts.logger } : {}),
  });

  return {
    commands,
    assignmentsReleased,
    commandRetirement,
    unreconciledCommands,
    legacy,
  };
}
