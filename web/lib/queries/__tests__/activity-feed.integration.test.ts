// IT-ATN-09 (M51, ADR-169) — the cross-project activity feed.
//
// The load-bearing case is REDACTION, and it is only worth anything if the
// rows underneath actually carry what must not escape. Every fixture below
// stuffs a worktree path, a diff hunk and an ACP session id into the columns a
// lazier projection would spread (`payload`, `last_error_message`,
// `response_snippet`) — then asserts both that the probes fire on the raw rows
// and that they find nothing anywhere in the DTOs. A redaction test fed
// already-safe literals proves nothing.

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

let getCrossProjectActivityFeed: typeof import("@/lib/queries/activity-feed").getCrossProjectActivityFeed;

const WORKTREE_PATH = "/Users/kaa/.maister/alpha/runs/run-1/worktree";
const DIFF_HUNK = "@@ -1,4 +1,9 @@\n-const a = 1;\n+const a = 2;";
const ACP_SESSION_ID = "acp-sess-01J8ZZZZZZZZZZZZZZZZZZZZZZ";

const LEAK_PROBES: Array<[string, RegExp]> = [
  ["diff hunk", /@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/],
  ["worktree path", /\.maister\//],
  ["absolute host path", /(?:^|[^\w])\/(?:Users|home|var\/folders)\//],
  ["acp session id", /acp-sess-/],
];

const AT = {
  oldest: new Date("2026-09-10T08:00:00.000Z"),
  early: new Date("2026-09-10T09:00:00.000Z"),
  mid: new Date("2026-09-10T10:00:00.000Z"),
  late: new Date("2026-09-10T11:00:00.000Z"),
  newest: new Date("2026-09-10T11:30:00.000Z"),
};

const fx = {
  member: randomUUID(),
  admin: randomUUID(),
  stranger: randomUUID(),
  agent: randomUUID(),
  project: randomUUID(),
  foreignProject: randomUUID(),
  flow: randomUUID(),
  foreignFlow: randomUUID(),
  task: randomUUID(),
  otherTask: randomUUID(),
  foreignTask: randomUUID(),
  run: randomUUID(),
  foreignRun: randomUUID(),
  subscription: randomUUID(),
};

let taskNumber = 0;

async function seedProject(
  projectId: string,
  slug: string,
  key: string,
): Promise<void> {
  await pool.query(
    `insert into projects (id, slug, name, repo_path, maister_yaml_path, task_key)
     values ($1, $2, $2, $3, '/tmp/m.yaml', $4)`,
    [projectId, slug, `/tmp/${slug}`, key],
  );
}

async function seedFlow(flowId: string, projectId: string): Promise<void> {
  await pool.query(
    `insert into flows (id, project_id, flow_ref_id, source, version, installed_path, manifest, schema_version)
     values ($1, $2, 'aif', 'github.com/x/y', 'v1.0.0', '/tmp/flows/aif', $3::jsonb, 1)`,
    [
      flowId,
      projectId,
      JSON.stringify({ schemaVersion: 1, name: "aif", nodes: [] }),
    ],
  );
}

async function seedTask(
  taskId: string,
  projectId: string,
  flowId: string,
  title: string,
): Promise<void> {
  taskNumber += 1;
  await pool.query(
    `insert into tasks (id, project_id, number, title, prompt, flow_id, status, stage)
     values ($1, $2, $3, $4, 'p', $5, 'Backlog', 'Backlog')`,
    [taskId, projectId, taskNumber, title, flowId],
  );
}

async function seedRun(
  runId: string,
  projectId: string,
  flowId: string,
  taskId: string,
): Promise<void> {
  await pool.query(
    `insert into runs (id, task_id, project_id, flow_id, status, flow_version)
     values ($1, $2, $3, $4, 'Review', 'v1.0.0')`,
    [runId, taskId, projectId, flowId],
  );
  await pool.query(
    `insert into workspaces (id, project_id, run_id, branch, worktree_path, parent_repo_path, target_branch)
     values ($1, $2, $3, $4, $5, '/tmp/parent', 'main')`,
    [randomUUID(), projectId, runId, `maister/${runId}`, `/tmp/ws-${runId}`],
  );
}

/** A payload shaped exactly like the ones an agent step really writes. */
function leakyPayload(extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    worktreePath: WORKTREE_PATH,
    diff: DIFF_HUNK,
    acpSessionId: ACP_SESSION_ID,
    ...extra,
  });
}

