import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { LibrarianTurnFailureReason } from "./types";
import type { LibrarianTurnStarter } from "./pool";

import { and, eq, inArray } from "drizzle-orm";
import pino from "pino";

import { admitNextLibrarianTurn } from "./admission";
import { revokeLibrarianTurnToken } from "./authority";
import {
  appendConversationMessage,
  lockOwnerConversation,
} from "./conversation";
import {
  checkpointPrivateQuestions,
  closeUndeliveredQuestions,
} from "./questions";
import { turnSourceProjectIds } from "./disclosed-context";
import { applyLibrarianPark } from "./park";
import { queueLibrarianSummary, writeLibrarianSummary } from "./summary";

import {
  librarianConversations,
  librarianMessages,
  librarianTurns,
  runs,
} from "@/lib/db/schema";
import { isMaisterError, MaisterError } from "@/lib/errors";
import { promoteNextPending } from "@/lib/scheduler";

const log = pino({
  name: "librarian.turn",
  level: process.env.LOG_LEVEL ?? "info",
});

export type LibrarianTurnEnd =
  | Readonly<{ status: "completed"; reply: string }>
  | Readonly<{ status: "failed"; reason: LibrarianTurnFailureReason }>
  | Readonly<{ status: "stopped" }>;

export type LibrarianTurnFinish = Readonly<{
  turnId: string;
  runId: string | null;
  conversationId: string;
  parked: boolean;
}>;

type EndableTurnStatus = "admitted" | "running" | "awaiting_answer";

/** A system line in the conversation: a stable code the panel localizes. */
export function librarianSystemCode(end: LibrarianTurnEnd): string | null {
  if (end.status === "failed") return `turn_failed:${end.reason}`;
  if (end.status === "stopped") return "turn_stopped";

  return null;
}

/** ADR-185 D3/D19: the ONE turn-end transaction. Under the conversation lock:
 * the turn reaches its terminal status exactly once, the reply or a system
 * line lands, the token dies, and the run parks. The successor is admitted
 * after commit. Returns null when another path already ended the turn. */
