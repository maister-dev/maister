// T5.4 — the Now-tile window (`ATN-12`'s read half).
//
// `UT-ATN-12` proves the SENTENCE is deterministic; this proves the five
// numbers it renders are the right five. The cases that matter are all
// boundaries: what falls outside the window, what falls outside the reader's
// projects, and what a reader with no cursor at all is shown.

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

let getNowTileCounts: typeof import("@/lib/queries/digest").getNowTileCounts;
let NOW_TILE_IDS: typeof import("@/lib/queries/digest").NOW_TILE_IDS;

const NOW = new Date("2026-09-10T12:00:00.000Z");
const IN_WINDOW = new Date("2026-09-10T11:00:00.000Z");
const CURSOR = new Date("2026-09-10T10:00:00.000Z");
const BEFORE_CURSOR = new Date("2026-09-10T09:00:00.000Z");
const BEFORE_24H = new Date("2026-09-08T12:00:00.000Z");

const fx = {
  member: randomUUID(),
  stranger: randomUUID(),
  project: randomUUID(),
  foreignProject: randomUUID(),
  flow: randomUUID(),
  foreignFlow: randomUUID(),
  task: randomUUID(),
  foreignTask: randomUUID(),
};

let taskNumber = 0;

async function seedProject(id: string, slug: string, key: string) {
  await pool.query(
    `insert into projects (id, slug, name, repo_path, maister_yaml_path, task_key)
     values ($1, $2, $2, $3, '/tmp/m.yaml', $4)`,
    [id, slug, `/tmp/${slug}`, key],
  );
}

async function seedFlow(flowId: string, projectId: string) {
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

async function seedTask(taskId: string, projectId: string, flowId: string) {
  taskNumber += 1;
  await pool.query(
    `insert into tasks (id, project_id, number, title, prompt, flow_id, status, stage)
     values ($1, $2, $3, 'a task', 'p', $4, 'Backlog', 'Backlog')`,
    [taskId, projectId, taskNumber, flowId],
  );
}

async function seedRun(opts: {
  projectId: string;
  flowId: string;
  taskId: string;
  startedAt: Date;
  status?: string;
  endedAt?: Date | null;
  promotedAt?: Date | null;
  tokens?: number;
}): Promise<string> {
  const runId = randomUUID();

  await pool.query(
    `insert into runs (id, task_id, project_id, flow_id, status, flow_version, started_at, ended_at)
     values ($1, $2, $3, $4, $5, 'v1.0.0', $6, $7)`,
    [
      runId,
      opts.taskId,
      opts.projectId,
      opts.flowId,
      opts.status ?? "Done",
      opts.startedAt,
      opts.endedAt ?? null,
    ],
  );
  await pool.query(
    `insert into workspaces (id, project_id, run_id, branch, worktree_path, parent_repo_path, target_branch, promoted_at)
     values ($1, $2, $3, $4, $5, '/tmp/parent', 'main', $6)`,
    [
      randomUUID(),
      opts.projectId,
      runId,
      `maister/${runId}`,
      `/tmp/ws-${runId}`,
      opts.promotedAt ?? null,
    ],
  );
  if (opts.tokens) {
    await pool.query(
      `insert into run_cost_rollups (run_id, project_id, task_id, input_tokens, output_tokens)
       values ($1, $2, $3, $4, 0)`,
      [runId, opts.projectId, opts.taskId, opts.tokens],
    );
  }

  return runId;
}

async function setCursor(at: Date | null): Promise<void> {
  await pool.query(`delete from user_activity_cursors`);
  if (at) {
    await pool.query(
      `insert into user_activity_cursors (user_id, seen_through) values ($1, $2)`,
      [fx.member, at],
    );
  }
}

async function tiles(userId = fx.member, role: "member" | "admin" = "member") {
  const window = await getNowTileCounts({ id: userId, role }, NOW);

  return Object.fromEntries(
    window.tiles.map((tile) => [tile.id, tile.value]),
  ) as Record<string, number>;
}

async function clearWindow(): Promise<void> {
  await pool.query(`delete from run_cost_rollups`);
  await pool.query(`delete from workspaces`);
  await pool.query(`delete from domain_events`);
  await pool.query(`delete from runs`);
  await pool.query(`delete from user_activity_cursors`);
}

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "digest_tiles_test",
  });
  pool = testDatabase.pool;
  db = testDatabase.db;

  for (const [userId, email] of [
    [fx.member, "dg-member@test.local"],
    [fx.stranger, "dg-stranger@test.local"],
  ] as const) {
    await pool.query(
      `insert into users (id, email, role) values ($1, $2, 'member')`,
      [userId, email],
    );
  }
  await seedProject(fx.project, "dg-own", "DGO");
  await seedProject(fx.foreignProject, "dg-foreign", "DGF");
  await pool.query(
    `insert into project_members (id, project_id, user_id, role)
     values ($1, $2, $3, 'member')`,
    [randomUUID(), fx.project, fx.member],
  );
  await seedFlow(fx.flow, fx.project);
  await seedFlow(fx.foreignFlow, fx.foreignProject);
  await seedTask(fx.task, fx.project, fx.flow);
  await seedTask(fx.foreignTask, fx.foreignProject, fx.foreignFlow);

  ({ getNowTileCounts, NOW_TILE_IDS } = await import("@/lib/queries/digest"));
}, 180_000);

afterAll(async () => {
  await testDatabase?.stop();
});

beforeEach(async () => {
  await clearWindow();
  await setCursor(CURSOR);
});

