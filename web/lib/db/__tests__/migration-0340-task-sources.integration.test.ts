import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { pgErrorOf } from "@/lib/db/pg-error";
import {
  applyMainMigration,
  startMainPostgresTestDbUpTo,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

// Package 3 migrations (ADR-206/207): `0340_task_external_sources`,
// `0341_task_activity_source_completion_kinds` and
// `0342_domain_event_run_pr_merged`, seeded on the 0339 schema so
// legacy rows are proven to survive the new constraints.

let testDatabase: StartedPostgresTestDb;
let db: NodePgDatabase;
let originalInboxConstraint: string;

const projectId = randomUUID();
const taskId = randomUUID();
const otherTaskId = randomUUID();

async function refusal(query: ReturnType<typeof sql>): Promise<string> {
  try {
    await db.execute(query);
  } catch (err) {
    return String(pgErrorOf(err)?.constraint ?? err);
  }
  throw new Error("expected the statement to be refused");
}

async function readInboxConstraint(): Promise<string> {
  const { rows } = await db.execute<{ definition: string }>(sql`
    SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
    WHERE conrelid = 'inbox_items'::regclass AND conname = 'inbox_items_event_kind_check'
  `);

  expect(rows).toHaveLength(1);

  return rows[0].definition;
}

function insertSource(overrides: Record<string, string | null> = {}) {
  const row = {
    task_id: taskId,
    source_kind: "github",
    source_instance: "github.com",
    scope_key: "acme/widgets",
    external_id: `I_${randomUUID()}`,
    external_key: "#7",
    external_url: "https://github.com/acme/widgets/issues/7",
    ...overrides,
  };

  return sql`
    INSERT INTO task_external_sources
      (id, project_id, task_id, source_kind, source_instance, scope_key,
       external_id, external_key, external_url, origin, created_by_actor_type)
    VALUES (${randomUUID()}, ${projectId}, ${row.task_id}, ${row.source_kind},
      ${row.source_instance}, ${row.scope_key}, ${row.external_id},
      ${row.external_key}, ${row.external_url}, 'import', 'system')
  `;
}

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDbUpTo(
    { databaseName: "maister_migration_0340_test" },
    "0339_specialist_assignment_cancellation_intent",
  );
  db = testDatabase.db;

  await db.execute(sql`
    INSERT INTO projects (id, slug, name, repo_path, task_key)
    VALUES (${projectId}, 'mig-0340', 'mig-0340', '/tmp/mig-0340', 'MIGB')
  `);
  for (const [id, number] of [
    [taskId, 1],
    [otherTaskId, 2],
  ] as const) {
    await db.execute(sql`
      INSERT INTO tasks (id, project_id, number, title, prompt)
      VALUES (${id}, ${projectId}, ${number}, '[GitHub #7] legacy', 'Source-GitHub-ID: I_x')
    `);
  }
  await db.execute(sql`
    INSERT INTO task_activity (id, task_id, project_id, actor_type, event_kind)
    VALUES (${randomUUID()}, ${taskId}, ${projectId}, 'system', 'task_completed')
  `);
  await db.execute(sql`
    INSERT INTO inbox_items (id, recipient_type, recipient_id, project_id, task_id, event_kind, source_ref)
    VALUES (${randomUUID()}, 'user', 'u-1', ${projectId}, ${taskId}, 'comment_added', '{"kind":"comment","id":"c"}'::jsonb)
  `);
  await db.execute(sql`
    INSERT INTO domain_events (kind, company_id, payload, occurred_at)
    SELECT kinds.kind, companies.id, '{}'::jsonb, now()
    FROM companies
    CROSS JOIN (VALUES ('knowledge.record_changed'), ('specialist.assignment_changed')) AS kinds(kind)
  `);

  originalInboxConstraint = await readInboxConstraint();
  await applyMainMigration(db, "0340_task_external_sources");
  await applyMainMigration(db, "0341_task_activity_source_completion_kinds");
  await applyMainMigration(db, "0342_domain_event_run_pr_merged");
}, 180_000);

afterAll(async () => {
  await testDatabase?.stop();
});

