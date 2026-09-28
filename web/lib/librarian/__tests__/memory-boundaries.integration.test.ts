import { randomUUID } from "node:crypto";

import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  librarianConversations,
  librarianContextSnapshots,
  librarianMessages,
  librarianSegmentSummaries,
  librarianTurns,
} from "@/lib/db/schema";
import {
  clearLibrarianHistory,
  previewLibrarianClear,
} from "@/lib/librarian/clear-history";
import { lockOwnerConversation } from "@/lib/librarian/conversation";
import { retrieveLibrarianContext } from "@/lib/librarian/retrieval";
import {
  acknowledgeLibrarianReset,
  requestLibrarianReset,
} from "@/lib/librarian/reset";
import {
  queueLibrarianSummary,
  writeLibrarianSummary,
} from "@/lib/librarian/summary";
import { searchLibrarianHistory } from "@/lib/librarian/history-search";
import { librarianMessageDtos } from "@/lib/librarian/view";
import { runLibrarianRetention } from "@/lib/librarian/retention";
import { ensureDefaultSchedulerJobs } from "@/lib/scheduler/jobs";
import {
  addProjectMember,
  removeProjectMember,
  seedActiveUser,
  seedLibrarianTurn,
} from "@/test-support/librarian-seed";
import { seedProjectRow } from "@/test-support/execution-host-seed";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

let database: StartedPostgresTestDb;

beforeAll(async () => {
  database = await startMainPostgresTestDb({
    databaseName: "librarian_memory_boundaries",
  });
}, 180_000);

afterAll(async () => {
  await database?.stop();
});

