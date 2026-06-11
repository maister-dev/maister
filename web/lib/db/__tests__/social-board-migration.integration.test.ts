// ADR-083 migration 0043_social_board coverage.
//
// Backfill path taken: the shared harness applies migrations ALL-AT-ONCE
// (drizzle migrate() in beforeAll), so the seeded-then-migrated case is
// covered by a hand-rolled STEPWISE REPLAY on a second database inside the
// same container: execute journal tags <= 0042 raw, seed pre-0043 projects
// and tasks via SQL, execute 0043 raw, then assert the backfill invariants
// (window-numbering, next_task_number = max+1, task_key derivation +
// deterministic uniquify ladder TES -> TEST -> TES2).

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const MIGRATIONS_DIR = path.resolve("lib/db/migrations");

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;

function newId(): string {
  return randomUUID();
}

async function exec(p: Pool, sqlText: string): Promise<void> {
  await p.query(sqlText);
}

function journalTags(): string[] {
  const journal = JSON.parse(
    readFileSync(path.join(MIGRATIONS_DIR, "meta", "_journal.json"), "utf8"),
  ) as { entries: Array<{ tag: string }> };

  return journal.entries.map((e) => e.tag);
}

async function applyMigrationFile(p: Pool, tag: string): Promise<void> {
  const sqlText = readFileSync(path.join(MIGRATIONS_DIR, `${tag}.sql`), "utf8");
  const statements = sqlText
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  for (const statement of statements) {
    await p.query(statement);
  }
}

async function seedSocialParents(suffixLabel: string) {
  const projectId = newId();
  const flowId = newId();
  const short = projectId.replace(/-/g, "").slice(0, 8);
  const taskKey = `T${short.toUpperCase()}`;

  await pool.query(
    `insert into projects (id, slug, name, repo_path, maister_yaml_path, task_key)
     values ($1, $2, $3, $4, '/tmp/m.yaml', $5)`,
    [
      projectId,
      `social-${suffixLabel}-${short}`,
      `Social ${suffixLabel}`,
      `/tmp/social-${suffixLabel}-${short}`,
      taskKey,
    ],
  );
  await pool.query(
    `insert into flows (id, project_id, flow_ref_id, source, version, installed_path, manifest, schema_version)
     values ($1, $2, 'bugfix', 'github.com/x/y', 'v1.0.0', '/tmp/flows/bugfix', '{"schemaVersion":1,"name":"Bugfix","steps":[]}', 1)`,
    [flowId, projectId],
  );

  const taskId = newId();

  await pool.query(
    `insert into tasks (id, project_id, number, title, prompt, flow_id)
     values ($1, $2, 1, 'Social test task', 'do the thing', $3)`,
    [taskId, projectId, flowId],
  );

  return { projectId, flowId, taskId, taskKey };
}

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("maister_test")
    .withUsername("test")
    .withPassword("test")
    .start();

  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);

  await migrate(db, { migrationsFolder: "./lib/db/migrations" });
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

