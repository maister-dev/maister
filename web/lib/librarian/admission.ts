import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type {
  LibrarianConversationRow,
  LibrarianMessageRow,
  LibrarianTurnRow,
} from "@/lib/db/schema";
import type { ExecutionHost } from "@/lib/db/schema";
import type { RunnerCatalogEntry } from "@/lib/acp-runners/resolve";
import type { LibrarianSubject } from "@/lib/librarian/types";

import { randomUUID } from "node:crypto";

import { and, asc, eq, inArray, lt } from "drizzle-orm";
import pino from "pino";

import { librarianConfig } from "./config";
import {
  appendOwnerMessage,
  findMessageByClientId,
  lockOwnerConversation,
  type ConversationWithSegment,
} from "./conversation";
import { claimLibrarianResumeInTransaction } from "./park";
import {
  dispatchLibrarianTurn,
  librarianPoolQueuePosition,
  type LibrarianTurnStarter,
} from "./pool";
import { availabilityRefusal, readLibrarianSettings } from "./settings";

import { snapshotRunner } from "@/lib/acp-runners/resolve";
import { getDb } from "@/lib/db/client";
import {
  librarianConversations,
  librarianMessages,
  librarianOperations,
  librarianTurns,
  runSessions,
  runs,
  users,
} from "@/lib/db/schema";
import { executionDataPlaneModeForHost } from "@/lib/execution-host/data-plane-capabilities";
import { mintPlacement } from "@/lib/execution-host/placement";
import { localHost } from "@/lib/execution-host/resolver";
import { MaisterError } from "@/lib/errors";
import { upgradeMaintenanceEngaged } from "@/lib/maintenance/upgrade-fence";
import { capForPool, countLiveRuns, takeSchedulerLock } from "@/lib/scheduler";

const log = pino({
  name: "librarian.admission",
  level: process.env.LOG_LEVEL ?? "info",
});

export type LibrarianTurnRef = {
  id: string;
  status: LibrarianTurnRow["status"];
  queuePosition: number | null;
};

export type SubmitOwnerMessageResult = {
  deduped: boolean;
  message: LibrarianMessageRow;
  turn: LibrarianTurnRef | null;
};

export type LibrarianAdmissionDeps = {
  db?: Db;
  start?: LibrarianTurnStarter;
  now?: () => Date;
};

const ACTIVE_TURN_STATUSES = ["admitted", "running"] as const;

