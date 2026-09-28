import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { getDb } from "@/lib/db/client";
import { acceptStatement, taskStatementSchema } from "@/lib/tasks/statement";
import { seedProject } from "@/test-support/execution-host-seed";
import { seedActiveUser } from "@/test-support/librarian-seed";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

let database: StartedPostgresTestDb;
let db: ReturnType<typeof getDb>;

async function seedConversation(
  userId: string,
): Promise<{ conversationId: string; messageId: string }> {
  const conversationId = randomUUID();
  const segmentId = randomUUID();
  const messageId = randomUUID();

  await db.execute(
    sql`INSERT INTO librarian_conversations (id, user_id) VALUES (${conversationId}, ${userId})`,
  );
  await db.execute(sql`
    INSERT INTO librarian_segments (id, conversation_id, ordinal, started_at)
    VALUES (${segmentId}, ${conversationId}, 0, now())
  `);
  await db.execute(sql`
    INSERT INTO librarian_messages (id, conversation_id, segment_id, seq, author_kind, body)
    VALUES (${messageId}, ${conversationId}, ${segmentId}, 1, 'owner', 'Please refine this task')
  `);

  return { conversationId, messageId };
}

beforeAll(async () => {
  database = await startMainPostgresTestDb({ databaseName: "task_statements" });
  db = database.db as unknown as ReturnType<typeof getDb>;
}, 180_000);

afterAll(async () => {
  await database?.stop();
});

describe("task statement acceptance", () => {
  it("IT-TST-04 IT-TST-07 IT-EDGE-TST-01: links accepted revisions and refuses an InFlight rewrite", async () => {
    const projectId = await seedProject(db as unknown as NodePgDatabase);
    const firstUser = await seedActiveUser(db as unknown as NodePgDatabase);
    const secondUser = await seedActiveUser(db as unknown as NodePgDatabase);
    const firstConversation = await seedConversation(firstUser);
    const secondConversation = await seedConversation(secondUser);
    const taskId = randomUUID();
    const statement = taskStatementSchema.parse({
      context: "Project needs a delivery",
      goal: "Ship a clear result",
      acceptance: ["Tests pass"],
      constraints: [],
      outOfScope: [],
      links: [],
      openQuestions: [],
    });

    await db.execute(sql`
      INSERT INTO tasks (id, project_id, number, title, prompt)
      VALUES (${taskId}, ${projectId}, 1, 'Initial', 'Initial prompt')
    `);

    const first = await acceptStatement(
      {
        projectId,
        taskId,
        conversationId: firstConversation.conversationId,
        statement,
        expectedRevision: 0,
        actor: { type: "user", id: firstUser },
        fromMessageId: firstConversation.messageId,
        toMessageId: firstConversation.messageId,
      },
      db,
    );
    const second = await acceptStatement(
      {
        projectId,
        taskId,
        conversationId: secondConversation.conversationId,
        statement: { ...statement, goal: "Ship the revised result" },
        expectedRevision: 1,
        actor: { type: "user", id: secondUser },
        fromMessageId: secondConversation.messageId,
        toMessageId: secondConversation.messageId,
      },
      db,
    );

    expect(first).toMatchObject({ revision: 1, statementRevision: 1 });
    expect(second).toMatchObject({ revision: 2, statementRevision: 2 });

    const links = await db.execute(sql`
      SELECT conversation_id, meaning, from_message_id, statement_revision
      FROM librarian_task_links WHERE task_id = ${taskId} ORDER BY statement_revision
    `);

    expect(links.rows).toMatchObject([
      {
        conversation_id: firstConversation.conversationId,
        meaning: "refined_in",
        from_message_id: firstConversation.messageId,
        statement_revision: 1,
      },
      {
        conversation_id: secondConversation.conversationId,
        meaning: "refined_in",
        from_message_id: secondConversation.messageId,
        statement_revision: 2,
      },
    ]);

    await db.execute(
      sql`UPDATE tasks SET status = 'InFlight' WHERE id = ${taskId}`,
    );
    const before = await db.execute(
      sql`SELECT prompt FROM tasks WHERE id = ${taskId}`,
    );

    await expect(
      acceptStatement(
        {
          projectId,
          taskId,
          conversationId: firstConversation.conversationId,
          statement,
          expectedRevision: 2,
          actor: { type: "user", id: firstUser },
        },
        db,
      ),
    ).rejects.toMatchObject({
      code: "PRECONDITION",
      details: { reason: "task_not_backlog" },
    });

    const after = await db.execute(
      sql`SELECT prompt FROM tasks WHERE id = ${taskId}`,
    );

    expect(after.rows[0]?.prompt).toBe(before.rows[0]?.prompt);
  });
});
