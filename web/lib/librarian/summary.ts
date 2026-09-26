import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type {
  LibrarianConversationRow,
  LibrarianSummaryContent,
} from "@/lib/db/schema";

import { and, asc, desc, eq, gt, inArray, isNull } from "drizzle-orm";
import pino from "pino";
import { z } from "zod";

import { librarianConfig } from "./config";
import { memoryContentDigest } from "./memory";

import {
  librarianContextSnapshots,
  librarianMemoryTombstones,
  librarianMessages,
  librarianSegmentSummaries,
  librarianTurns,
} from "@/lib/db/schema";

const log = pino({
  name: "librarian.summary",
  level: process.env.LOG_LEVEL ?? "info",
});

export const librarianSummarySchema = z
  .object({
    decisions: z.array(z.string().trim().min(1).max(2000)).max(100),
    proposals: z.array(z.string().trim().min(1).max(2000)).max(100),
    uncertainties: z.array(z.string().trim().min(1).max(2000)).max(100),
  })
  .strict();

export const LIBRARIAN_SUMMARY_INSTRUCTIONS =
  "Summarize the conversation excerpt as JSON with exactly decisions, proposals, and uncertainties string arrays. Preserve only information stated in the excerpt. Do not use tools. Return JSON only.";

/** Called after a turn ends, under the conversation lock. */
export async function queueLibrarianSummary(
  tx: Db,
  conversation: LibrarianConversationRow,
  segmentId: string,
): Promise<void> {
  if (
    conversation.resetState !== "none" ||
    conversation.currentSegmentId !== segmentId
  )
    return;
  const [pending] = await tx
    .select({ id: librarianTurns.id })
    .from(librarianTurns)
    .where(
      and(
        eq(librarianTurns.segmentId, segmentId),
        eq(librarianTurns.variant, "summary"),
        inArray(librarianTurns.status, ["queued", "admitted", "running"]),
      ),
    )
    .limit(1);

  if (pending) return;
  const failures = await tx
    .select({ id: librarianTurns.id })
    .from(librarianTurns)
    .where(
      and(
        eq(librarianTurns.segmentId, segmentId),
        eq(librarianTurns.variant, "summary"),
        eq(librarianTurns.status, "failed"),
      ),
    );

  if (failures.length >= 2) return;
  const [lastSummary] = await tx
    .select({ toSeq: librarianSegmentSummaries.toSeq })
    .from(librarianSegmentSummaries)
    .where(
      and(
        eq(librarianSegmentSummaries.segmentId, segmentId),
        isNull(librarianSegmentSummaries.invalidatedAt),
      ),
    )
    .orderBy(desc(librarianSegmentSummaries.toSeq))
    .limit(1);
  const tail = await tx
    .select({
      id: librarianMessages.id,
      seq: librarianMessages.seq,
      body: librarianMessages.body,
    })
    .from(librarianMessages)
    .where(
      and(
        eq(librarianMessages.segmentId, segmentId),
        gt(librarianMessages.seq, lastSummary?.toSeq ?? 0n),
        inArray(librarianMessages.deliveryState, ["accepted", "processed"]),
        inArray(librarianMessages.authorKind, ["owner", "librarian", "update"]),
      ),
    )
    .orderBy(asc(librarianMessages.seq));
  const chars = tail.reduce((total, row) => total + row.body.length, 0);

  if (chars <= librarianConfig().contextMaxChars / 2 || tail.length === 0)
    return;
  await tx.insert(librarianTurns).values({
    conversationId: conversation.id,
    segmentId,
    messageId: tail[tail.length - 1].id,
    variant: "summary",
    status: "queued",
  });
  log.info({ segmentId, chars }, "librarian summary queued");
}

/** CAS write: context epoch covers reset, forget, history clear and visibility changes. */
export async function writeLibrarianSummary(
  tx: Db,
  input: { turnId: string; ownerId: string; text: string },
): Promise<boolean> {
  const [turn] = await tx
    .select({
      segmentId: librarianTurns.segmentId,
      conversationId: librarianTurns.conversationId,
      snapshotId: librarianTurns.contextSnapshotId,
    })
    .from(librarianTurns)
    .where(eq(librarianTurns.id, input.turnId));
  const [snapshot] = turn?.snapshotId
    ? await tx
        .select()
        .from(librarianContextSnapshots)
        .where(eq(librarianContextSnapshots.id, turn.snapshotId))
    : [];

  if (!turn || !snapshot || snapshot.messageIds.length === 0) return false;
  const { lockOwnerConversation } = await import("./conversation");
  const { conversation } = await lockOwnerConversation(tx, input.ownerId);

  if (
    conversation.currentSegmentId !== turn.segmentId ||
    conversation.resetState !== "none" ||
    conversation.contextEpoch !== snapshot.contextEpoch
  ) {
    log.warn({ turnId: input.turnId }, "librarian summary write fenced");

    return false;
  }
  const parsed = librarianSummarySchema.safeParse(JSON.parse(input.text));

  if (!parsed.success) return false;
  const tombstones = await tx
    .select({ digest: librarianMemoryTombstones.contentDigest })
    .from(librarianMemoryTombstones)
    .where(eq(librarianMemoryTombstones.userId, input.ownerId));
  const forgotten = new Set(tombstones.map((row) => row.digest));
  const content = Object.fromEntries(
    Object.entries(parsed.data).map(([key, values]) => [
      key,
      values.filter((value) => !forgotten.has(memoryContentDigest(value))),
    ]),
  ) as LibrarianSummaryContent;
  const messages = await tx
    .select({
      seq: librarianMessages.seq,
      sourceProjectIds: librarianMessages.sourceProjectIds,
    })
    .from(librarianMessages)
    .where(inArray(librarianMessages.id, snapshot.messageIds));

  if (messages.length !== snapshot.messageIds.length) return false;
  const seqs = messages.map((row) => row.seq);
  const [latest] = await tx
    .select({ revision: librarianSegmentSummaries.revision })
    .from(librarianSegmentSummaries)
    .where(eq(librarianSegmentSummaries.segmentId, turn.segmentId))
    .orderBy(desc(librarianSegmentSummaries.revision))
    .limit(1);
  const revision = (latest?.revision ?? 0) + 1;
  const fromSeq = seqs.reduce((min, seq) => (seq < min ? seq : min));
  const toSeq = seqs.reduce((max, seq) => (seq > max ? seq : max));

  await tx.insert(librarianSegmentSummaries).values({
    segmentId: turn.segmentId,
    revision,
    fromSeq,
    toSeq,
    content,
    sourceProjectIds: [
      ...new Set(messages.flatMap((row) => row.sourceProjectIds)),
    ],
    forgetGeneration: conversation.forgetGeneration,
    historyGeneration: conversation.historyGeneration,
  });
  log.info(
    {
      segmentId: turn.segmentId,
      revision,
      fromSeq: fromSeq.toString(),
      toSeq: toSeq.toString(),
    },
    "librarian summary saved",
  );

  return true;
}