async function addActivity(opts: {
  taskId: string;
  projectId: string;
  kind: string;
  at: Date;
  actorType?: "user" | "agent" | "system";
  actorId?: string | null;
  payload?: string;
}): Promise<string> {
  const id = randomUUID();
  const actorType = opts.actorType ?? "user";

  await pool.query(
    `insert into task_activity (id, task_id, project_id, actor_type, actor_id, event_kind, payload, created_at)
     values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`,
    [
      id,
      opts.taskId,
      opts.projectId,
      actorType,
      actorType === "system" ? null : (opts.actorId ?? fx.member),
      opts.kind,
      opts.payload ?? leakyPayload(),
      opts.at,
    ],
  );

  return id;
}

async function addEvent(opts: {
  kind: string;
  projectId: string;
  at: Date;
  taskId?: string | null;
  runId?: string | null;
  actorType?: "user" | "agent" | "system" | null;
  actorId?: string | null;
  payload?: string;
}): Promise<void> {
  const actorType = opts.actorType === undefined ? "user" : opts.actorType;

  await pool.query(
    `insert into domain_events (kind, project_id, task_id, run_id, actor_type, actor_id, payload, occurred_at)
     values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`,
    [
      opts.kind,
      opts.projectId,
      opts.taskId ?? null,
      opts.runId ?? null,
      actorType,
      actorType === "system" || actorType === null
        ? null
        : (opts.actorId ?? fx.member),
      opts.payload ?? leakyPayload(),
      opts.at,
    ],
  );
}

async function addDelivery(opts: {
  projectId: string;
  runId: string;
  status: "pending" | "delivered" | "dead";
  at: Date;
}): Promise<string> {
  const eventId = randomUUID();
  const deliveryId = randomUUID();

  await pool.query(
    `insert into webhook_events (id, project_id, run_id, type, data, payload, occurred_at, fanout_at)
     values ($1, $2, $3, 'run.done', $4::jsonb, $4::jsonb, $5, $5)`,
    [eventId, opts.projectId, opts.runId, leakyPayload(), opts.at],
  );
  await pool.query(
    `insert into webhook_deliveries
       (id, event_id, subscription_id, status, attempt_count, next_attempt_at,
        idempotency_key, last_http_status, last_error_kind, last_error_message,
        delivered_at, created_at, updated_at)
     values ($1, $2, $3, $4, 2, $5, $6, $7, $8, $9, $10, $5, $5)`,
    [
      deliveryId,
      eventId,
      fx.subscription,
      opts.status,
      opts.at,
      randomUUID(),
      opts.status === "delivered" ? 200 : 500,
      opts.status === "delivered" ? null : "http",
      // The real leak vector: a target echoing the request body back.
      `remote said: ${WORKTREE_PATH} ${DIFF_HUNK}`,
      opts.status === "delivered" ? opts.at : null,
    ],
  );
  await pool.query(
    `insert into webhook_delivery_attempts
       (id, delivery_id, attempt_no, requested_at, duration_ms, http_status, error_kind, error_detail, response_snippet)
     values ($1, $2, 1, $3, 12, 500, 'http', $4, $4)`,
    [randomUUID(), deliveryId, opts.at, `${WORKTREE_PATH}\n${DIFF_HUNK}`],
  );

  return deliveryId;
}

async function clearActivity(): Promise<void> {
  await pool.query(`delete from webhook_delivery_attempts`);
  await pool.query(`delete from webhook_deliveries`);
  await pool.query(`delete from webhook_events`);
  await pool.query(`delete from task_activity`);
  await pool.query(`delete from domain_events`);
  await pool.query(`delete from task_subscribers`);
}

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "activity_feed_test",
  });
  pool = testDatabase.pool;
  db = testDatabase.db;

  for (const [userId, email, role] of [
    [fx.member, "af-member@test.local", "member"],
    [fx.admin, "af-admin@test.local", "admin"],
    [fx.stranger, "af-stranger@test.local", "member"],
  ] as const) {
    await pool.query(
      `insert into users (id, email, role) values ($1, $2, $3)`,
      [userId, email, role],
    );
  }

  await seedProject(fx.project, "af-own", "AFO");
  await seedProject(fx.foreignProject, "af-foreign", "AFF");
  await pool.query(
    `insert into project_members (id, project_id, user_id, role)
     values ($1, $2, $3, 'member')`,
    [randomUUID(), fx.project, fx.member],
  );

  await seedFlow(fx.flow, fx.project);
  await seedFlow(fx.foreignFlow, fx.foreignProject);
  await seedTask(fx.task, fx.project, fx.flow, "a visible task");
  await seedTask(fx.otherTask, fx.project, fx.flow, "another visible task");
  await seedTask(fx.foreignTask, fx.foreignProject, fx.foreignFlow, "hidden");
  await seedRun(fx.run, fx.project, fx.flow, fx.task);
  await seedRun(
    fx.foreignRun,
    fx.foreignProject,
    fx.foreignFlow,
    fx.foreignTask,
  );

  await pool.query(
    `insert into webhook_subscriptions (id, project_id, name, url, event_types, signing_secret_ref)
     values ($1, $2, 'ops relay', 'https://hooks.test.local/x', $3::jsonb, 'env:HOOK_SECRET')`,
    [fx.subscription, fx.project, JSON.stringify(["run.done"])],
  );

  ({ getCrossProjectActivityFeed } = await import(
    "@/lib/queries/activity-feed"
  ));
}, 180_000);

