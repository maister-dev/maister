import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { LibrarianTurnFailureReason } from "./types";

import { and, eq, inArray, isNotNull } from "drizzle-orm";
import pino from "pino";

import { admitNextTurnInTransaction, type AdmittedTurn } from "./admission";
import { revokeLibrarianTurnToken } from "./authority";
import {
  appendConversationMessage,
  lockOwnerConversation,
} from "./conversation";
import { applyLibrarianPark } from "./park";
import { dispatchLibrarianTurn, type LibrarianTurnStarter } from "./pool";
import { readLibrarianSettings } from "./settings";
import { queueLibrarianSummary, writeLibrarianSummary } from "./summary";

import {
  librarianConversations,
  librarianMessages,
  librarianTurns,
  tokenAuditLog,
} from "@/lib/db/schema";
import { localHost } from "@/lib/execution-host/resolver";
import { promoteNextPending } from "@/lib/scheduler";
import { admitNextLibrarianTurn } from "@/lib/librarian/admission";

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
  next: AdmittedTurn | null;
}>;

/** A system line in the conversation: a stable code the panel localizes. */
export function librarianSystemCode(end: LibrarianTurnEnd): string | null {
  if (end.status === "failed") return `turn_failed:${end.reason}`;
  if (end.status === "stopped") return "turn_stopped";

  return null;
}

/** The projects the turn's tool calls touched, from its own audit rows — what
 * masks the reply for an owner who later loses one of them (LMM-09). */
async function sourceProjectIds(tx: Db, turnId: string): Promise<string[]> {
  const rows = await tx
    .selectDistinct({ projectId: tokenAuditLog.project_id })
    .from(tokenAuditLog)
    .where(
      and(
        eq(tokenAuditLog.librarian_turn_id, turnId),
        isNotNull(tokenAuditLog.project_id),
      ),
    );

  return rows
    .map((row: { projectId: string | null }) => row.projectId)
    .filter((id: string | null): id is string => id !== null)
    .sort();
}

/** ADR-183 D3/D19: the ONE turn-end transaction. Under the conversation lock:
 * the turn reaches its terminal status exactly once, the reply or a system
 * line lands, the token dies, the run parks, and the next queued turn is
 * admitted. Returns null when another path already ended the turn. */
export async function finishLibrarianTurnInTransaction(
  tx: Db,
  input: {
    turnId: string;
    end: LibrarianTurnEnd;
    /** A running turn only — the prompt owner's case. A stop also ends an
     * admitted turn that never started. */
    fromStatuses?: readonly ("admitted" | "running")[];
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

  if (!turn || !from.includes(turn.status as "admitted" | "running")) {
    log.debug(
      { turnId: input.turnId, status: turn?.status },
      "librarian turn already ended",
    );

    return null;
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
      sourceProjectIds: await sourceProjectIds(tx, turn.id),
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
  const settings = await readLibrarianSettings(tx);
  const next =
    settings.availability === "ready" && settings.runner
      ? await admitNextTurnInTransaction(tx, {
          locked,
          runner: settings.runner,
          host: await localHost({ db: tx }),
          now,
        })
      : null;
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
    next,
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
  if (finish.next?.started) {
    // A turn runs for minutes; its start is never awaited by the one before.
    void dispatchLibrarianTurn(finish.next.turnId, start);

    return;
  }
  const admitted = await admitNextLibrarianTurn(finish.conversationId, {
    db,
    start,
  });

  if (admitted?.started) return;
  if (finish.parked) await promoteNextPending({ db, pool: "librarian" });
}
