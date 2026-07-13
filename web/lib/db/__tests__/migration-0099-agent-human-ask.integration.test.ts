import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

type Db = NodePgDatabase;
type ExplainRow = { "QUERY PLAN": string };

let testDatabase: StartedPostgresTestDb;
let db: Db;

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "maister_migration_0099_human_ask_test",
  });

  db = testDatabase.db;
}, 180_000);

afterAll(async () => {
  await testDatabase?.stop();
});

function id(): string {
  return randomUUID();
}

async function seedTaskRun(): Promise<{
  projectId: string;
  taskId: string;
  runId: string;
}> {
  const projectId = id();
  const taskId = id();
  const runId = id();

  await db.execute(sql`
    INSERT INTO projects (id, slug, name, repo_path, task_key)
    VALUES (
      ${projectId},
      ${`project-${projectId.slice(0, 8)}`},
      'Human ask project',
      ${`/tmp/human-ask-${projectId}`},
      ${`HA${projectId.slice(0, 8)}`.toUpperCase()}
    )
  `);
  await db.execute(sql`
    INSERT INTO tasks (id, project_id, number, title, prompt)
    VALUES (${taskId}, ${projectId}, 1, 'Clarify deployment', 'Deploy the service')
  `);
  await db.execute(sql`
    INSERT INTO runs (id, run_kind, project_id, task_id, flow_version, status)
    VALUES (${runId}, 'agent', ${projectId}, ${taskId}, 'test', 'Running')
  `);

  return { projectId, taskId, runId };
}

async function insertAgentQuestion(args: {
  id?: string;
  taskId: string;
  runId: string;
  activationState?: "pending_termination" | "active" | "failed";
  supersededByHitlRequestId?: string | null;
  supersededByRunId?: string | null;
}): Promise<string> {
  const hitlRequestId = args.id ?? id();
  const superseded =
    args.supersededByHitlRequestId !== undefined ||
    args.supersededByRunId !== undefined;

  await db.execute(sql`
    INSERT INTO hitl_requests (
      id,
      run_id,
      step_id,
      kind,
      task_id,
      activation_state,
      retrigger_mode,
      schema,
      prompt,
      superseded_at,
      superseded_by_hitl_request_id,
      superseded_by_run_id
    )
    VALUES (
      ${hitlRequestId},
      ${args.runId},
      'agent',
      'agent_question',
      ${args.taskId},
      ${args.activationState ?? "active"},
      'agent',
      '{"schemaVersion":1,"fields":[]}'::jsonb,
      'Which target?',
      ${superseded ? new Date("2026-07-13T00:00:00.000Z") : null},
      ${args.supersededByHitlRequestId ?? null},
      ${args.supersededByRunId ?? null}
    )
  `);

  return hitlRequestId;
}

describe("migration 0099 — agent human ask (ADR-136)", () => {
  it("preserves legal legacy HITL while enforcing the agent-question-only shape", async () => {
    const { taskId, runId } = await seedTaskRun();

    await db.execute(sql`
      INSERT INTO hitl_requests (id, run_id, step_id, kind, schema, prompt)
      VALUES (${id()}, ${runId}, 'form', 'form', '{"schemaVersion":1,"fields":[]}'::jsonb, 'Legacy form')
    `);
    await insertAgentQuestion({ taskId, runId });

    await expect(
      db.execute(sql`
        INSERT INTO hitl_requests (
          id, run_id, step_id, kind, task_id, activation_state, prompt
        )
        VALUES (${id()}, ${runId}, 'form', 'form', ${taskId}, 'active', 'Invalid legacy shape')
      `),
    ).rejects.toThrow(/hitl_requests_agent_question_shape_check/);

    await expect(
      db.execute(sql`
        INSERT INTO hitl_requests (id, run_id, step_id, kind, prompt)
        VALUES (${id()}, ${runId}, 'agent', 'agent_question', 'Missing task and activation state')
      `),
    ).rejects.toThrow(/hitl_requests_agent_question_shape_check/);
  });

  it("enforces one immutable clarification source and per-task sequence", async () => {
    const { taskId, runId } = await seedTaskRun();
    const sourceHitlRequestId = await insertAgentQuestion({ taskId, runId });
    const clarificationId = id();

    await db.execute(sql`
      INSERT INTO task_clarifications (
        id,
        task_id,
        seq,
        source_hitl_request_id,
        origin_run_id,
        origin_agent_id,
        question,
        question_schema,
        retrigger_mode
      )
      VALUES (
        ${clarificationId},
        ${taskId},
        1,
        ${sourceHitlRequestId},
        ${runId},
        'core:triager',
        'Which target?',
        '{"schemaVersion":1,"fields":[]}'::jsonb,
        'agent'
      )
    `);

    await expect(
      db.execute(sql`
        INSERT INTO task_clarifications (
          id, task_id, seq, source_hitl_request_id, origin_run_id,
          origin_agent_id, question, question_schema, retrigger_mode
        )
        VALUES (
          ${id()}, ${taskId}, 1, ${id()}, ${runId}, 'core:triager',
          'Duplicate sequence', '{"schemaVersion":1,"fields":[]}'::jsonb, 'agent'
        )
      `),
    ).rejects.toThrow(/task_clarifications_task_seq_uq/);

    await expect(
      db.execute(sql`
        INSERT INTO task_clarifications (
          id, task_id, seq, source_hitl_request_id, origin_run_id,
          origin_agent_id, question, question_schema, retrigger_mode
        )
        VALUES (
          ${id()}, ${taskId}, 2, ${sourceHitlRequestId}, ${runId}, 'core:triager',
          'Duplicate source', '{"schemaVersion":1,"fields":[]}'::jsonb, 'agent'
        )
      `),
    ).rejects.toThrow(/task_clarifications_source_hitl_request_uq/);

    await db.execute(sql`DELETE FROM runs WHERE id = ${runId}`);

    const history = await db.execute<{ id: string; origin_run_id: string }>(sql`
      SELECT id, origin_run_id
      FROM task_clarifications
      WHERE id = ${clarificationId}
    `);

    expect(history.rows).toEqual([
      { id: clarificationId, origin_run_id: runId },
    ]);
  });

  it("rejects mutually exclusive answer-winner and successor-run provenance", async () => {
    const { taskId, runId } = await seedTaskRun();

    await expect(
      insertAgentQuestion({
        taskId,
        runId,
        supersededByHitlRequestId: id(),
        supersededByRunId: id(),
      }),
    ).rejects.toThrow(/hitl_requests_agent_question_supersession_check/);
  });

  it("uses the active-question partial index for Inbox predicates", async () => {
    const { taskId, runId } = await seedTaskRun();

    await insertAgentQuestion({ taskId, runId });
    await db.execute(sql`SET enable_seqscan = off`);
    const plan = await db.execute<ExplainRow>(sql`
      EXPLAIN (FORMAT TEXT)
      SELECT id
      FROM hitl_requests
      WHERE task_id = ${taskId}
        AND kind = 'agent_question'
        AND activation_state = 'active'
        AND responded_at IS NULL
        AND superseded_at IS NULL
      ORDER BY created_at
    `);

    expect(plan.rows.map((row) => row["QUERY PLAN"]).join("\n")).toContain(
      "hitl_requests_agent_question_active_idx",
    );
    await db.execute(sql`SET enable_seqscan = on`);
  });
});