afterAll(async () => {
  await testDatabase?.stop();
});

beforeEach(async () => {
  await clearActivity();
});

const reader = { id: fx.member, role: "member" as const };

describe("IT-ATN-09 the feed never carries a path, a hunk or a session id", () => {
  it("fires every probe on the raw rows it was fed (positive control)", async () => {
    await addActivity({
      taskId: fx.task,
      projectId: fx.project,
      kind: "run_launched",
      at: AT.mid,
    });
    await addEvent({
      kind: "run.crashed",
      projectId: fx.project,
      taskId: fx.task,
      runId: fx.run,
      at: AT.late,
    });
    await addDelivery({
      projectId: fx.project,
      runId: fx.run,
      status: "dead",
      at: AT.early,
    });

    const raw = JSON.stringify([
      (await pool.query(`select payload from task_activity`)).rows,
      (await pool.query(`select payload from domain_events`)).rows,
      (
        await pool.query(
          `select last_error_message from webhook_deliveries
           union all select response_snippet from webhook_delivery_attempts`,
        )
      ).rows,
    ]);

    for (const [label, probe] of LEAK_PROBES) {
      expect(probe.test(raw), `${label} missing from the fixture`).toBe(true);
    }
  });

  it("finds none of them anywhere in the projected rows", async () => {
    await addActivity({
      taskId: fx.task,
      projectId: fx.project,
      kind: "run_launched",
      at: AT.mid,
    });
    await addEvent({
      kind: "run.crashed",
      projectId: fx.project,
      taskId: fx.task,
      runId: fx.run,
      at: AT.late,
    });
    await addDelivery({
      projectId: fx.project,
      runId: fx.run,
      status: "dead",
      at: AT.early,
    });

    const { rows } = await getCrossProjectActivityFeed(reader);

    expect(rows).toHaveLength(3);
    const serialized = JSON.stringify(rows);

    for (const [label, probe] of LEAK_PROBES) {
      expect(probe.test(serialized), `${label} leaked into the feed`).toBe(
        false,
      );
    }
  });

  it("projects an exact key set, so a new column cannot ride along", async () => {
    await addActivity({
      taskId: fx.task,
      projectId: fx.project,
      kind: "comment_added",
      at: AT.mid,
    });

    const { rows } = await getCrossProjectActivityFeed(reader);

    expect(Object.keys(rows[0]).sort()).toEqual([
      "actor",
      "gateId",
      "hitlRequestId",
      "id",
      "kind",
      "occurredAt",
      "projectId",
      "projectName",
      "projectSlug",
      "runId",
      "source",
      "taskId",
      "taskKey",
      "taskNumber",
      "taskTitle",
      "webhook",
    ]);
    expect(Object.keys(rows[0])).not.toContain("payload");
  });

  it("keeps the webhook outcome without the response body or the URL", async () => {
    await addDelivery({
      projectId: fx.project,
      runId: fx.run,
      status: "dead",
      at: AT.mid,
    });

    const [row] = (await getCrossProjectActivityFeed(reader)).rows;

    expect(row.kind).toBe("webhook_dead");
    expect(row.webhook).toEqual({
      subscriptionName: "ops relay",
      attemptCount: 2,
      httpStatus: 500,
      errorKind: "http",
    });
    expect(JSON.stringify(row)).not.toContain("hooks.test.local");
  });
});