describe("0043 schema shape (fresh DB, full chain)", () => {
  it("creates the five social tables and the three new columns", async () => {
    const tables = await pool.query(
      `select table_name from information_schema.tables
       where table_schema = 'public' and table_name in
       ('task_relations', 'task_comments', 'task_activity', 'task_subscribers', 'inbox_items')
       order by table_name`,
    );

    expect(tables.rows.map((r) => r.table_name)).toEqual([
      "inbox_items",
      "task_activity",
      "task_comments",
      "task_relations",
      "task_subscribers",
    ]);

    const projectCols = await pool.query(
      `select column_name, is_nullable from information_schema.columns
       where table_name = 'projects' and column_name in ('task_key', 'next_task_number')
       order by column_name`,
    );

    expect(projectCols.rows).toEqual([
      { column_name: "next_task_number", is_nullable: "NO" },
      { column_name: "task_key", is_nullable: "NO" },
    ]);

    const taskCols = await pool.query(
      `select column_name, is_nullable from information_schema.columns
       where table_name = 'tasks' and column_name = 'number'`,
    );

    expect(taskCols.rows).toEqual([
      { column_name: "number", is_nullable: "NO" },
    ]);
  });

  it("rejects a duplicate (project_id, number) with 23505", async () => {
    const { projectId, flowId } = await seedSocialParents("dupnum");

    await expect(
      pool.query(
        `insert into tasks (id, project_id, number, title, prompt, flow_id)
         values ($1, $2, 1, 'dup', 'dup', $3)`,
        [newId(), projectId, flowId],
      ),
    ).rejects.toMatchObject({ code: "23505" });
  });

  it("rejects a duplicate projects.task_key with 23505", async () => {
    const { taskKey } = await seedSocialParents("dupkey");
    const otherId = newId();

    await expect(
      pool.query(
        `insert into projects (id, slug, name, repo_path, maister_yaml_path, task_key)
         values ($1, $2, 'Other', $3, '/tmp/m.yaml', $4)`,
        [
          otherId,
          `social-other-${otherId.slice(0, 8)}`,
          `/tmp/social-other-${otherId.slice(0, 8)}`,
          taskKey,
        ],
      ),
    ).rejects.toMatchObject({ code: "23505" });
  });

  it("enforces the actor pair CHECK on social tables", async () => {
    const { projectId, taskId } = await seedSocialParents("actor");

    // system actor MUST carry a NULL actor_id.
    await expect(
      pool.query(
        `insert into task_comments (id, task_id, project_id, actor_type, actor_id, body)
         values ($1, $2, $3, 'system', 'not-null', 'x')`,
        [newId(), taskId, projectId],
      ),
    ).rejects.toMatchObject({ code: "23514" });

    // user actor MUST carry a non-NULL actor_id.
    await expect(
      pool.query(
        `insert into task_comments (id, task_id, project_id, actor_type, body)
         values ($1, $2, $3, 'user', 'x')`,
        [newId(), taskId, projectId],
      ),
    ).rejects.toMatchObject({ code: "23514" });

    // unknown actor_type is rejected.
    await expect(
      pool.query(
        `insert into task_activity (id, task_id, project_id, actor_type, actor_id, event_kind)
         values ($1, $2, $3, 'robot', 'r1', 'comment_added')`,
        [newId(), taskId, projectId],
      ),
    ).rejects.toMatchObject({ code: "23514" });

    // valid pairs land.
    await pool.query(
      `insert into task_comments (id, task_id, project_id, actor_type, actor_id, body)
       values ($1, $2, $3, 'user', 'user-1', 'human comment')`,
      [newId(), taskId, projectId],
    );
    await pool.query(
      `insert into task_comments (id, task_id, project_id, actor_type, body)
       values ($1, $2, $3, 'system', 'system comment')`,
      [newId(), taskId, projectId],
    );
  });

  it("enforces relation kind, no-self, and uniqueness CHECKs", async () => {
    const { projectId, flowId, taskId } = await seedSocialParents("rel");
    const otherTaskId = newId();

    await pool.query(
      `insert into tasks (id, project_id, number, title, prompt, flow_id)
       values ($1, $2, 2, 'other', 'other', $3)`,
      [otherTaskId, projectId, flowId],
    );

    await expect(
      pool.query(
        `insert into task_relations (id, project_id, from_task_id, kind, to_task_id, actor_type, actor_id)
         values ($1, $2, $3, 'relates_to', $4, 'user', 'u1')`,
        [newId(), projectId, taskId, otherTaskId],
      ),
    ).rejects.toMatchObject({ code: "23514" });

    await expect(
      pool.query(
        `insert into task_relations (id, project_id, from_task_id, kind, to_task_id, actor_type, actor_id)
         values ($1, $2, $3, 'blocks', $3, 'user', 'u1')`,
        [newId(), projectId, taskId],
      ),
    ).rejects.toMatchObject({ code: "23514" });

    await pool.query(
      `insert into task_relations (id, project_id, from_task_id, kind, to_task_id, actor_type, actor_id)
       values ($1, $2, $3, 'blocks', $4, 'user', 'u1')`,
      [newId(), projectId, taskId, otherTaskId],
    );

    await expect(
      pool.query(
        `insert into task_relations (id, project_id, from_task_id, kind, to_task_id, actor_type, actor_id)
         values ($1, $2, $3, 'blocks', $4, 'user', 'u2')`,
        [newId(), projectId, taskId, otherTaskId],
      ),
    ).rejects.toMatchObject({ code: "23505" });
  });

  it("enforces subscriber uniqueness and reason/type CHECKs", async () => {
    const { taskId } = await seedSocialParents("subs");

    await pool.query(
      `insert into task_subscribers (id, task_id, subscriber_type, subscriber_id, reason)
       values ($1, $2, 'user', 'u1', 'creator')`,
      [newId(), taskId],
    );

    await expect(
      pool.query(
        `insert into task_subscribers (id, task_id, subscriber_type, subscriber_id, reason)
         values ($1, $2, 'user', 'u1', 'commenter')`,
        [newId(), taskId],
      ),
    ).rejects.toMatchObject({ code: "23505" });

    await expect(
      pool.query(
        `insert into task_subscribers (id, task_id, subscriber_type, subscriber_id, reason)
         values ($1, $2, 'system', 's1', 'creator')`,
        [newId(), taskId],
      ),
    ).rejects.toMatchObject({ code: "23514" });

    await expect(
      pool.query(
        `insert into task_subscribers (id, task_id, subscriber_type, subscriber_id, reason)
         values ($1, $2, 'user', 'u2', 'because')`,
        [newId(), taskId],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("enforces inbox recipient/event CHECKs and cascades with the task", async () => {
    const { projectId, taskId } = await seedSocialParents("inbox");

    await expect(
      pool.query(
        `insert into inbox_items (id, recipient_type, recipient_id, project_id, task_id, event_kind, source_ref)
         values ($1, 'system', 's', $2, $3, 'comment_added', '{}')`,
        [newId(), projectId, taskId],
      ),
    ).rejects.toMatchObject({ code: "23514" });

    await expect(
      pool.query(
        `insert into inbox_items (id, recipient_type, recipient_id, project_id, task_id, event_kind, source_ref)
         values ($1, 'user', 'u1', $2, $3, 'task_exploded', '{}')`,
        [newId(), projectId, taskId],
      ),
    ).rejects.toMatchObject({ code: "23514" });

    const commentId = newId();
    const activityId = newId();
    const relationTarget = newId();

    await pool.query(
      `insert into task_comments (id, task_id, project_id, actor_type, actor_id, body)
       values ($1, $2, $3, 'user', 'u1', 'hello')`,
      [commentId, taskId, projectId],
    );
    await pool.query(
      `insert into task_activity (id, task_id, project_id, actor_type, actor_id, event_kind)
       values ($1, $2, $3, 'user', 'u1', 'comment_added')`,
      [activityId, taskId, projectId],
    );
    await pool.query(
      `insert into task_subscribers (id, task_id, subscriber_type, subscriber_id, reason)
       values ($1, $2, 'user', 'u1', 'commenter')`,
      [newId(), taskId],
    );
    await pool.query(
      `insert into inbox_items (id, recipient_type, recipient_id, project_id, task_id, event_kind, source_ref)
       values ($1, 'user', 'u2', $2, $3, 'comment_added', $4)`,
      [
        relationTarget,
        projectId,
        taskId,
        JSON.stringify({
          kind: "comment",
          taskId,
          commentId,
          activityId,
        }),
      ],
    );

    await pool.query(`delete from tasks where id = $1`, [taskId]);

    for (const [table, id] of [
      ["task_comments", commentId],
      ["task_activity", activityId],
      ["inbox_items", relationTarget],
    ] as const) {
      const left = await pool.query(
        `select count(*)::int as c from ${table} where id = $1`,
        [id],
      );

      expect(left.rows[0].c).toBe(0);
    }
  });
});

describe("0043 backfill (stepwise replay: <=0042, seed, apply 0043)", () => {
  let replayPool: Pool;

  beforeAll(async () => {
    await pool.query(`create database replay_backfill`);

    const replayUri = container
      .getConnectionUri()
      .replace(/\/maister_test(\?|$)/, "/replay_backfill$1");

    replayPool = new Pool({ connectionString: replayUri });

    const tags = journalTags();
    const pre0043 = tags.filter((t) => !t.startsWith("0043"));

    expect(tags.length - pre0043.length).toBe(1);
    for (const tag of pre0043) {
      await applyMigrationFile(replayPool, tag);
    }

    // Pre-0043 rows: three projects whose derived keys collide
    // (TES -> TEST -> TES2) and three tasks with interleaved created_at.
    await exec(
      replayPool,
      `insert into projects (id, slug, name, repo_path, maister_yaml_path, created_at) values
       ('p1', 'test-alpha', 'Test Alpha', '/tmp/p1', '/tmp/m.yaml', '2026-01-01T00:00:00Z'),
       ('p2', 'test-alphax', 'Test Alphax', '/tmp/p2', '/tmp/m.yaml', '2026-01-02T00:00:00Z'),
       ('p3', 'test-alphay', 'Tes', '/tmp/p3', '/tmp/m.yaml', '2026-01-03T00:00:00Z'),
       ('p4', 'no-tasks', 'Zed Project', '/tmp/p4', '/tmp/m.yaml', '2026-01-04T00:00:00Z')`,
    );
    await exec(
      replayPool,
      `insert into flows (id, project_id, flow_ref_id, source, version, installed_path, manifest, schema_version) values
       ('f1', 'p1', 'bugfix', 'github.com/x/y', 'v1', '/tmp/f1', '{"schemaVersion":1,"name":"B","steps":[]}', 1),
       ('f2', 'p2', 'bugfix', 'github.com/x/y', 'v1', '/tmp/f2', '{"schemaVersion":1,"name":"B","steps":[]}', 1)`,
    );
    await exec(
      replayPool,
      `insert into tasks (id, project_id, title, prompt, flow_id, created_at) values
       ('t2', 'p1', 'second by time', 'x', 'f1', '2026-02-02T00:00:00Z'),
       ('t1', 'p1', 'first by time', 'x', 'f1', '2026-02-01T00:00:00Z'),
       ('t3', 'p2', 'only one', 'x', 'f2', '2026-02-03T00:00:00Z')`,
    );

    await applyMigrationFile(replayPool, tags[tags.length - 1]);
  }, 180_000);

  afterAll(async () => {
    await replayPool?.end();
  });

  it("numbers existing tasks per project by (created_at, id) from 1", async () => {
    const rows = await replayPool.query(
      `select id, number from tasks order by id`,
    );

    expect(rows.rows).toEqual([
      { id: "t1", number: 1 },
      { id: "t2", number: 2 },
      { id: "t3", number: 1 },
    ]);
  });

  it("sets next_task_number to max(number)+1, default 1 for task-less projects", async () => {
    const rows = await replayPool.query(
      `select id, next_task_number from projects order by id`,
    );

    expect(rows.rows).toEqual([
      { id: "p1", next_task_number: 3 },
      { id: "p2", next_task_number: 2 },
      { id: "p3", next_task_number: 1 },
      { id: "p4", next_task_number: 1 },
    ]);
  });

  it("derives task keys with the deterministic uniquify ladder", async () => {
    const rows = await replayPool.query(
      `select id, task_key from projects order by id`,
    );

    // p1 "Test Alpha" -> TES; p2 "Test Alphax" -> TES taken -> widen TEST;
    // p3 "Tes" -> TES taken, widen = TES (only 3 letters) still taken ->
    // numeric suffix TES2; p4 "Zed Project" -> ZED.
    expect(rows.rows).toEqual([
      { id: "p1", task_key: "TES" },
      { id: "p2", task_key: "TEST" },
      { id: "p3", task_key: "TES2" },
      { id: "p4", task_key: "ZED" },
    ]);
  });

  it("leaves the columns NOT NULL with the UNIQUEs in place after backfill", async () => {
    await expect(
      replayPool.query(
        `insert into tasks (id, project_id, title, prompt, flow_id)
         values ('t4', 'p1', 'no number', 'x', 'f1')`,
      ),
    ).rejects.toMatchObject({ code: "23502" });

    await expect(
      replayPool.query(
        `insert into tasks (id, project_id, number, title, prompt, flow_id)
         values ('t5', 'p1', 2, 'dup number', 'x', 'f1')`,
      ),
    ).rejects.toMatchObject({ code: "23505" });

    await expect(
      replayPool.query(
        `insert into projects (id, slug, name, repo_path, maister_yaml_path, task_key)
         values ('p5', 'dup-key', 'Dup', '/tmp/p5', '/tmp/m.yaml', 'TES')`,
      ),
    ).rejects.toMatchObject({ code: "23505" });
  });
});
