import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { ComposerMessage, ComposerRevisioned } from "./composer";

import { and, asc, eq, inArray, isNull, lte } from "drizzle-orm";
import pino from "pino";

import { memoryContentDigest } from "./memory";
import { queueLibrarianSummary } from "./summary";

import {
  librarianMemoryItemRevisions,
  librarianMemoryItems,
  librarianMemoryTombstones,
  librarianConversations,
  librarianMessages,
  librarianSegmentSummaries,
  users,
} from "@/lib/db/schema";
import { getVisibleProjectIds } from "@/lib/queries/visible-projects";

const log = pino({
  name: "librarian.retrieval",
  level: process.env.LOG_LEVEL ?? "info",
});

export async function retrieveLibrarianContext(
  tx: Db,
  input: {
    ownerId: string;
    segmentId: string;
    beforeSeq: bigint;
    forgetGeneration: number;
    historyGeneration: number;
    useMemory: boolean;
  },
): Promise<{
  history: ComposerMessage[];
  summaries: ComposerRevisioned[];
  memoryItems: ComposerRevisioned[];
}> {
  const [owner] = await tx
    .select({ role: users.role })
    .from(users)
    .where(eq(users.id, input.ownerId));
  const visible = new Set(
    owner ? await getVisibleProjectIds(input.ownerId, owner.role, tx) : [],
  );
  const historyRows = await tx
    .select({
      id: librarianMessages.id,
      seq: librarianMessages.seq,
      authorKind: librarianMessages.authorKind,
      body: librarianMessages.body,
      sourceProjectIds: librarianMessages.sourceProjectIds,
    })
    .from(librarianMessages)
    .where(
      and(
        eq(librarianMessages.segmentId, input.segmentId),
        lte(librarianMessages.seq, input.beforeSeq - 1n),
        inArray(librarianMessages.authorKind, ["owner", "librarian", "update"]),
        inArray(librarianMessages.deliveryState, ["accepted", "processed"]),
      ),
    )
    .orderBy(asc(librarianMessages.seq));
  const visibleHistory = historyRows.filter(
    (row) =>
      row.authorKind === "owner" ||
      row.sourceProjectIds.every((id) => visible.has(id)),
  ) as ComposerMessage[];

  const summaryRows = await tx
    .select()
    .from(librarianSegmentSummaries)
    .where(
      and(
        eq(librarianSegmentSummaries.segmentId, input.segmentId),
        eq(librarianSegmentSummaries.forgetGeneration, input.forgetGeneration),
        eq(
          librarianSegmentSummaries.historyGeneration,
          input.historyGeneration,
        ),
        isNull(librarianSegmentSummaries.invalidatedAt),
        lte(librarianSegmentSummaries.toSeq, input.beforeSeq - 1n),
      ),
    )
    .orderBy(asc(librarianSegmentSummaries.fromSeq));
  const tombstones = await tx
    .select({ digest: librarianMemoryTombstones.contentDigest })
    .from(librarianMemoryTombstones)
    .where(eq(librarianMemoryTombstones.userId, input.ownerId));
  const forgotten = new Set(tombstones.map((row) => row.digest));
  const summaries: ComposerRevisioned[] = [];
  let dropped = historyRows.length - visibleHistory.length;
  let coveredToSeq = 0n;
  let invalidated = 0;

  for (const row of summaryRows) {
    if (row.sourceProjectIds.some((id) => !visible.has(id))) {
      await tx
        .update(librarianSegmentSummaries)
        .set({ invalidatedAt: new Date() })
        .where(eq(librarianSegmentSummaries.id, row.id));
      dropped += 1;
      invalidated += 1;
      continue;
    }
    const kept = {
      decisions: row.content.decisions.filter(
        (value) => !forgotten.has(memoryContentDigest(value)),
      ),
      proposals: row.content.proposals.filter(
        (value) => !forgotten.has(memoryContentDigest(value)),
      ),
      uncertainties: row.content.uncertainties.filter(
        (value) => !forgotten.has(memoryContentDigest(value)),
      ),
    };

    summaries.push({
      id: row.id,
      revision: row.revision,
      text: JSON.stringify({
        fromSeq: row.fromSeq.toString(),
        toSeq: row.toSeq.toString(),
        ...kept,
      }),
    });
    if (row.toSeq > coveredToSeq) coveredToSeq = row.toSeq;
  }
  if (invalidated > 0) {
    const [conversation] = await tx.select().from(librarianConversations)
      .where(eq(librarianConversations.userId, input.ownerId));

    if (conversation) await queueLibrarianSummary(tx, conversation, input.segmentId);
  }
  const history = visibleHistory.filter((row) => row.seq > coveredToSeq);
  const memoryRows = input.useMemory
    ? await tx
        .select()
        .from(librarianMemoryItems)
        .where(
          and(
            eq(librarianMemoryItems.userId, input.ownerId),
            isNull(librarianMemoryItems.forgottenAt),
          ),
        )
    : [];
  const accessible = memoryRows.filter(
    (row) =>
      (!row.validUntil || row.validUntil > new Date()) &&
      row.sourceProjectIds.every((id) => visible.has(id)) &&
      (!row.projectId || visible.has(row.projectId)),
  );

  dropped += memoryRows.length - accessible.length;
  const revisions =
    accessible.length > 0
      ? await tx
          .select()
          .from(librarianMemoryItemRevisions)
          .where(
            inArray(
              librarianMemoryItemRevisions.itemId,
              accessible.map((row) => row.id),
            ),
          )
      : [];
  const contentByRevision = new Map(
    revisions.map((row) => [`${row.itemId}:${row.revision}`, row.content]),
  );
  const memoryItems = accessible.map((row) => {
    const text = contentByRevision.get(`${row.id}:${row.revision}`);

    if (!text)
      throw new Error(`memory revision ${row.id}:${row.revision} missing`);

    return { id: row.id, revision: row.revision, text };
  });

  log.debug(
    {
      dropped,
      history: history.length,
      summaries: summaries.length,
      memory: memoryItems.length,
    },
    "librarian context retrieved",
  );

  return { history, summaries, memoryItems };
}