function utcDate(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** D17: `MAISTER_LIBRARIAN_DAILY_TURNS_PER_USER`. The conversation row lock is
 * the per-user serialization (1:1), so the read-then-write is exact. */
async function consumeDailyTurn(
  tx: Db,
  conversation: LibrarianConversationRow,
  now: Date,
): Promise<void> {
  const today = utcDate(now);
  const used =
    conversation.dailyTurnDate === today ? conversation.dailyTurnCount : 0;
  const cap = librarianConfig().dailyTurnsPerUser;

  if (used >= cap) {
    log.warn(
      { conversationId: conversation.id, used, cap },
      "librarian daily turn cap reached",
    );
    throw new MaisterError(
      "BUDGET_EXCEEDED",
      "You have used today's librarian turns",
      { details: { reason: "librarian_daily_cap", cap } },
    );
  }
  await tx
    .update(librarianConversations)
    .set({ dailyTurnDate: today, dailyTurnCount: used + 1 })
    .where(eq(librarianConversations.id, conversation.id));
}

async function ownerIsActive(tx: Db, userId: string): Promise<boolean> {
  const [owner] = await tx
    .select({
      accountStatus: users.accountStatus,
      mustChangePassword: users.mustChangePassword,
    })
    .from(users)
    .where(eq(users.id, userId));

  return owner?.accountStatus === "active" && !owner.mustChangePassword;
}

export type AdmittedTurn = {
  turnId: string;
  runId: string;
  started: boolean;
};

/** Creates the conversation's one run on its first turn (D2 row shape), in the
 * pool's current state: `Running` and placed when a slot is free, else
 * `Pending` for the pool promotion. */
async function insertConversationRun(
  tx: Db,
  input: {
    conversation: LibrarianConversationRow;
    runner: RunnerCatalogEntry;
    host: ExecutionHost;
    now: Date;
  },
): Promise<{ runId: string; started: boolean }> {
  const runId = randomUUID();
  const live = await countLiveRuns(tx, "librarian");
  const started =
    !upgradeMaintenanceEngaged() && live < capForPool("librarian");

  await tx.insert(runs).values({
    id: runId,
    runKind: "librarian",
    projectId: null,
    taskId: null,
    flowId: null,
    flowRevisionId: null,
    flowVersion: "librarian",
    flowRevision: "manual",
    status: started ? "Running" : "Pending",
    persistent: true,
    createdByUserId: input.conversation.userId,
    agentWorkspace: "none",
    executionDataPlaneMode: executionDataPlaneModeForHost(input.host),
    startedAt: input.now,
  });
  const snapshot = snapshotRunner(input.runner);

  await tx.insert(runSessions).values({
    id: randomUUID(),
    runId,
    sessionName: "default",
    runnerId: input.runner.id,
    runnerResolutionTier: "librarianDefault",
    capabilityAgent: snapshot.capabilityAgent as never,
    runnerSnapshot: snapshot as never,
    acpSessionId: null,
    resolutionSource: "platform_runtime_settings.librarian_runner_id",
  });
  await tx
    .update(librarianConversations)
    .set({ runId, updatedAt: input.now })
    .where(eq(librarianConversations.id, input.conversation.id));
  input.conversation.runId = runId;
  if (started)
    await mintPlacement(tx, {
      runId,
      reason: "librarian_turn",
      host: input.host,
    });
  log.info(
    {
      conversationId: input.conversation.id,
      runId,
      status: started ? "Running" : "Pending",
      live,
    },
    "librarian conversation run created",
  );

  return { runId, started };
}

/** D15: at most one active turn per conversation. Admits the oldest queued
 * turn (by its message's `seq`) when none is active, then asks the pool for a
 * slot. Caller holds the conversation lock. Returns null when nothing moved. */
export async function admitNextTurnInTransaction(
  tx: Db,
  input: {
    locked: ConversationWithSegment;
    runner: RunnerCatalogEntry;
    host: ExecutionHost;
    now: Date;
  },
): Promise<AdmittedTurn | null> {
  const { conversation } = input.locked;

  if (conversation.resetState !== "none") return null;

  const staleBefore = new Date(
    input.now.getTime() - librarianConfig().operationReconcileSeconds * 1000,
  );
  const [unsettled] = await tx
    .select({ id: librarianOperations.id })
    .from(librarianOperations)
    .where(
      and(
        eq(librarianOperations.conversationId, conversation.id),
        eq(librarianOperations.status, "admitted"),
        lt(librarianOperations.createdAt, staleBefore)),
    )
    .limit(1);

  if (unsettled) {
    log.warn({ conversationId: conversation.id, operationId: unsettled.id }, "librarian turn admission awaits operation reconciliation");

    return null;
  }
  const [active] = await tx
    .select({ id: librarianTurns.id })
    .from(librarianTurns)
    .where(
      and(
        eq(librarianTurns.conversationId, conversation.id),
        inArray(librarianTurns.status, [...ACTIVE_TURN_STATUSES]),
      ),
    )
    .limit(1);

  if (active) return null;
  const [next] = await tx
    .select({ turn: librarianTurns })
    .from(librarianTurns)
    .innerJoin(
      librarianMessages,
      eq(librarianMessages.id, librarianTurns.messageId),
    )
    .where(
      and(
        eq(librarianTurns.conversationId, conversation.id),
        eq(librarianTurns.status, "queued"),
        inArray(librarianTurns.variant, ["owner_message", "explain"]),
      ),
    )
    .orderBy(asc(librarianMessages.seq))
    .limit(1)
    .for("update", { of: librarianTurns });

  if (!next) return null;
  // LAU-10: a deactivated owner's queued turn is never admitted; it stays
  // queued and visible, and a reactivated owner's next send moves it.
  if (!(await ownerIsActive(tx, conversation.userId))) {
    log.warn(
      { conversationId: conversation.id, turnId: next.turn.id },
      "librarian admission refused: owner inactive",
    );

    return null;
  }
  await tx
    .update(librarianTurns)
    .set({ status: "admitted", admittedAt: input.now })
    .where(eq(librarianTurns.id, next.turn.id));
  if (next.turn.messageId)
    await tx
      .update(librarianMessages)
      .set({ deliveryState: "accepted" })
      .where(eq(librarianMessages.id, next.turn.messageId));
  await takeSchedulerLock(tx);
  if (!conversation.runId) {
    const created = await insertConversationRun(tx, {
      conversation,
      runner: input.runner,
      host: input.host,
      now: input.now,
    });

    return { turnId: next.turn.id, ...created };
  }
  const claim = await claimLibrarianResumeInTransaction(tx, {
    runId: conversation.runId,
    turnId: next.turn.id,
    host: input.host,
  });

  if (!claim.claimed && claim.reason === "not_claimable")
    // A run still `Running` belongs to the turn that is ending; the pool
    // promotion or the sweep admits this turn once it parks.
    log.warn(
      { conversationId: conversation.id, turnId: next.turn.id },
      "librarian run not claimable; turn stays admitted",
    );

  return {
    turnId: next.turn.id,
    runId: conversation.runId,
    started: claim.claimed,
  };
}

async function turnRefFor(
  db: Db,
  turn: Pick<LibrarianTurnRow, "id" | "status" | "conversationId"> | null,
): Promise<LibrarianTurnRef | null> {
  if (!turn) return null;
  if (turn.status === "queued") {
    const queued = await db
      .select({ id: librarianTurns.id })
      .from(librarianTurns)
      .innerJoin(
        librarianMessages,
        eq(librarianMessages.id, librarianTurns.messageId),
      )
      .where(
        and(
          eq(librarianTurns.conversationId, turn.conversationId),
          eq(librarianTurns.status, "queued"),
        ),
      )
      .orderBy(asc(librarianMessages.seq));
    const index = queued.findIndex((row) => row.id === turn.id);

    return {
      id: turn.id,
      status: turn.status,
      queuePosition: index < 0 ? null : index + 1,
    };
  }
  if (turn.status === "admitted")
    return {
      id: turn.id,
      status: turn.status,
      queuePosition: await librarianPoolQueuePosition(db, turn.id),
    };

  return { id: turn.id, status: turn.status, queuePosition: null };
}

async function turnForMessage(
  db: Db,
  messageId: string,
): Promise<LibrarianTurnRow | null> {
  const [turn] = await db
    .select()
    .from(librarianTurns)
    .where(eq(librarianTurns.messageId, messageId))
    .limit(1);

  return turn ?? null;
}

/** ADR-183: commits the owner's message, then admits or queues its turn. A
 * repeated `clientMessageId` returns the stored message before any refusal is
 * considered; every refusal is decided before anything is written. */
export async function submitOwnerMessage(
  ownerId: string,
  input: {
    clientMessageId: string;
    body: string;
    subject: LibrarianSubject | null;
  },
  deps: LibrarianAdmissionDeps = {},
): Promise<SubmitOwnerMessageResult> {
  const db = deps.db ?? (getDb() as unknown as Db);
  const now = (deps.now ?? (() => new Date()))();
  const host = await localHost({ db });
  const outcome = await db.transaction(async (tx) => {
    const locked = await lockOwnerConversation(tx, ownerId);
    const existing = await findMessageByClientId(
      tx,
      locked.conversation.id,
      input.clientMessageId,
    );

    if (existing)
      return { deduped: true as const, message: existing, admitted: null };
    const settings = await readLibrarianSettings(tx);
    const refusal = availabilityRefusal(settings.availability);

    if (refusal) throw refusal;
    if (locked.conversation.resetState !== "none")
      throw new MaisterError("CONFLICT", "The conversation is being reset", {
        details: { reason: "reset_in_progress" },
      });
    await consumeDailyTurn(tx, locked.conversation, now);
    const { message } = await appendOwnerMessage(tx, locked, {
      clientMessageId: input.clientMessageId,
      body: input.body,
      subject: input.subject,
      deliveryState: "queued",
    });
    const [turn] = await tx
      .insert(librarianTurns)
      .values({
        conversationId: locked.conversation.id,
        segmentId: locked.segment.id,
        messageId: message.id,
        variant: "owner_message",
        status: "queued",
      })
      .returning({ id: librarianTurns.id });

    await tx
      .update(librarianMessages)
      .set({ turnId: turn.id })
      .where(eq(librarianMessages.id, message.id));
    const admitted = await admitNextTurnInTransaction(tx, {
      locked,
      runner: settings.runner!,
      host,
      now,
    });
    const [stored] = await tx
      .select()
      .from(librarianMessages)
      .where(eq(librarianMessages.id, message.id));

    return { deduped: false as const, message: stored, admitted };
  });

  if (outcome.admitted?.started)
    void dispatchLibrarianTurn(outcome.admitted.turnId, deps.start);
  const turn = await turnForMessage(db, outcome.message.id);

  return {
    deduped: outcome.deduped,
    message: outcome.message,
    turn: await turnRefFor(db, turn),
  };
}

/** Admits the conversation's next queued turn — after a turn ends, a message
 * is withdrawn, or from the `system_sweep` backstop. Safe to call repeatedly. */
export async function admitNextLibrarianTurn(
  conversationId: string,
  deps: LibrarianAdmissionDeps = {},
): Promise<AdmittedTurn | null> {
  const db = deps.db ?? (getDb() as unknown as Db);
  const now = (deps.now ?? (() => new Date()))();
  const settings = await readLibrarianSettings(db);

  if (settings.availability !== "ready" || !settings.runner) {
    log.debug(
      { conversationId, availability: settings.availability },
      "librarian admission idle: not available",
    );

    return null;
  }
  const host = await localHost({ db });
  const admitted = await db.transaction(async (tx) => {
    const [owner] = await tx
      .select({ userId: librarianConversations.userId })
      .from(librarianConversations)
      .where(eq(librarianConversations.id, conversationId));

    if (!owner) return null;
    const locked = await lockOwnerConversation(tx, owner.userId);

    return admitNextTurnInTransaction(tx, {
      locked,
      runner: settings.runner!,
      host,
      now,
    });
  });

  if (admitted?.started)
    void dispatchLibrarianTurn(admitted.turnId, deps.start);

  return admitted;
}

export { turnRefFor as librarianTurnRef };
