import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { ExecutionHosts } from "@/lib/execution-host/client";
import type { LibrarianConversationRow } from "@/lib/db/schema";

import { createHash } from "node:crypto";

import { and, count, eq, inArray } from "drizzle-orm";
import pino from "pino";

import { lockOwnerConversation } from "./conversation";

import { getDb } from "@/lib/db/client";
import {
  librarianCards,
  librarianContextSnapshots,
  librarianConversations,
  librarianMessages,
  librarianOperations,
  librarianSegmentSummaries,
  librarianSegments,
  librarianTaskLinks,
  librarianTurns,
} from "@/lib/db/schema";
import { createExecutionHosts } from "@/lib/execution-host";
import { getLatestAssignment } from "@/lib/execution-host/assignments";
import { MaisterError } from "@/lib/errors";

const log = pino({
  name: "librarian.clear-history",
  level: process.env.LOG_LEVEL ?? "info",
});

type ClearCounts = {
  messages: number;
  summaries: number;
  snapshots: number;
  cards: number;
  linksUnavailable: number;
  operationsKept: number;
};

export type ClearPreview = ClearCounts & { previewDigest: string };

async function countsOf(tx: Db, conversationId: string): Promise<ClearCounts> {
  const [messages] = await tx
    .select({ n: count() })
    .from(librarianMessages)
    .where(eq(librarianMessages.conversationId, conversationId));
  const [summaries] = await tx
    .select({ n: count() })
    .from(librarianSegmentSummaries)
    .innerJoin(
      librarianSegments,
      eq(librarianSegments.id, librarianSegmentSummaries.segmentId),
    )
    .where(eq(librarianSegments.conversationId, conversationId));
  const [snapshots] = await tx
    .select({ n: count() })
    .from(librarianContextSnapshots)
    .innerJoin(
      librarianTurns,
      eq(librarianTurns.id, librarianContextSnapshots.turnId),
    )
    .where(eq(librarianTurns.conversationId, conversationId));
  const [cards] = await tx
    .select({ n: count() })
    .from(librarianCards)
    .where(eq(librarianCards.conversationId, conversationId));
  const [links] = await tx
    .select({ n: count() })
    .from(librarianTaskLinks)
    .where(eq(librarianTaskLinks.conversationId, conversationId));
  const [operations] = await tx
    .select({ n: count() })
    .from(librarianOperations)
    .where(eq(librarianOperations.conversationId, conversationId));

  return {
    messages: messages.n,
    summaries: summaries.n,
    snapshots: snapshots.n,
    cards: cards.n,
    linksUnavailable: links.n,
    operationsKept: operations.n,
  };
}

function digestOf(
  conversation: LibrarianConversationRow,
  counts: ClearCounts,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        historyGeneration: conversation.historyGeneration,
        lastSeq: conversation.lastSeq.toString(),
        counts,
      }),
    )
    .digest("hex");
}

async function assertQuiescent(
  tx: Db,
  conversation: LibrarianConversationRow,
): Promise<void> {
  const [turn] = await tx
    .select({ id: librarianTurns.id })
    .from(librarianTurns)
    .where(
      and(
        eq(librarianTurns.conversationId, conversation.id),
        inArray(librarianTurns.status, ["queued", "admitted", "running"]),
      ),
    )
    .limit(1);
  const [operation] = await tx
    .select({ id: librarianOperations.id })
    .from(librarianOperations)
    .where(
      and(
        eq(librarianOperations.conversationId, conversation.id),
        inArray(librarianOperations.status, ["admitted", "unknown"]),
      ),
    )
    .limit(1);

  if (conversation.resetState !== "none" || turn || operation)
    throw new MaisterError("CONFLICT", "conversation is busy", {
      details: { reason: "conversation_busy" },
    });
}

export async function previewLibrarianClear(
  ownerId: string,
  db: Db = getDb() as unknown as Db,
): Promise<ClearPreview> {
  return db.transaction(async (tx) => {
    const { conversation } = await lockOwnerConversation(tx, ownerId);
    const counts = await countsOf(tx, conversation.id);

    return { ...counts, previewDigest: digestOf(conversation, counts) };
  });
}