describe("migrations 0340–0342 — task external sources and activity kinds", () => {
  it("keeps every pre-existing task, activity and inbox row", async () => {
    const counts = await db.execute(sql`
      SELECT
        (SELECT count(*) FROM tasks WHERE project_id = ${projectId})::int AS tasks,
        (SELECT count(*) FROM task_activity WHERE project_id = ${projectId})::int AS activity,
        (SELECT count(*) FROM inbox_items WHERE project_id = ${projectId})::int AS inbox,
        (SELECT count(*) FROM task_external_sources)::int AS sources
    `);

    expect(counts.rows[0]).toEqual({
      tasks: 2,
      activity: 1,
      inbox: 1,
      sources: 0,
    });
  });

  it("extends the existing inbox allowlist while retaining company kinds", async () => {
    for (const kind of [
      "assignment_result_available",
      "stand_incident_opened",
      "stand_incident_resolved",
    ]) {
      expect(originalInboxConstraint).toContain(`'${kind}'::text`);
    }

    expect(await readInboxConstraint()).toBe(
      originalInboxConstraint.replace(
        "'stand_incident_resolved'::text]",
        "'stand_incident_resolved'::text, 'delivery_completion_not_applied'::text]",
      ),
    );
  });

  it.each([
    ["source_kind with upper case", { source_kind: "GitHub" }],
    [
      "source_instance with a scheme",
      { source_instance: "https://github.com" },
    ],
    ["source_instance with userinfo", { source_instance: "u@github.com" }],
    ["empty scope_key", { scope_key: "" }],
    ["external_key over 64", { external_key: "k".repeat(65) }],
    ["http external_url", { external_url: "http://github.com/a/b/issues/1" }],
    [
      "external_url with userinfo",
      { external_url: "https://u:p@github.com/x" },
    ],
  ])("refuses %s at the database layer", async (_name, overrides) => {
    expect(await refusal(insertSource(overrides))).toBe(
      "task_external_sources_shape_check",
    );
  });

  it("enforces one binding per identity per project and one per task", async () => {
    const externalId = `I_${randomUUID()}`;

    await db.execute(insertSource({ external_id: externalId }));

    expect(
      await refusal(
        insertSource({ external_id: externalId, task_id: otherTaskId }),
      ),
    ).toBe("task_external_sources_identity_uq");
    expect(await refusal(insertSource())).toBe("task_external_sources_task_uq");
  });

  it("admits the new activity kinds and makes a duplicate refusal a no-op", async () => {
    const refusalRow = sql`
      INSERT INTO task_activity (id, task_id, project_id, actor_type, event_kind, payload)
      VALUES (gen_random_uuid()::text, ${otherTaskId}, ${projectId}, 'system',
        'delivery_completion_not_applied', '{"runId":"r-1","reason":"partial_resolution"}'::jsonb)
      ON CONFLICT DO NOTHING
    `;

    await db.execute(refusalRow);
    await db.execute(refusalRow);
    await db.execute(sql`
      INSERT INTO task_activity (id, task_id, project_id, actor_type, actor_id, event_kind)
      VALUES (gen_random_uuid()::text, ${otherTaskId}, ${projectId}, 'user', 'u-1', 'source_detached')
    `);
    await db.execute(sql`
      INSERT INTO inbox_items (id, recipient_type, recipient_id, project_id, task_id, event_kind, source_ref)
      VALUES (gen_random_uuid()::text, 'user', 'u-1', ${projectId}, ${otherTaskId},
        'delivery_completion_not_applied', '{"kind":"activity","id":"a"}'::jsonb)
    `);

    const kinds = await db.execute(sql`
      SELECT event_kind, count(*)::int AS n FROM task_activity
      WHERE task_id = ${otherTaskId} GROUP BY event_kind ORDER BY event_kind
    `);

    expect(kinds.rows).toEqual([
      { event_kind: "delivery_completion_not_applied", n: 1 },
      { event_kind: "source_detached", n: 1 },
    ]);
    expect(
      await refusal(sql`
        INSERT INTO inbox_items (id, recipient_type, recipient_id, project_id, task_id, event_kind, source_ref)
        VALUES (gen_random_uuid()::text, 'user', 'u-1', ${projectId}, ${otherTaskId},
          'source_detached', '{"kind":"activity","id":"a"}'::jsonb)
      `),
    ).toBe("inbox_items_event_kind_check");
  });

  it("admits run.pr_merged in domain_events and still refuses an unknown kind", async () => {
    const insert = (kind: string) => sql`
      INSERT INTO domain_events (kind, project_id, task_id, payload, occurred_at)
      VALUES (${kind}, ${projectId}, ${taskId}, '{}'::jsonb, now())
    `;

    await db.execute(insert("run.pr_merged"));
    const companyKinds = await db.execute(sql`
      SELECT DISTINCT kind FROM domain_events WHERE company_id IS NOT NULL ORDER BY kind
    `);

    expect(companyKinds.rows).toEqual([
      { kind: "knowledge.record_changed" },
      { kind: "specialist.assignment_changed" },
    ]);
    expect(await refusal(insert("run.pr_reopened"))).toBe(
      "domain_events_kind_check",
    );
  });
});
