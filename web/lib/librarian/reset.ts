import "server-only";

import type { Db } from "@/lib/execution-host/db";

import { and, eq, inArray } from "drizzle-orm";
import pino from "pino";

import { lockOwnerConversation } from "./conversation";
import { stopLibrarianTurn } from "./turn-recovery";

import { getDb } from "@/lib/db/client";
import {
  librarianCards,
  librarianConversations,
  librarianMessages,
  librarianOperations,
  librarianSegments,
  librarianTurns,
} from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import { librarianOperationBlocksBarrier } from "@/lib/librarian/operations";

const log = pino({
  name: "librarian.reset",
  level: process.env.LOG_LEVEL ?? "info",
});

/** Reset is requested under the conversation lock so admission cannot cross it. */
export async function requestLibrarianReset(
  ownerId: string,
  db: Db = getDb() as unknown as Db,
): Promise<"resetting" | "none"> {
  await db.transaction(async (tx) => {
    const { conversation } = await lockOwnerConversation(tx, ownerId);

    if (conversation.resetState === "clearing")
      throw new MaisterError("CONFLICT", "history clear is in progress", {
        details: { reason: "clear_in_progress" },
      });
    if (conversation.resetState === "resetting") return;
    await tx
      .update(librarianConversations)
      .set({ resetState: "resetting", updatedAt: new Date() })
      .where(eq(librarianConversations.id, conversation.id));
    await tx
      .update(librarianMessages)
      .set({ deliveryState: "withdrawn_by_reset" })
      .where(
        and(
          eq(librarianMessages.conversationId, conversation.id),
          eq(librarianMessages.segmentId, conversation.currentSegmentId!),
          eq(librarianMessages.deliveryState, "queued"),
        ),
      );
    await tx
      .update(librarianTurns)
      .set({ status: "withdrawn", endedAt: new Date() })
      .where(
        and(
          eq(librarianTurns.conversationId, conversation.id),
          eq(librarianTurns.segmentId, conversation.currentSegmentId!),
          eq(librarianTurns.status, "queued"),
        ),
      );
    log.info(
      { conversationId: conversation.id, phase: "requested" },
      "librarian reset",
    );
  });
  try {
    await stopLibrarianTurn(ownerId, db);
  } catch (error) {
    if (
      !(
        error instanceof MaisterError &&
        error.details?.reason === "no_active_turn"
      )
    )
      log.warn({ ownerId, error }, "librarian reset stop will retry");
  }

  return acknowledgeLibrarianReset(ownerId, db);
}

/** Idempotent barrier pass. Only the old segment's unsettled work can delay it. */
export async function acknowledgeLibrarianReset(
  ownerId: string,
  db: Db = getDb() as unknown as Db,
): Promise<"resetting" | "none"> {
  return db.transaction(async (tx) => {
    const { conversation, segment } = await lockOwnerConversation(tx, ownerId);

    if (conversation.resetState !== "resetting") return "none";
    const [activeTurn] = await tx
      .select({ id: librarianTurns.id })
      .from(librarianTurns)
      .where(
        and(
          eq(librarianTurns.segmentId, segment.id),
          inArray(librarianTurns.status, ["admitted", "running"]),
        ),
      )
      .limit(1);
    const [unsettled] = await tx
      .select({ id: librarianOperations.id })
      .from(librarianOperations)
      .where(
        and(
          eq(librarianOperations.segmentId, segment.id),
          librarianOperationBlocksBarrier(new Date()),
        ),
      )
      .limit(1);

    if (activeTurn || unsettled) return "resetting";
    const now = new Date();
    const [next] = await tx
      .insert(librarianSegments)
      .values({
        conversationId: conversation.id,
        ordinal: segment.ordinal + 1,
        startedAt: now,
      })
      .returning({ id: librarianSegments.id });

    await tx
      .update(librarianSegments)
      .set({ endedAt: now })
      .where(eq(librarianSegments.id, segment.id));
    await tx
      .update(librarianCards)
      .set({ status: "cleared_by_reset", decidedAt: now })
      .where(
        and(
          eq(librarianCards.segmentId, segment.id),
          eq(librarianCards.status, "pending"),
        ),
      );
    await tx
      .update(librarianConversations)
      .set({
        currentSegmentId: next.id,
        contextEpoch: conversation.contextEpoch + 1,
        subject: null,
        resetState: "none",
        updatedAt: now,
      })
      .where(eq(librarianConversations.id, conversation.id));
    log.info(
      { conversationId: conversation.id, phase: "acknowledged" },
      "librarian reset",
    );

    return "none";
  });
}

export async function sweepLibrarianResets(db: Db): Promise<number> {
  const resetting = await db
    .select({ userId: librarianConversations.userId })
    .from(librarianConversations)
    .where(eq(librarianConversations.resetState, "resetting"))
    .limit(100);
  let acknowledged = 0;

  for (const row of resetting) {
    try {
      try {
        await stopLibrarianTurn(row.userId, db);
      } catch (error) {
        if (
          !(
            error instanceof MaisterError &&
            error.details?.reason === "no_active_turn"
          )
        )
          throw error;
      }
      if ((await acknowledgeLibrarianReset(row.userId, db)) === "none")
        acknowledged += 1;
    } catch (error) {
      log.warn({ userId: row.userId, error }, "librarian reset sweep failed");
    }
  }

  return acknowledged;
}
