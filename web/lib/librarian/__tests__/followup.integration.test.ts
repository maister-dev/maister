import { randomUUID } from "node:crypto";

import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  advanceReadCursor,
  getOrCreateConversation,
} from "@/lib/librarian/conversation";
import { librarianMessages } from "@/lib/db/schema";
import { buildLibrarianFollowupConsumer } from "@/lib/librarian/followup";
import { explainLibrarianUpdate } from "@/lib/librarian/explain";
import { librarianIndicator, librarianMessageDtos } from "@/lib/librarian/view";
import { fakeExecutionHosts } from "@/test-support/fake-execution-host";
import {
  dispatchDomainEvents,
  ensureConsumerRows,
} from "@/lib/domain-events/dispatch";
import {
  addProjectMember,
  removeProjectMember,
  seedActiveUser,
  seedLibrarianPlatform,
} from "@/test-support/librarian-seed";
import { seedProject, seedRun } from "@/test-support/execution-host-seed";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

let database: StartedPostgresTestDb;

beforeAll(async () => {
  database = await startMainPostgresTestDb({
    databaseName: "librarian_followup",
  });
  await fakeExecutionHosts(database.db);
  await seedLibrarianPlatform(database.db);
}, 180_000);

afterAll(async () => {
  await database?.stop();
});

type UpdateRow = {
  status: string;
  attempts: number;
  last_error_code: string | null;
};

async function updatesFor(eventId: number): Promise<UpdateRow[]> {
  const result = await database.db.execute(sql`
    SELECT status, attempts, last_error_code FROM librarian_updates WHERE domain_event_id = ${eventId}
  `);

  return result.rows as UpdateRow[];
}

