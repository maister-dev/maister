// IT-ATN-02 / IT-ATN-03 / IT-EDGE-ATN-02 (ADR-168 D1, D2, D3, D4) — the `updates`
// counter.
//
// `updates` is a JOIN, not a sum of two cheap counts. One mention writes BOTH a
// `task_activity` row and an `inbox_items` row for the recipient, so adding the
// two populations counts the most common event in the system twice. The
// subtraction is on `inbox_items.source_ref->>'activityId'`, and IT-ATN-02 is
// the test that fails the moment someone "simplifies" it back into a sum.

import { randomUUID } from "node:crypto";

import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

let testDatabase: StartedPostgresTestDb;
let pool: Pool;
let db: NodePgDatabase;

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));

let getUpdatesCount: typeof import("@/lib/queries/updates").getUpdatesCount;

const NOW = new Date("2026-09-10T12:00:00.000Z");
const HOURS_AGO_2 = new Date("2026-09-10T10:00:00.000Z");
const HOURS_AGO_30 = new Date("2026-09-09T06:00:00.000Z");

const fx = {
  member: randomUUID(),
  other: randomUUID(),
  project: randomUUID(),
  foreignProject: randomUUID(),
  task: randomUUID(),
  foreignTask: randomUUID(),
  blockerTask: randomUUID(),
  blockedTask: randomUUID(),
};

let taskNumber = 0;

async function seedProject(id: string, slug: string, key: string) {
  await pool.query(
    `insert into projects (id, slug, name, repo_path, maister_yaml_path, task_key)
     values ($1, $2, $2, $3, '/tmp/m.yaml', $4)`,
    [id, slug, `/tmp/${slug}`, key],
  );
}

async function seedTask(id: string, projectId: string, title: string) {
  taskNumber += 1;
  await pool.query(
    `insert into tasks (id, project_id, number, title, prompt, status, stage)
     values ($1, $2, $3, $4, 'p', 'Backlog', 'Backlog')`,
    [id, projectId, taskNumber, title],
  );
}

async function addActivity(
  taskId: string,
  projectId: string,
  createdAt: Date,
  kind = "comment_added",
): Promise<string> {
  const id = randomUUID();

  await pool.query(
    `insert into task_activity (id, task_id, project_id, actor_type, actor_id, event_kind, payload, created_at)
     values ($1, $2, $3, 'user', $4, $5, '{}'::jsonb, $6)`,
    [id, taskId, projectId, fx.other, kind, createdAt],
  );

  return id;
}

async function addInboxItem(
  taskId: string,
  projectId: string,
  activityId: string,
  createdAt: Date,
): Promise<string> {
  const id = randomUUID();

  await pool.query(
    `insert into inbox_items
       (id, recipient_type, recipient_id, project_id, task_id, event_kind, source_ref, created_at)
     values ($1, 'user', $2, $3, $4, 'task_mentioned', $5::jsonb, $6)`,
    [
      id,
      fx.member,
      projectId,
      taskId,
      JSON.stringify({
        kind: "mention",
        taskId,
        commentId: randomUUID(),
        activityId,
      }),
      createdAt,
    ],
  );

  return id;
}

async function clearActivity(): Promise<void> {
  await pool.query(`delete from inbox_items`);
  await pool.query(`delete from task_activity`);
  await pool.query(`delete from domain_events`);
  await pool.query(`delete from user_activity_cursors`);
}

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "updates_counter_test",
  });
  pool = testDatabase.pool;
  db = testDatabase.db;

  for (const [userId, email] of [
    [fx.member, "up-member@test.local"],
    [fx.other, "up-other@test.local"],
  ] as const) {
    await pool.query(
      `insert into users (id, email, role) values ($1, $2, 'member')`,
      [userId, email],
    );
  }

  await seedProject(fx.project, "up-own", "UPO");
  await seedProject(fx.foreignProject, "up-foreign", "UPF");
  await pool.query(
    `insert into project_members (id, project_id, user_id, role)
     values ($1, $2, $3, 'member')`,
    [randomUUID(), fx.project, fx.member],
  );

  await seedTask(fx.task, fx.project, "a task");
  await seedTask(fx.foreignTask, fx.foreignProject, "someone else's task");
  await seedTask(fx.blockerTask, fx.project, "the blocker");
  await seedTask(fx.blockedTask, fx.project, "blocked");
  await pool.query(
    `insert into task_relations (id, project_id, from_task_id, kind, to_task_id, actor_type, actor_id)
     values ($1, $2, $3, 'blocks', $4, 'user', $5)`,
    [randomUUID(), fx.project, fx.blockerTask, fx.blockedTask, fx.member],
  );

  ({ getUpdatesCount } = await import("@/lib/queries/updates"));
}, 180_000);

afterAll(async () => {
  await testDatabase?.stop();
});

beforeEach(async () => {
  await clearActivity();
});