describe("the union covers what no single table holds", () => {
  it("unions task activity, run events and settled deliveries", async () => {
    await addActivity({
      taskId: fx.task,
      projectId: fx.project,
      kind: "comment_added",
      at: AT.early,
    });
    await addEvent({
      kind: "run.done",
      projectId: fx.project,
      taskId: fx.task,
      runId: fx.run,
      at: AT.mid,
    });
    await addDelivery({
      projectId: fx.project,
      runId: fx.run,
      status: "delivered",
      at: AT.late,
    });

    const { rows } = await getCrossProjectActivityFeed(reader);

    expect(rows.map((row) => row.source)).toEqual(["webhook", "event", "task"]);
    expect(rows.map((row) => row.kind)).toEqual([
      "webhook_delivered",
      "run.done",
      "comment_added",
    ]);
  });

  it("shows a run terminal transition that has no task_activity kind", async () => {
    await addEvent({
      kind: "run.crashed",
      projectId: fx.project,
      taskId: fx.task,
      runId: fx.run,
      at: AT.mid,
    });

    const [row] = (await getCrossProjectActivityFeed(reader)).rows;

    expect(row.kind).toBe("run.crashed");
    expect(row.runId).toBe(fx.run);
    expect(row.taskKey).toBe(`AFO-${1}`);
  });

  // The twin trap: creating a task writes `task_created` AND `task.created` in
  // ONE transaction. Rendering both prints the same fact twice — and counting
  // both is what `ATTENTION_EVENT_KINDS` exists to stop.
  it("renders a task creation once, not once per table", async () => {
    await addActivity({
      taskId: fx.task,
      projectId: fx.project,
      kind: "task_created",
      at: AT.mid,
    });
    await addEvent({
      kind: "task.created",
      projectId: fx.project,
      taskId: fx.task,
      at: AT.mid,
    });

    const { rows } = await getCrossProjectActivityFeed(reader);

    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("task_created");
  });

  it("keeps task.clarification_answered, which has no twin", async () => {
    await addEvent({
      kind: "task.clarification_answered",
      projectId: fx.project,
      taskId: fx.task,
      runId: fx.run,
      at: AT.mid,
      payload: leakyPayload({ hitlRequestId: "hitl-7" }),
    });

    const [row] = (await getCrossProjectActivityFeed(reader)).rows;

    expect(row.kind).toBe("task.clarification_answered");
    expect(row.hitlRequestId).toBe("hitl-7");
  });

  it("ignores a delivery that has not settled yet", async () => {
    await addDelivery({
      projectId: fx.project,
      runId: fx.run,
      status: "pending",
      at: AT.mid,
    });

    expect((await getCrossProjectActivityFeed(reader)).rows).toEqual([]);
  });

  it("carries a run_launched activity's run id out of its payload", async () => {
    await addActivity({
      taskId: fx.task,
      projectId: fx.project,
      kind: "run_launched",
      at: AT.mid,
      payload: leakyPayload({ runId: fx.run }),
    });

    expect((await getCrossProjectActivityFeed(reader)).rows[0].runId).toBe(
      fx.run,
    );
  });
});

describe("scope follows current visibility", () => {
  it("shows nothing from a project the reader does not belong to", async () => {
    await addActivity({
      taskId: fx.foreignTask,
      projectId: fx.foreignProject,
      kind: "comment_added",
      at: AT.mid,
    });
    await addEvent({
      kind: "run.done",
      projectId: fx.foreignProject,
      runId: fx.foreignRun,
      at: AT.mid,
    });
    await addDelivery({
      projectId: fx.foreignProject,
      runId: fx.foreignRun,
      status: "delivered",
      at: AT.mid,
    });

    expect((await getCrossProjectActivityFeed(reader)).rows).toEqual([]);
  });

  it("reaches every non-archived project for an admin", async () => {
    await addActivity({
      taskId: fx.foreignTask,
      projectId: fx.foreignProject,
      kind: "comment_added",
      at: AT.mid,
    });

    const { rows } = await getCrossProjectActivityFeed({
      id: fx.admin,
      role: "admin",
    });

    expect(rows).toHaveLength(1);
    expect(rows[0].projectSlug).toBe("af-foreign");
  });

  it("drops — never refuses — a project filter the reader cannot see", async () => {
    await addActivity({
      taskId: fx.task,
      projectId: fx.project,
      kind: "comment_added",
      at: AT.mid,
    });

    const result = await getCrossProjectActivityFeed(reader, {
      projectId: fx.foreignProject,
    });

    expect(result.rows).toEqual([]);
    expect(result.projectCount).toBe(1);
  });

  it("separates 'no projects' from 'no activity'", async () => {
    const stranger = await getCrossProjectActivityFeed({
      id: fx.stranger,
      role: "member",
    });

    expect(stranger).toEqual({ rows: [], hasMore: false, projectCount: 0 });
    expect((await getCrossProjectActivityFeed(reader)).projectCount).toBe(1);
  });
});