describe("IT-LMM-04 IT-LMM-05 IT-LMM-07 IT-LMM-08: personal history boundaries", () => {
  it("IT-EDGE-LMM-01: a summary writer is fenced after reset acknowledgement", async () => {
    const db = database.db;
    const ownerId = await seedActiveUser(db);
    const turnId = await seedLibrarianTurn(db, ownerId);
    const { conversation, segment } = await db.transaction((tx) =>
      lockOwnerConversation(tx as never, ownerId),
    );
    const messageId = randomUUID();

    await db.insert(librarianMessages).values({
      id: messageId,
      conversationId: conversation.id,
      segmentId: segment.id,
      seq: 1n,
      authorKind: "owner",
      body: "X".repeat(31_000),
    });
    await db.execute(
      sql`UPDATE librarian_context_snapshots SET message_ids = ARRAY[${messageId}] WHERE turn_id = ${turnId}`,
    );
    await db.transaction((tx) =>
      queueLibrarianSummary(tx as never, conversation, segment.id),
    );
    const queued = await db.execute(
      sql`SELECT id FROM librarian_turns WHERE segment_id = ${segment.id} AND variant = 'summary'`,
    );

    expect(queued.rows).toHaveLength(1);
    expect(
      await db.transaction((tx) =>
        writeLibrarianSummary(tx as never, {
          turnId,
          ownerId,
          text: JSON.stringify({
            decisions: ["Keep X"],
            proposals: [],
            uncertainties: [],
          }),
        }),
      ),
    ).toBe(true);
    await db
      .update(librarianTurns)
      .set({ status: "completed", endedAt: new Date() })
      .where(eq(librarianTurns.id, turnId));
    expect(await requestLibrarianReset(ownerId, db as never)).toBe("none");
    expect(await acknowledgeLibrarianReset(ownerId, db as never)).toBe("none");
    expect(
      await db.transaction((tx) =>
        writeLibrarianSummary(tx as never, {
          turnId,
          ownerId,
          text: JSON.stringify({
            decisions: ["Late"],
            proposals: [],
            uncertainties: [],
          }),
        }),
      ),
    ).toBe(false);
    const summaries = await db.execute(
      sql`SELECT content FROM librarian_segment_summaries WHERE segment_id = ${segment.id}`,
    );

    expect(summaries.rows).toHaveLength(1);
    const retrieved = await retrieveLibrarianContext(db as never, {
      ownerId,
      segmentId: segment.id,
      beforeSeq: 2n,
      forgetGeneration: 0,
      historyGeneration: 0,
      useMemory: false,
    });

    expect(retrieved.summaries).toHaveLength(1);
  });

  it("reset waits for an admitted old-segment operation and withdraws queued work", async () => {
    const db = database.db;
    const ownerId = await seedActiveUser(db);
    const turnId = await seedLibrarianTurn(db, ownerId);
    const { conversation, segment } = await db.transaction((tx) =>
      lockOwnerConversation(tx as never, ownerId),
    );

    await db
      .update(librarianTurns)
      .set({ status: "completed", endedAt: new Date() })
      .where(eq(librarianTurns.id, turnId));
    const messageId = randomUUID();
    const queuedTurnId = randomUUID();
    const operationId = randomUUID();

    await db.insert(librarianMessages).values({
      id: messageId,
      conversationId: conversation.id,
      segmentId: segment.id,
      seq: 1n,
      authorKind: "owner",
      body: "queued",
      deliveryState: "queued",
    });
    await db.insert(librarianTurns).values({
      id: queuedTurnId,
      conversationId: conversation.id,
      segmentId: segment.id,
      messageId,
      variant: "owner_message",
      status: "queued",
    });
    await db.execute(sql`INSERT INTO librarian_operations
      (id, conversation_id, segment_id, idempotency_key, kind, request_digest, target, status)
      VALUES (${operationId}, ${conversation.id}, ${segment.id}, ${randomUUID()}, 'test', 'digest', '{}'::jsonb, 'admitted')`);
    expect(await requestLibrarianReset(ownerId, db as never)).toBe("resetting");
    const [queued] = await db
      .select({ status: librarianTurns.status })
      .from(librarianTurns)
      .where(eq(librarianTurns.id, queuedTurnId));

    expect(queued.status).toBe("withdrawn");
    await db.execute(
      sql`UPDATE librarian_operations SET status = 'succeeded' WHERE id = ${operationId}`,
    );
    expect(await acknowledgeLibrarianReset(ownerId, db as never)).toBe("none");
    const [after] = await db
      .select()
      .from(librarianConversations)
      .where(eq(librarianConversations.id, conversation.id));

    expect(after.currentSegmentId).not.toBe(segment.id);
    expect(after.contextEpoch).toBe(1);
  });

  it("IT-LMM-03 IT-LMM-09: revoked project content is dropped and old replies are masked", async () => {
    const db = database.db;
    const ownerId = await seedActiveUser(db);
    const project = await seedProjectRow(db);

    await addProjectMember(db, {
      projectId: project.id,
      userId: ownerId,
      role: "member",
    });
    const { conversation, segment } = await db.transaction((tx) =>
      lockOwnerConversation(tx as never, ownerId),
    );
    const ownerBody = "My question ".repeat(3_000);
    const [ownerMessage, reply] = await db
      .insert(librarianMessages)
      .values([
        {
          conversationId: conversation.id,
          segmentId: segment.id,
          seq: 1n,
          authorKind: "owner",
          body: ownerBody,
        },
        {
          conversationId: conversation.id,
          segmentId: segment.id,
          seq: 2n,
          authorKind: "librarian",
          body: "Private project answer",
          sourceProjectIds: [project.id],
        },
      ])
      .returning();

    await db.insert(librarianSegmentSummaries).values({
      segmentId: segment.id,
      revision: 1,
      fromSeq: 1n,
      toSeq: 2n,
      content: {
        decisions: ["Private project answer"],
        proposals: [],
        uncertainties: [],
      },
      sourceProjectIds: [project.id],
      forgetGeneration: 0,
      historyGeneration: 0,
    });
    await removeProjectMember(db, { projectId: project.id, userId: ownerId });
    const retrieved = await retrieveLibrarianContext(db as never, {
      ownerId,
      segmentId: segment.id,
      beforeSeq: 3n,
      forgetGeneration: 0,
      historyGeneration: 0,
      useMemory: false,
    });

    expect(retrieved.summaries).toHaveLength(0);
    expect(retrieved.history.map((message) => message.id)).toEqual([
      ownerMessage.id,
    ]);
    const [stored] = await db
      .select({ invalidatedAt: librarianSegmentSummaries.invalidatedAt })
      .from(librarianSegmentSummaries)
      .where(eq(librarianSegmentSummaries.segmentId, segment.id));

    expect(stored.invalidatedAt).not.toBeNull();
    const pendingSummary = await db.execute(
      sql`SELECT id FROM librarian_turns WHERE segment_id = ${segment.id} AND variant = 'summary' AND status = 'queued'`,
    );

    expect(pendingSummary.rows).toHaveLength(1);
    const rendered = await librarianMessageDtos(
      [ownerMessage, reply],
      ownerId,
      db as never,
    );

    expect(rendered[0]).toMatchObject({ body: ownerBody, masked: false });
    expect(rendered[1]).toMatchObject({ body: null, masked: true });
  });

  it("searches older segments and clear removes personal rows but preserves the operation ledger", async () => {
    const db = database.db;
    const ownerId = await seedActiveUser(db);
    const { conversation, segment } = await db.transaction((tx) =>
      lockOwnerConversation(tx as never, ownerId),
    );
    const messageId = randomUUID();
    const operationId = randomUUID();

    await db.insert(librarianMessages).values({
      id: messageId,
      conversationId: conversation.id,
      segmentId: segment.id,
      seq: 1n,
      authorKind: "owner",
      body: "Critical decision about shipping",
    });
    await db.execute(
      sql`UPDATE librarian_conversations SET last_seq = 1 WHERE id = ${conversation.id}`,
    );
    const [next] = await db
      .execute(
        sql`INSERT INTO librarian_segments (id, conversation_id, ordinal, started_at)
      VALUES (${randomUUID()}, ${conversation.id}, 1, now()) RETURNING id`,
      )
      .then((result) => result.rows as Array<{ id: string }>);

    await db.execute(
      sql`UPDATE librarian_conversations SET current_segment_id = ${next.id} WHERE id = ${conversation.id}`,
    );
    expect(
      (await searchLibrarianHistory(ownerId, "shipping", db as never)).hits[0],
    ).toMatchObject({
      messageId,
      label: "earlier_conversation",
    });
    await db.execute(sql`INSERT INTO librarian_operations
      (id, conversation_id, segment_id, idempotency_key, kind, request_digest, target, status)
      VALUES (${operationId}, ${conversation.id}, ${segment.id}, ${randomUUID()}, 'test', 'digest', '{}'::jsonb, 'succeeded')`);
    const preview = await previewLibrarianClear(ownerId, db as never);

    expect(preview.messages).toBe(1);
    expect(
      await clearLibrarianHistory(ownerId, preview.previewDigest, db as never),
    ).toBe("none");
    expect(
      (await searchLibrarianHistory(ownerId, "shipping", db as never)).hits,
    ).toHaveLength(0);
    const operations = await db.execute(
      sql`SELECT id FROM librarian_operations WHERE id = ${operationId}`,
    );

    expect(operations.rows).toHaveLength(1);
  });

  it("IT-LMM-10: retention advances its durable keyset and keeps newer rows and active snapshots", async () => {
    const db = database.db;
    const ownerId = await seedActiveUser(db);
    const turnId = await seedLibrarianTurn(db, ownerId);
    const { conversation, segment } = await db.transaction((tx) =>
      lockOwnerConversation(tx as never, ownerId),
    );
    const old = new Date("2020-01-01T00:00:00Z");

    await ensureDefaultSchedulerJobs({ db: db as never });
    await db.insert(librarianMessages).values(
      Array.from({ length: 501 }, (_, index) => ({
        id: randomUUID(),
        conversationId: conversation.id,
        segmentId: segment.id,
        seq: BigInt(index + 1),
        authorKind: "owner" as const,
        body: `old ${index}`,
        createdAt: old,
      })),
    );
    await db.insert(librarianMessages).values({
      id: randomUUID(),
      conversationId: conversation.id,
      segmentId: segment.id,
      seq: 502n,
      authorKind: "owner",
      body: "new",
      createdAt: new Date(),
    });
    await db.insert(librarianSegmentSummaries).values({
      segmentId: segment.id,
      revision: 1,
      fromSeq: 1n,
      toSeq: 501n,
      content: { decisions: [], proposals: [], uncertainties: [] },
      forgetGeneration: 0,
      historyGeneration: 0,
    });
    await db
      .update(librarianContextSnapshots)
      .set({ createdAt: old })
      .where(eq(librarianContextSnapshots.turnId, turnId));
    const first = await runLibrarianRetention(db as never);

    expect(first.messages).toBe(500);
    expect(first.snapshots).toBe(0);
    const second = await runLibrarianRetention(db as never);

    expect(second.messages).toBe(1);
    expect(second.summaries).toBe(1);
    const kept = await db
      .select({ body: librarianMessages.body })
      .from(librarianMessages)
      .where(eq(librarianMessages.conversationId, conversation.id));

    expect(kept).toEqual([{ body: "new" }]);
    await db
      .update(librarianTurns)
      .set({ status: "completed", endedAt: new Date() })
      .where(eq(librarianTurns.id, turnId));
    const third = await runLibrarianRetention(db as never);

    expect(third.snapshots).toBe(1);
  });
});