export async function finishLibrarianTurnInTransaction(
  tx: Db,
  input: {
    turnId: string;
    end: LibrarianTurnEnd;
    assignmentId?: string | null;
    /** Stop may also end an admitted turn or a turn parked for a private answer. */
    fromStatuses?: readonly EndableTurnStatus[];
    now?: Date;
  },
): Promise<LibrarianTurnFinish | null> {
  const now = input.now ?? new Date();
  const [ref] = await tx
    .select({
      conversationId: librarianTurns.conversationId,
      userId: librarianConversations.userId,
    })
    .from(librarianTurns)
    .innerJoin(
      librarianConversations,
      eq(librarianConversations.id, librarianTurns.conversationId),
    )
    .where(eq(librarianTurns.id, input.turnId));

  if (!ref) return null;
  const locked = await lockOwnerConversation(tx, ref.userId);
  const [turn] = await tx
    .select()
    .from(librarianTurns)
    .where(eq(librarianTurns.id, input.turnId))
    .for("update");
  const from = input.fromStatuses ?? ["running"];

  if (!turn || !from.some((status) => status === turn.status)) {
    log.debug(
      { turnId: input.turnId, status: turn?.status },
      "librarian turn already ended",
    );

    return null;
  }
  if (input.assignmentId !== undefined) {
    const [current] = await tx
      .select({ id: runs.executionAssignmentId })
      .from(runs)
      .where(eq(runs.id, locked.conversation.runId ?? ""));

    if ((current?.id ?? null) !== input.assignmentId) return null;
  }
  let end = input.end;

  if (turn.variant === "summary" && end.status === "completed") {
    let saved = false;

    try {
      saved = await writeLibrarianSummary(tx, {
        turnId: turn.id,
        ownerId: ref.userId,
        text: end.reply,
      });
    } catch (error) {
      log.warn({ turnId: turn.id, error }, "librarian summary rejected");
    }
    if (!saved) end = { status: "failed", reason: "summary_invalid" };
  }
  const question =
    end.status === "completed" && locked.conversation.resetState === "none"
      ? await checkpointPrivateQuestions(tx, turn.id)
      : await closeUndeliveredQuestions(tx, turn.id);

  if (question) {
    const runId = locked.conversation.runId;

    if (!runId)
      throw new MaisterError(
        "CONFLICT",
        "Private question lost its owning Run",
      );
    const park = await applyLibrarianPark(tx, runId);

    if (!park.parked)
      throw new MaisterError(
        "CONFLICT",
        "Private question could not park the owning Run",
      );
    await tx
      .update(librarianTurns)
      .set({ status: "awaiting_answer", startLeaseAt: null, deadlineAt: null })
      .where(eq(librarianTurns.id, turn.id));
    await appendConversationMessage(tx, {
      conversationId: turn.conversationId,
      segmentId: turn.segmentId,
      authorKind: "librarian",
      body: String(question.payload.question),
      turnId: turn.id,
      cardId: question.id,
      sourceProjectIds: await turnSourceProjectIds(tx, turn.id),
    });
    await revokeLibrarianTurnToken(turn.id, tx);

    return {
      turnId: turn.id,
      runId,
      conversationId: turn.conversationId,
      parked: true,
    };
  }
  const [ended] = await tx
    .update(librarianTurns)
    .set({
      status: end.status,
      failureReason: end.status === "failed" ? end.reason : null,
      endedAt: now,
    })
    .where(
      and(
        eq(librarianTurns.id, input.turnId),
        inArray(librarianTurns.status, [...from]),
      ),
    )
    .returning({ id: librarianTurns.id });

  if (!ended) return null;
  if (turn.variant === "summary")
    await tx
      .update(librarianConversations)
      .set({
        contextEpoch: locked.conversation.contextEpoch + 1,
        updatedAt: now,
      })
      .where(eq(librarianConversations.id, locked.conversation.id));
  if (turn.messageId && turn.variant !== "summary")
    await tx
      .update(librarianMessages)
      .set({ deliveryState: "processed" })
      .where(eq(librarianMessages.id, turn.messageId));
  if (turn.variant === "summary") {
    if (end.status === "failed")
      await queueLibrarianSummary(tx, locked.conversation, turn.segmentId);
  } else if (end.status === "completed")
    await appendConversationMessage(tx, {
      conversationId: turn.conversationId,
      segmentId: turn.segmentId,
      authorKind: "librarian",
      body: end.reply,
      turnId: turn.id,
      sourceProjectIds: await turnSourceProjectIds(tx, turn.id),
    });
  else
    await appendConversationMessage(tx, {
      conversationId: turn.conversationId,
      segmentId: turn.segmentId,
      authorKind: "system",
      body: librarianSystemCode(end) ?? "turn_ended",
      turnId: turn.id,
    });
  await revokeLibrarianTurnToken(turn.id, tx);
  if (turn.variant !== "summary")
    await queueLibrarianSummary(tx, locked.conversation, turn.segmentId);
  const runId = locked.conversation.runId;
  const park = runId ? await applyLibrarianPark(tx, runId) : { parked: false };
  const durationMs = turn.startedAt
    ? now.getTime() - turn.startedAt.getTime()
    : null;

  if (end.status === "completed")
    log.info(
      {
        turnId: turn.id,
        runId,
        from: turn.status,
        to: end.status,
        durationMs,
      },
      "librarian turn ended",
    );
  else
    log.error(
      {
        turnId: turn.id,
        runId,
        from: turn.status,
        to: end.status,
        code: end.status === "failed" ? end.reason : "stopped",
        durationMs,
      },
      "librarian turn ended without a reply",
    );

  return {
    turnId: turn.id,
    runId,
    conversationId: locked.conversation.id,
    parked: park.parked,
  };
}

/** After the turn-end commit: start the admitted successor, or hand the freed
 * slot to another conversation. Every step is a hint the sweep repeats. */
export async function afterLibrarianTurnFinished(
  db: Db,
  finish: LibrarianTurnFinish | null,
  start?: LibrarianTurnStarter,
): Promise<void> {
  if (!finish) return;

  try {
    const admitted = await admitNextLibrarianTurn(finish.conversationId, {
      db,
      start,
    });

    if (admitted?.started) return;
    if (finish.parked) await promoteNextPending({ db, pool: "librarian" });
  } catch (error) {
    if (!isMaisterError(error) || error.code !== "EXECUTOR_UNAVAILABLE")
      throw error;
    log.warn(
      {
        turnId: finish.turnId,
        conversationId: finish.conversationId,
        reason: error.details?.reason,
      },
      "librarian successor admission deferred until execution host is available",
    );
  }
}