describe("Now tiles count the window since the cursor", () => {
  it("always returns the full tile set, even with nothing to report", async () => {
    const window = await getNowTileCounts(
      { id: fx.member, role: "member" },
      NOW,
    );

    expect(window.tiles.map((tile) => tile.id)).toEqual([...NOW_TILE_IDS]);
    expect(window.tiles.every((tile) => tile.value === 0)).toBe(true);
    expect(window.since).toEqual(CURSOR);
    expect(window.hasCursor).toBe(true);
  });

  it("counts a promotion inside the window and not one before it", async () => {
    await seedRun({
      projectId: fx.project,
      flowId: fx.flow,
      taskId: fx.task,
      startedAt: BEFORE_CURSOR,
      promotedAt: IN_WINDOW,
    });
    await seedRun({
      projectId: fx.project,
      flowId: fx.flow,
      taskId: fx.task,
      startedAt: BEFORE_CURSOR,
      promotedAt: BEFORE_CURSOR,
    });

    expect((await tiles()).promoted).toBe(1);
  });

  it("counts a crash inside the window and not one before it", async () => {
    for (const at of [IN_WINDOW, BEFORE_CURSOR]) {
      await pool.query(
        `insert into domain_events (kind, project_id, actor_type, payload, occurred_at)
         values ('run.crashed', $1, 'system', '{}'::jsonb, $2)`,
        [fx.project, at],
      );
    }

    expect((await tiles()).crashed).toBe(1);
  });

  // Attribution is by run start: a rollup carries one running total, so
  // windowing on the rollup would charge a long-lived run's whole history to
  // whatever window it last wrote in.
  it("counts tokens for runs started in the window only", async () => {
    await seedRun({
      projectId: fx.project,
      flowId: fx.flow,
      taskId: fx.task,
      startedAt: IN_WINDOW,
      tokens: 1200,
    });
    await seedRun({
      projectId: fx.project,
      flowId: fx.flow,
      taskId: fx.task,
      startedAt: BEFORE_CURSOR,
      tokens: 90000,
    });

    expect((await tiles()).tokens).toBe(1200);
  });

  it("counts a decision that arrived after the cursor, not the backlog", async () => {
    await seedRun({
      projectId: fx.project,
      flowId: fx.flow,
      taskId: fx.task,
      startedAt: BEFORE_CURSOR,
      status: "Crashed",
      endedAt: IN_WINDOW,
    });
    await seedRun({
      projectId: fx.project,
      flowId: fx.flow,
      taskId: fx.task,
      startedAt: BEFORE_CURSOR,
      status: "Crashed",
      endedAt: BEFORE_CURSOR,
    });

    expect((await tiles()).decisions).toBe(1);
  });

  it("counts activity the reader has not seen as new events", async () => {
    await pool.query(
      `insert into task_activity (id, task_id, project_id, actor_type, actor_id, event_kind, payload, created_at)
       values ($1, $2, $3, 'user', $4, 'comment_added', '{}'::jsonb, $5)`,
      [randomUUID(), fx.task, fx.project, fx.stranger, IN_WINDOW],
    );

    expect((await tiles()).events).toBe(1);
    await pool.query(`delete from task_activity`);
  });
});

describe("the window without a cursor", () => {
  it("falls back to 24 hours rather than all history", async () => {
    await setCursor(null);
    await seedRun({
      projectId: fx.project,
      flowId: fx.flow,
      taskId: fx.task,
      startedAt: BEFORE_CURSOR,
      promotedAt: BEFORE_CURSOR,
    });
    await seedRun({
      projectId: fx.project,
      flowId: fx.flow,
      taskId: fx.task,
      startedAt: BEFORE_24H,
      promotedAt: BEFORE_24H,
    });

    const window = await getNowTileCounts(
      { id: fx.member, role: "member" },
      NOW,
    );

    expect(window.hasCursor).toBe(false);
    expect(window.since).toEqual(new Date(NOW.getTime() - 24 * 60 * 60 * 1000));
    expect(window.tiles.find((tile) => tile.id === "promoted")?.value).toBe(1);
  });
});

describe("the window follows current visibility", () => {
  it("counts nothing from a project the reader cannot see", async () => {
    await seedRun({
      projectId: fx.foreignProject,
      flowId: fx.foreignFlow,
      taskId: fx.foreignTask,
      startedAt: IN_WINDOW,
      promotedAt: IN_WINDOW,
      tokens: 5000,
    });
    await pool.query(
      `insert into domain_events (kind, project_id, actor_type, payload, occurred_at)
       values ('run.crashed', $1, 'system', '{}'::jsonb, $2)`,
      [fx.foreignProject, IN_WINDOW],
    );

    expect(await tiles()).toMatchObject({
      promoted: 0,
      crashed: 0,
      tokens: 0,
    });
  });

  it("returns a zeroed tile set for a reader who belongs to no project", async () => {
    await seedRun({
      projectId: fx.project,
      flowId: fx.flow,
      taskId: fx.task,
      startedAt: IN_WINDOW,
      promotedAt: IN_WINDOW,
      tokens: 4200,
    });

    const window = await getNowTileCounts(
      { id: fx.stranger, role: "member" },
      NOW,
    );

    expect(window.tiles.map((tile) => tile.id)).toEqual([...NOW_TILE_IDS]);
    expect(window.tiles.every((tile) => tile.value === 0)).toBe(true);
  });

  it("reaches every non-archived project for an admin", async () => {
    await seedRun({
      projectId: fx.foreignProject,
      flowId: fx.foreignFlow,
      taskId: fx.foreignTask,
      startedAt: IN_WINDOW,
      promotedAt: IN_WINDOW,
      tokens: 700,
    });

    expect(await tiles(fx.member, "admin")).toMatchObject({
      promoted: 1,
      tokens: 700,
    });
  });
});