describe("IT-ATN-02 one mention counts exactly once", () => {
  it("subtracts the inbox/activity overlap instead of summing both", async () => {
    const activityId = await addActivity(fx.task, fx.project, HOURS_AGO_2);

    await addInboxItem(fx.task, fx.project, activityId, HOURS_AGO_2);

    expect(await getUpdatesCount(fx.member, "member", NOW)).toBe(1);
  });

  it("counts an unread inbox item and an UNRELATED activity row separately", async () => {
    const mentioned = await addActivity(fx.task, fx.project, HOURS_AGO_2);

    await addInboxItem(fx.task, fx.project, mentioned, HOURS_AGO_2);
    await addActivity(fx.task, fx.project, HOURS_AGO_2, "task_created");

    expect(await getUpdatesCount(fx.member, "member", NOW)).toBe(2);
  });

  it("stops counting an inbox item once it is read", async () => {
    const activityId = await addActivity(fx.task, fx.project, HOURS_AGO_2);
    const inboxId = await addInboxItem(
      fx.task,
      fx.project,
      activityId,
      HOURS_AGO_2,
    );

    await pool.query(`update inbox_items set read_at = now() where id = $1`, [
      inboxId,
    ]);

    // The activity row survives the read: it is newer than the cursor and no
    // longer represented by an UNREAD inbox item, so the total stays 1.
    expect(await getUpdatesCount(fx.member, "member", NOW)).toBe(1);
  });
});

describe("IT-ATN-03 no cursor row means a bounded window, not all history", () => {
  it("counts only the last 24 hours when the reader has never looked", async () => {
    await addActivity(fx.task, fx.project, HOURS_AGO_2);
    await addActivity(fx.task, fx.project, HOURS_AGO_30);

    expect(await getUpdatesCount(fx.member, "member", NOW)).toBe(1);
  });

  it("counts everything after the cursor once one exists", async () => {
    await addActivity(fx.task, fx.project, HOURS_AGO_2);
    await addActivity(fx.task, fx.project, HOURS_AGO_30);
    await pool.query(
      `insert into user_activity_cursors (user_id, seen_through) values ($1, $2)`,
      [fx.member, new Date("2026-09-08T00:00:00.000Z")],
    );

    expect(await getUpdatesCount(fx.member, "member", NOW)).toBe(2);
  });

  it("counts nothing when the cursor is current", async () => {
    await addActivity(fx.task, fx.project, HOURS_AGO_2);
    await pool.query(
      `insert into user_activity_cursors (user_id, seen_through) values ($1, $2)`,
      [fx.member, NOW],
    );

    expect(await getUpdatesCount(fx.member, "member", NOW)).toBe(0);
  });
});

describe("ATN-04 / ATN-11 scope", () => {
  it("counts nothing from a project the reader cannot see", async () => {
    await addActivity(fx.foreignTask, fx.foreignProject, HOURS_AGO_2);

    expect(await getUpdatesCount(fx.member, "member", NOW)).toBe(0);
  });

  it("excludes activity on a relation-blocked task", async () => {
    await addActivity(fx.blockedTask, fx.project, HOURS_AGO_2);
    await addActivity(fx.task, fx.project, HOURS_AGO_2);

    expect(await getUpdatesCount(fx.member, "member", NOW)).toBe(1);
  });

  // The second overlap, one table over from ATN-02's: creating a task writes
  // `task_created` AND `task.created` in ONE transaction, so summing the two
  // tables scores a single creation twice. `ATTENTION_EVENT_KINDS` is the
  // complement that keeps the count — and the activity feed — honest.
  it("counts a task creation once, not once per table", async () => {
    const activityId = await addActivity(
      fx.task,
      fx.project,
      HOURS_AGO_2,
      "task_created",
    );

    await pool.query(
      `insert into domain_events (kind, project_id, task_id, actor_type, actor_id, payload, occurred_at)
       values ('task.created', $1, $2, 'user', $3, '{}'::jsonb, $4)`,
      [fx.project, fx.task, fx.other, HOURS_AGO_2],
    );

    expect(activityId).toBeTruthy();
    expect(await getUpdatesCount(fx.member, "member", NOW)).toBe(1);
  });

  it("counts a run domain event beside task activity", async () => {
    await addActivity(fx.task, fx.project, HOURS_AGO_2);
    await pool.query(
      `insert into domain_events (kind, project_id, task_id, actor_type, payload, occurred_at)
       values ('run.crashed', $1, $2, 'system', '{}'::jsonb, $3)`,
      [fx.project, fx.task, HOURS_AGO_2],
    );

    expect(await getUpdatesCount(fx.member, "member", NOW)).toBe(2);
  });

  it("returns zero for a user who belongs to no project", async () => {
    await addActivity(fx.task, fx.project, HOURS_AGO_2);

    expect(await getUpdatesCount(randomUUID(), "member", NOW)).toBe(0);
  });
});

describe("IT-EDGE-ATN-02 membership change never rewinds the cursor", () => {
  it("shows a newly added member that project's activity from joining forward", async () => {
    // Activity written BEFORE the member joined, and a cursor written after it.
    await addActivity(fx.foreignTask, fx.foreignProject, HOURS_AGO_2);
    await pool.query(
      `insert into user_activity_cursors (user_id, seen_through) values ($1, $2)`,
      [fx.member, new Date("2026-09-10T11:00:00.000Z")],
    );
    await pool.query(
      `insert into project_members (id, project_id, user_id, role)
       values ($1, $2, $3, 'member')`,
      [randomUUID(), fx.foreignProject, fx.member],
    );

    // The cursor is NOT rewound, so the pre-join backlog stays unseen.
    expect(await getUpdatesCount(fx.member, "member", NOW)).toBe(0);

    await addActivity(
      fx.foreignTask,
      fx.foreignProject,
      new Date("2026-09-10T11:30:00.000Z"),
    );

    expect(await getUpdatesCount(fx.member, "member", NOW)).toBe(1);

    await pool.query(
      `delete from project_members where project_id = $1 and user_id = $2`,
      [fx.foreignProject, fx.member],
    );

    // Removed: filtered by CURRENT visibility, so it stops counting at once.
    expect(await getUpdatesCount(fx.member, "member", NOW)).toBe(0);
  });
});
