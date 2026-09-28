import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { seedProjectRow } from "@/test-support/execution-host-seed";
import {
  applyMainMigration,
  startMainPostgresTestDbUpTo,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

let database: StartedPostgresTestDb;
const taskId = randomUUID();
const openId = randomUUID();
const answeredId = randomUUID();
const supersededId = randomUUID();

beforeAll(async () => {
  database = await startMainPostgresTestDbUpTo(
    { databaseName: "migration_0188_clarifications" },
    "0187_librarian_operations",
  );
  const db = database.db;
  const project = await seedProjectRow(db);

  await db.execute(sql`
    INSERT INTO tasks (id, project_id, number, title, prompt, status, stage)
    VALUES (${taskId}, ${project.id}, 1, 'Clarifications', 'Prompt', 'Backlog', 'Backlog')
  `);
  await db.execute(sql`
    INSERT INTO task_clarifications
      (id, task_id, seq, source_hitl_request_id, origin_run_id, origin_agent_id,
       question, question_schema, retrigger_mode)
    VALUES (${openId}, ${taskId}, 1, ${randomUUID()}, ${randomUUID()}, 'core:triager',
      'Open question', '{}'::jsonb, 'agent')
  `);
  await db.execute(sql`
    INSERT INTO task_clarifications
      (id, task_id, seq, source_hitl_request_id, origin_run_id, origin_agent_id,
       question, question_schema, retrigger_mode, answer, answered_by_user_id, answered_at)
    VALUES (${answeredId}, ${taskId}, 2, ${randomUUID()}, ${randomUUID()}, 'core:triager',
      'Answered question', '{}'::jsonb, 'agent', '{"answer":"yes"}'::jsonb, ${randomUUID()}, now())
  `);
  await db.execute(sql`
    INSERT INTO task_clarifications
      (id, task_id, seq, source_hitl_request_id, origin_run_id, origin_agent_id,
       question, question_schema, retrigger_mode, superseded_at, superseded_by_run_id)
    VALUES (${supersededId}, ${taskId}, 3, ${randomUUID()}, ${randomUUID()}, 'core:triager',
      'Superseded question', '{}'::jsonb, 'agent', now(), ${randomUUID()})
  `);
  await applyMainMigration(db, "0188_task_clarifications_user_origin");
}, 180_000);

afterAll(async () => {
  await database?.stop();
});

async function refused(query: ReturnType<typeof sql>): Promise<string> {
  try {
    await database.db.execute(query);
  } catch (err) {
    return String((err as { constraint?: string }).constraint ?? err);
  }

  throw new Error("expected the database to refuse an invalid clarification");
}

describe("IT-CLR-01: migration 0188 keeps agent rows and checks origin shape", () => {
  it("backfills existing open, answered, and superseded agent rows", async () => {
    const rows = await database.db.execute(sql`
      SELECT id, origin_kind, status FROM task_clarifications WHERE task_id = ${taskId} ORDER BY seq
    `);

    expect(rows.rows).toEqual([
      { id: openId, origin_kind: "agent_run", status: "open" },
      { id: answeredId, origin_kind: "agent_run", status: "answered" },
      { id: supersededId, origin_kind: "agent_run", status: "superseded" },
    ]);
  });

  it("accepts a user request with no run or HITL provenance", async () => {
    const id = randomUUID();

    await database.db.execute(sql`
      INSERT INTO task_clarifications
        (id, task_id, seq, origin_kind, question, retrigger_mode,
         requester_user_id, recipient_user_id, reason, answer_format, blocking)
      VALUES (${id}, ${taskId}, 4, 'user', 'What is the boundary?', 'none',
        ${randomUUID()}, ${randomUUID()}, 'Need scope', 'text', true)
    `);
    const rows = await database.db.execute(sql`
      SELECT source_hitl_request_id, origin_run_id, origin_agent_id, status
      FROM task_clarifications WHERE id = ${id}
    `);

    expect(rows.rows[0]).toEqual({
      source_hitl_request_id: null,
      origin_run_id: null,
      origin_agent_id: null,
      status: "open",
    });
  });

  it("refuses a user row with a run id and an agent row without one", async () => {
    const userError = await refused(sql`
      INSERT INTO task_clarifications
        (id, task_id, seq, origin_kind, origin_run_id, question, retrigger_mode,
         requester_user_id, recipient_user_id)
      VALUES (${randomUUID()}, ${taskId}, 5, 'user', ${randomUUID()}, 'Question', 'none',
        ${randomUUID()}, ${randomUUID()})
    `);
    const agentError = await refused(sql`
      INSERT INTO task_clarifications
        (id, task_id, seq, origin_kind, source_hitl_request_id, origin_agent_id,
         question, question_schema, retrigger_mode)
      VALUES (${randomUUID()}, ${taskId}, 6, 'agent_run', ${randomUUID()}, 'core:triager',
        'Question', '{}'::jsonb, 'agent')
    `);

    expect(userError).toBe("task_clarifications_origin_shape_check");
    expect(agentError).toBe("task_clarifications_origin_shape_check");
  });
});