describe("IT-LOP-11 IT-LOP-12 IT-CLR-06: domain event follow-up", () => {
  it("deduplicates delivery, skips lost access, and advances past five failed attempts", async () => {
    const db = database.db;
    const projectId = await seedProject(db);
    const ownerId = await seedActiveUser(db);
    const taskId = randomUUID();

    await addProjectMember(db, { projectId, userId: ownerId, role: "member" });
    await db.execute(sql`
      INSERT INTO tasks (id, project_id, number, title, prompt)
      VALUES (${taskId}, ${projectId}, 1, 'Follow-up task', 'Do work')
    `);
    const { conversation } = await getOrCreateConversation(
      ownerId,
      db as never,
    );

    await db.execute(sql`
      INSERT INTO librarian_task_links (id, conversation_id, task_id, meaning)
      VALUES (${randomUUID()}, ${conversation.id}, ${taskId}, 'mentioned')
    `);
    const consumer = buildLibrarianFollowupConsumer(db as never);

    await ensureConsumerRows(db, [consumer]);
    const event = await db.execute(sql`
      INSERT INTO domain_events (kind, project_id, task_id, payload, occurred_at)
      VALUES ('task.clarification_answered', ${projectId}, ${taskId}, '{}'::jsonb, now())
      RETURNING id
    `);
    const eventId = Number((event.rows[0] as { id: number }).id);
    const dispatched = await dispatchDomainEvents({
      db,
      consumers: [consumer],
    });

    expect(dispatched.failures).toBe(0);
    expect((await updatesFor(eventId))[0]?.status).toBe("delivered");
    const [eventRow] = (
      await db.execute(sql`SELECT * FROM domain_events WHERE id = ${eventId}`)
    ).rows;

    await consumer.handle([eventRow as never]);
    const messages = await db.execute(sql`
      SELECT id FROM librarian_messages WHERE conversation_id = ${conversation.id} AND author_kind = 'update'
    `);

    expect(messages.rows).toHaveLength(1);
    const [storedMessage] = await db
      .select()
      .from(librarianMessages)
      .where(eq(librarianMessages.id, (messages.rows[0] as { id: string }).id));
    const [visibleMessage] = await librarianMessageDtos(
      [storedMessage],
      ownerId,
      db as never,
    );

    expect(visibleMessage.masked).toBe(false);
    expect(visibleMessage.update?.eventKind).toBe(
      "task.clarification_answered",
    );
    const runId = await seedRun(db, { projectId, status: "Done" });

    await db.execute(
      sql`UPDATE runs SET task_id = ${taskId}, started_at = now() WHERE id = ${runId}`,
    );
    const [liveMessage] = await librarianMessageDtos(
      [storedMessage],
      ownerId,
      db as never,
    );

    expect(liveMessage.update?.runStatus).toBe("Done");
    expect(liveMessage.update?.workStage).toBe("Promoted");
    expect(await librarianIndicator(db as never, conversation)).toBe("unread");
    await advanceReadCursor(ownerId, storedMessage.seq, db as never);
    expect(
      await librarianIndicator(db as never, {
        ...conversation,
        readThroughSeq: storedMessage.seq,
      }),
    ).toBe("none");
    const updateId = visibleMessage.update!.updateId;
    const explained = await explainLibrarianUpdate(ownerId, updateId, {
      db: db as never,
      start: async () => undefined,
    });
    const explainTurn = await db.execute(sql`
      SELECT variant FROM librarian_turns WHERE id = ${explained.turnId}
    `);

    expect((explainTurn.rows[0] as { variant: string }).variant).toBe(
      "explain",
    );
    const [storedExplainMessage] = await db
      .select()
      .from(librarianMessages)
      .where(eq(librarianMessages.turnId, explained.turnId));
    const [explainMessage] = await librarianMessageDtos(
      [storedExplainMessage],
      ownerId,
      db as never,
    );

    expect(storedExplainMessage.body).toContain("untrusted data");
    expect(explainMessage).toMatchObject({
      authorKind: "owner",
      body: null,
      turnVariant: "explain",
    });

    await removeProjectMember(db, { projectId, userId: ownerId });
    await expect(
      explainLibrarianUpdate(ownerId, updateId, {
        db: db as never,
        start: async () => undefined,
      }),
    ).rejects.toMatchObject({ code: "PRECONDITION" });
    const [maskedMessage] = await librarianMessageDtos(
      [storedMessage],
      ownerId,
      db as never,
    );

    expect(maskedMessage.masked).toBe(true);
    expect(maskedMessage.body).toBeNull();
    expect(maskedMessage.update).toBeNull();
    const inaccessible = await db.execute(sql`
      INSERT INTO domain_events (kind, project_id, task_id, payload, occurred_at)
      VALUES ('task.clarification_cancelled', ${projectId}, ${taskId}, '{}'::jsonb, now())
      RETURNING id
    `);
    const inaccessibleId = Number((inaccessible.rows[0] as { id: number }).id);

    await dispatchDomainEvents({ db, consumers: [consumer] });
    expect((await updatesFor(inaccessibleId))[0]?.status).toBe(
      "skipped_no_access",
    );
    await addProjectMember(db, { projectId, userId: ownerId, role: "member" });

    await db.execute(
      sql.raw(`
      CREATE FUNCTION librarian_followup_test_failure() RETURNS trigger AS $$
      BEGIN
        IF NEW.author_kind = 'update' THEN RAISE EXCEPTION 'injected follow-up failure'; END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql
    `),
    );
    await db.execute(
      sql.raw(`
      CREATE TRIGGER librarian_followup_test_failure BEFORE INSERT ON librarian_messages
      FOR EACH ROW EXECUTE FUNCTION librarian_followup_test_failure()
    `),
    );
    try {
      const poisoned = await db.execute(sql`
        INSERT INTO domain_events (kind, project_id, task_id, payload, occurred_at)
        VALUES ('run.failed', ${projectId}, ${taskId}, '{}'::jsonb, now())
        RETURNING id
      `);
      const poisonId = Number((poisoned.rows[0] as { id: number }).id);

      for (let attempt = 1; attempt <= 5; attempt += 1) {
        const result = await dispatchDomainEvents({
          db,
          consumers: [consumer],
          now: new Date(Date.now() + attempt * 3 * 60 * 60_000),
        });

        expect(result.failures).toBe(attempt < 5 ? 1 : 0);
        expect((await updatesFor(poisonId))[0]?.attempts).toBe(attempt);
      }
      const failed = (await updatesFor(poisonId))[0];

      expect(failed.status).toBe("failed");
      expect(failed.last_error_code).toBe("P0001");
      const cursor = await db.execute(sql`
        SELECT cursor_event_id FROM domain_event_consumers WHERE consumer_id = 'librarian_followup'
      `);

      expect(
        Number((cursor.rows[0] as { cursor_event_id: number }).cursor_event_id),
      ).toBe(poisonId);
      expect(
        (
          await db.execute(sql`
        SELECT id FROM librarian_messages WHERE conversation_id = ${conversation.id} AND author_kind = 'update'
      `)
        ).rows,
      ).toHaveLength(1);
    } finally {
      await db.execute(
        sql.raw(
          `DROP TRIGGER librarian_followup_test_failure ON librarian_messages`,
        ),
      );
      await db.execute(
        sql.raw(`DROP FUNCTION librarian_followup_test_failure()`),
      );
    }
  });
});