describe("filters", () => {
  beforeEach(async () => {
    await addActivity({
      taskId: fx.task,
      projectId: fx.project,
      kind: "comment_added",
      at: AT.oldest,
      actorType: "user",
      actorId: fx.member,
    });
    await addActivity({
      taskId: fx.otherTask,
      projectId: fx.project,
      kind: "agent_quarantined",
      at: AT.early,
      actorType: "system",
    });
    await addEvent({
      kind: "gate.failed",
      projectId: fx.project,
      taskId: fx.otherTask,
      runId: fx.run,
      at: AT.mid,
      actorType: "system",
      payload: JSON.stringify({ gateId: "lint", diff: DIFF_HUNK }),
    });
    await addDelivery({
      projectId: fx.project,
      runId: fx.run,
      status: "delivered",
      at: AT.late,
    });
  });

  it("filters by actor type, and drops the actorless webhook source with it", async () => {
    const { rows } = await getCrossProjectActivityFeed(reader, {
      actorType: "system",
    });

    expect(rows.map((row) => row.kind)).toEqual([
      "gate.failed",
      "agent_quarantined",
    ]);
  });

  it("filters by a task-activity kind", async () => {
    const { rows } = await getCrossProjectActivityFeed(reader, {
      kind: "comment_added",
    });

    expect(rows.map((row) => row.kind)).toEqual(["comment_added"]);
  });

  it("filters by a domain-event kind and exposes its gate id", async () => {
    const { rows } = await getCrossProjectActivityFeed(reader, {
      kind: "gate.failed",
    });

    expect(rows).toHaveLength(1);
    expect(rows[0].gateId).toBe("lint");
  });

  it("filters by a webhook outcome kind", async () => {
    const { rows } = await getCrossProjectActivityFeed(reader, {
      kind: "webhook_delivered",
    });

    expect(rows.map((row) => row.kind)).toEqual(["webhook_delivered"]);
  });

  it("'mine' keeps only subscribed tasks and drops the taskless sources", async () => {
    await pool.query(
      `insert into task_subscribers (id, task_id, subscriber_type, subscriber_id, reason)
       values ($1, $2, 'user', $3, 'manual')`,
      [randomUUID(), fx.task, fx.member],
    );

    const { rows } = await getCrossProjectActivityFeed(reader, { mine: true });

    expect(rows.map((row) => row.kind)).toEqual(["comment_added"]);
  });

  it("scopes to one visible project", async () => {
    const { rows } = await getCrossProjectActivityFeed(reader, {
      projectId: fx.project,
    });

    expect(rows).toHaveLength(4);
    expect(new Set(rows.map((row) => row.projectSlug))).toEqual(
      new Set(["af-own"]),
    );
  });
});

describe("ordering and bounds", () => {
  it("orders newest first across every source", async () => {
    await addActivity({
      taskId: fx.task,
      projectId: fx.project,
      kind: "comment_added",
      at: AT.mid,
    });
    await addEvent({
      kind: "run.done",
      projectId: fx.project,
      runId: fx.run,
      at: AT.newest,
    });
    await addDelivery({
      projectId: fx.project,
      runId: fx.run,
      status: "delivered",
      at: AT.oldest,
    });

    const { rows } = await getCrossProjectActivityFeed(reader);

    expect(rows.map((row) => row.occurredAt.toISOString())).toEqual([
      AT.newest.toISOString(),
      AT.mid.toISOString(),
      AT.oldest.toISOString(),
    ]);
  });

  it("honours the limit and reports that more exists", async () => {
    for (const at of [AT.oldest, AT.early, AT.mid]) {
      await addActivity({
        taskId: fx.task,
        projectId: fx.project,
        kind: "comment_added",
        at,
      });
    }

    const capped = await getCrossProjectActivityFeed(reader, { limit: 2 });

    expect(capped.rows).toHaveLength(2);
    expect(capped.hasMore).toBe(true);
    expect((await getCrossProjectActivityFeed(reader)).hasMore).toBe(false);
  });

  it("labels the actor rather than exposing a bare id", async () => {
    await addActivity({
      taskId: fx.task,
      projectId: fx.project,
      kind: "comment_added",
      at: AT.mid,
      actorType: "user",
      actorId: fx.member,
    });

    expect((await getCrossProjectActivityFeed(reader)).rows[0].actor).toEqual({
      type: "user",
      id: fx.member,
      label: "af-member@test.local",
    });
  });

  it("keeps an actorless domain event's actor null, not a fake system actor", async () => {
    await addEvent({
      kind: "run.done",
      projectId: fx.project,
      runId: fx.run,
      at: AT.mid,
      actorType: null,
    });

    expect(
      (await getCrossProjectActivityFeed(reader)).rows[0].actor,
    ).toBeNull();
  });
});
