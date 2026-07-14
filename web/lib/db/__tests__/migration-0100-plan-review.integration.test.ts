import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

type Db = NodePgDatabase;
type IndexRow = { indexdef: string };

let testDatabase: StartedPostgresTestDb;
let db: Db;

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "maister_migration_0100_plan_review_test",
  });

  db = testDatabase.db;
}, 180_000);

afterAll(async () => {
  await testDatabase?.stop();
});

function id(): string {
  return randomUUID();
}

async function seedPlanReviewSource(): Promise<{
  artifactId: string;
  parentHitlRequestId: string;
  runId: string;
}> {
  const projectId = id();
  const taskId = id();
  const runId = id();
  const artifactId = id();
  const parentHitlRequestId = id();

  await db.execute(sql`
    INSERT INTO projects (id, slug, name, repo_path, task_key)
    VALUES (
      ${projectId},
      ${`plan-review-${projectId.slice(0, 8)}`},
      'Plan review migration project',
      ${`/tmp/plan-review-${projectId}`},
      ${`PR${projectId.slice(0, 8)}`.toUpperCase()}
    )
  `);
  await db.execute(sql`
    INSERT INTO tasks (id, project_id, number, title, prompt)
    VALUES (${taskId}, ${projectId}, 1, 'Review plan', 'Review the plan')
  `);
  await db.execute(sql`
    INSERT INTO runs (id, project_id, task_id, run_kind, flow_version, status)
    VALUES (${runId}, ${projectId}, ${taskId}, 'flow', 'test', 'NeedsInput')
  `);
  await db.execute(sql`
    INSERT INTO artifact_instances (
      id, run_id, artifact_def_id, node_id, attempt, kind, producer, locator, validity
    ) VALUES (
      ${artifactId}, ${runId}, 'plan-review', 'improve', 1,
      'plan', 'runner', '{"kind":"file","path":"artifacts/plan-review.json"}'::jsonb, 'current'
    )
  `);
  await db.execute(sql`
    INSERT INTO hitl_requests (id, run_id, step_id, kind, schema, prompt)
    VALUES (
      ${parentHitlRequestId}, ${runId}, 'review_plan', 'human',
      '{"planReview":{"answersVar":"plan_answers"}}'::jsonb,
      'Review the plan'
    )
  `);

  return { artifactId, parentHitlRequestId, runId };
}

async function insertDecisionRequest(args: {
  artifactId: string;
  decisionId: string;
  parentHitlRequestId: string;
  runId: string;
}): Promise<void> {
  await db.execute(sql`
    INSERT INTO hitl_requests (
      id, run_id, step_id, kind, schema, prompt, parent_hitl_request_id,
      source_artifact_id, decision_id
    ) VALUES (
      ${id()}, ${args.runId}, 'review_plan', 'decision_request',
      ${JSON.stringify({
        version: 1,
        sourceArtifactId: args.artifactId,
        decisionId: args.decisionId,
        question: "Choose an option",
        options: [{ id: "keep", label: "Keep", consequences: "No change" }],
      })}::jsonb,
      'Choose an option', ${args.parentHitlRequestId}, ${args.artifactId}, ${args.decisionId}
    )
  `);
}

describe("migration 0100 — plan-review decision requests", () => {
  it("enforces decision provenance and rejects duplicate decision identities", async () => {
    const source = await seedPlanReviewSource();

    await insertDecisionRequest({ ...source, decisionId: "database" });

    await expect(
      insertDecisionRequest({ ...source, decisionId: "database" }),
    ).rejects.toThrow(/hitl_requests_decision_request_uq/);
    await expect(
      db.execute(sql`
        INSERT INTO hitl_requests (id, run_id, step_id, kind, prompt)
        VALUES (${id()}, ${source.runId}, 'review_plan', 'decision_request', 'Missing provenance')
      `),
    ).rejects.toThrow(/hitl_requests_decision_request_shape_check/);
  });

  it("creates the pending-decision index for the parent review queue", async () => {
    const indexes = await db.execute<IndexRow>(sql`
      SELECT indexdef
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND indexname = 'hitl_requests_pending_decision_idx'
    `);
    const indexDefinition = indexes.rows[0]?.indexdef ?? "";

    expect(indexDefinition).toContain("parent_hitl_request_id");
    expect(indexDefinition).toContain("responded_at");
    expect(indexDefinition).toContain("created_at");
    expect(indexDefinition).toContain("decision_request");
  });
});