async function finishClearRelease(
  ownerId: string,
  db: Db,
  hosts: ExecutionHosts,
): Promise<"clearing" | "none"> {
  const [conversation] = await db
    .select()
    .from(librarianConversations)
    .where(eq(librarianConversations.userId, ownerId));

  if (!conversation || conversation.resetState !== "clearing") return "none";
  if (conversation.runId) {
    const assignment = await getLatestAssignment(db, conversation.runId);

    if (assignment?.executionWorkspaceId) {
      const client = await hosts.forAssignment(assignment);

      await client.releaseWorkspace(assignment.executionWorkspaceId);
    }
  }
  await db.transaction(async (tx) => {
    const { conversation: locked } = await lockOwnerConversation(tx, ownerId);

    if (locked.resetState === "clearing")
      await tx
        .update(librarianConversations)
        .set({ resetState: "none", updatedAt: new Date() })
        .where(eq(librarianConversations.id, locked.id));
  });
  log.info(
    { conversationId: conversation.id, phase: "released" },
    "librarian history cleared",
  );

  return "none";
}

export async function clearLibrarianHistory(
  ownerId: string,
  previewDigest: string,
  db: Db = getDb() as unknown as Db,
  hosts: ExecutionHosts = createExecutionHosts({ db }),
): Promise<"clearing" | "none"> {
  await db.transaction(async (tx) => {
    const { conversation, segment } = await lockOwnerConversation(tx, ownerId);

    await assertQuiescent(tx, conversation);
    const counts = await countsOf(tx, conversation.id);

    if (digestOf(conversation, counts) !== previewDigest)
      throw new MaisterError("CONFLICT", "history preview changed", {
        details: { reason: "stale_preview" },
      });
    const segmentIds = tx
      .select({ id: librarianSegments.id })
      .from(librarianSegments)
      .where(eq(librarianSegments.conversationId, conversation.id));
    const turnIds = tx
      .select({ id: librarianTurns.id })
      .from(librarianTurns)
      .where(eq(librarianTurns.conversationId, conversation.id));

    await tx
      .delete(librarianSegmentSummaries)
      .where(inArray(librarianSegmentSummaries.segmentId, segmentIds));
    await tx
      .delete(librarianContextSnapshots)
      .where(inArray(librarianContextSnapshots.turnId, turnIds));
    await tx
      .update(librarianTurns)
      .set({ contextSnapshotId: null })
      .where(eq(librarianTurns.conversationId, conversation.id));
    await tx
      .update(librarianOperations)
      .set({ cardId: null })
      .where(eq(librarianOperations.conversationId, conversation.id));
    await tx
      .delete(librarianCards)
      .where(eq(librarianCards.conversationId, conversation.id));
    await tx
      .delete(librarianMessages)
      .where(eq(librarianMessages.conversationId, conversation.id));
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
      .update(librarianConversations)
      .set({
        currentSegmentId: next.id,
        historyGeneration: conversation.historyGeneration + 1,
        contextEpoch: conversation.contextEpoch + 1,
        resetState: "clearing",
        subject: null,
        updatedAt: now,
      })
      .where(eq(librarianConversations.id, conversation.id));
    log.info(
      { conversationId: conversation.id, counts },
      "librarian history clear committed",
    );
  });
  try {
    return await finishClearRelease(ownerId, db, hosts);
  } catch (error) {
    log.warn({ ownerId, error }, "librarian history release deferred");

    return "clearing";
  }
}

export async function sweepLibrarianClearReleases(db: Db): Promise<number> {
  const rows = await db
    .select({ userId: librarianConversations.userId })
    .from(librarianConversations)
    .where(eq(librarianConversations.resetState, "clearing"))
    .limit(100);
  let released = 0;

  for (const row of rows) {
    try {
      if ((await finishClearRelease(row.userId, db, createExecutionHosts({ db }))) === "none") released += 1;
    } catch (error) {
      log.warn(
        { userId: row.userId, error },
        "librarian history release retry failed",
      );
    }
  }

  return released;
}
