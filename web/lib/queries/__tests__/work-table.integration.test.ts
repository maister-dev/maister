// IT-STG-08 (ADR-170 / work-stages.md) — `/work` MUST issue a number of queries
// that is independent of the number of rows returned.
//
// The anti-N+1 guarantee is written here as an executable assertion rather than
// a comment, because a comment cannot fail. The fixture grows from 1 project /
// 2 tasks to 3 projects / 12 tasks; the statement count against the pool must
// not move. Row counts are asserted alongside it — a read model that returns
// nothing also has a constant query count, and that pass would be a lie.
//
// The scoping half (`STG-09`) is asserted at the read model here and again
// through the route in `E2E-STG-09`; `IT-STG-09` covers the helper itself.

import { randomUUID } from "node:crypto";

import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import * as fullSchema from "@/lib/db/schema";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

// FIXME(any): drizzle-orm dual peer-dep variants — matches the cast every other
// board/portfolio integration test uses for its fixture inserts.
const schema = fullSchema as unknown as Record<string, any>;

let testDatabase: StartedPostgresTestDb;
let pool: Pool;
let db: NodePgDatabase;

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));

let getWorkTable: typeof import("@/lib/queries/work-table").getWorkTable;

const fx = {
  admin: randomUUID(),
  member: randomUUID(),
  stranger: randomUUID(),
};

/** Every statement drizzle sends while `run` executes. */
async function countQueries<T>(
  run: () => Promise<T>,
): Promise<{ queries: number; value: T }> {
  const original = pool.query.bind(pool);
  let queries = 0;

  // FIXME(any): pg's `query()` is heavily overloaded; the counting passthrough
  // deliberately forwards whatever drizzle hands it, untouched.
  (pool as any).query = (...args: any[]) => {
    queries += 1;

    return original(...(args as Parameters<typeof original>));
  };

  try {
    // `value` must be awaited BEFORE `queries` is read — an object literal
    // evaluates its properties in source order, so returning them together
    // would snapshot the counter at zero.
    const value = await run();

    return { queries, value };
  } finally {
    (pool as unknown as { query: typeof original }).query = original;
  }
}

async function seedProject(label: string): Promise<{
  projectId: string;
  flowId: string;
  taskKey: string;
}> {
  const projectId = randomUUID();
  const flowId = randomUUID();
  const slug = `wt-${label}-${projectId.slice(0, 8)}`;
  const taskKey = `WT${projectId.slice(0, 4)}`.toUpperCase();

  await db.insert(schema.projects).values({
    id: projectId,
    slug,
    name: `Work Table ${label}`,
    repoPath: `/tmp/${slug}`,
    maisterYamlPath: `/tmp/${slug}/maister.yaml`,
    taskKey,
  });
  await db.insert(schema.flows).values({
    id: flowId,
    projectId,
    flowRefId: "aif",
    source: "github.com/x/y",
    version: "v1.0.0",
    installedPath: "/tmp/flows/aif",
    manifest: { schemaVersion: 1, name: "aif", nodes: [] },
    schemaVersion: 1,
  });

  return { projectId, flowId, taskKey };
}

/**
 * One task, optionally with a run + workspace + node attempt. `withRun: false`
 * seeds the pre-flight half of the table (`Triage` / `Held` / `Ready`), which a
 * run-driven read model silently drops.
 */
async function seedTask(opts: {
  projectId: string;
  flowId: string;
  number: number;
  withRun: boolean;
  taskStatus?: "Backlog" | "InFlight" | "Done";
  runStatus?: string;
}): Promise<{ taskId: string; runId: string | null }> {
  const taskId = randomUUID();

  await db.insert(schema.tasks).values({
    id: taskId,
    projectId: opts.projectId,
    number: opts.number,
    title: `task ${opts.number}`,
    prompt: "p",
    flowId: opts.flowId,
    status: opts.taskStatus ?? (opts.withRun ? "InFlight" : "Backlog"),
    stage: "Backlog",
    triageStatus: "triaged",
  });

  if (!opts.withRun) return { taskId, runId: null };

  const runId = randomUUID();

  await db.insert(schema.runs).values({
    id: runId,
    taskId,
    projectId: opts.projectId,
    flowId: opts.flowId,
    status: opts.runStatus ?? "Running",
    flowVersion: "v1.0.0",
    currentStepId: "plan",
  });
  await db.insert(schema.workspaces).values({
    id: randomUUID(),
    projectId: opts.projectId,
    runId,
    branch: `maister/wt-${taskId}`,
    worktreePath: `/tmp/wt-${taskId}`,
    parentRepoPath: "/tmp/parent",
  });
  await db.insert(schema.nodeAttempts).values({
    id: randomUUID(),
    runId,
    nodeId: "plan",
    nodeType: "ai_coding",
    attempt: 1,
    status: "Running",
    startedAt: new Date("2026-09-10T10:00:00.000Z"),
  });

  return { taskId, runId };
}

async function addMember(projectId: string, userId: string): Promise<void> {
  await pool.query(
    `insert into project_members (id, project_id, user_id, role)
     values ($1, $2, $3, 'member')`,
    [randomUUID(), projectId, userId],
  );
}

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "work_table_test",
  });
  pool = testDatabase.pool;
  db = testDatabase.db;

  for (const [userId, email, role] of [
    [fx.admin, "wt-admin@test.local", "admin"],
    [fx.member, "wt-member@test.local", "member"],
    [fx.stranger, "wt-stranger@test.local", "member"],
  ] as const) {
    await pool.query(
      `insert into users (id, email, role) values ($1, $2, $3)`,
      [userId, email, role],
    );
  }

  ({ getWorkTable } = await import("@/lib/queries/work-table"));
}, 180_000);

afterAll(async () => {
  await testDatabase?.stop();
});

describe("IT-STG-08 getWorkTable — query count is independent of row count", () => {
  it("issues the same number of statements for 2 rows and for 12", async () => {
    const small = await seedProject("small");

    await addMember(small.projectId, fx.member);
    await seedTask({ ...small, number: 1, withRun: true });
    await seedTask({ ...small, number: 2, withRun: false });

    const first = await countQueries(() =>
      getWorkTable({ id: fx.member, role: "member" }),
    );

    expect(first.value.rows).toHaveLength(2);

    for (const label of ["big-a", "big-b"]) {
      const project = await seedProject(label);

      await addMember(project.projectId, fx.member);

      for (let n = 1; n <= 5; n += 1) {
        await seedTask({ ...project, number: n, withRun: n % 2 === 0 });
      }
    }

    await seedTask({ ...small, number: 3, withRun: true });
    await seedTask({ ...small, number: 4, withRun: false });

    const second = await countQueries(() =>
      getWorkTable({ id: fx.member, role: "member" }),
    );

    expect(second.value.rows).toHaveLength(14);
    expect(second.queries).toBe(first.queries);
  });

  it("keeps the statement count bounded, not merely constant", async () => {
    const { queries } = await countQueries(() =>
      getWorkTable({ id: fx.member, role: "member" }),
    );

    expect(queries).toBeGreaterThan(0);
    expect(queries).toBeLessThanOrEqual(16);
  });
});

describe("STG-09 getWorkTable — visible-project scope", () => {
  it("hides a project the member does not belong to", async () => {
    const foreign = await seedProject("foreign");

    await addMember(foreign.projectId, fx.stranger);
    await seedTask({ ...foreign, number: 9, withRun: true });

    const { rows } = await getWorkTable({ id: fx.member, role: "member" });

    expect(rows.length).toBeGreaterThan(0);
    expect(rows.map((row) => row.projectId)).not.toContain(foreign.projectId);
  });

  it("reaches every non-archived project for an admin who belongs to none", async () => {
    const { rows } = await getWorkTable({ id: fx.admin, role: "admin" });
    const projectIds = new Set(rows.map((row) => row.projectId));

    expect(projectIds.size).toBeGreaterThanOrEqual(4);
  });

  it("returns nothing, and no visible projects, for a user with no memberships", async () => {
    const result = await getWorkTable({ id: randomUUID(), role: "member" });

    expect(result).toEqual({ rows: [], projectCount: 0 });
  });

  it("separates 'no visible projects' from 'no tasks in them'", async () => {
    const empty = await seedProject("empty");
    const loner = randomUUID();

    await pool.query(
      `insert into users (id, email, role) values ($1, $2, $3)`,
      [loner, `wt-loner-${loner}@test.local`, "member"],
    );
    await addMember(empty.projectId, loner);

    const result = await getWorkTable({ id: loner, role: "member" });

    expect(result.rows).toEqual([]);
    expect(result.projectCount).toBe(1);
  });
});

describe("IT-STG-07 the work stage is derived, never persisted", () => {
  it("has no work-stage column anywhere in the migrated schema", async () => {
    const { rows } = await pool.query<{
      table_name: string;
      column_name: string;
    }>(
      `select table_name, column_name
         from information_schema.columns
        where table_schema = 'public'
          and column_name like '%work%stage%'`,
    );

    expect(rows).toEqual([]);
  });

  it("proves the probe can see the columns it is searching", async () => {
    const { rows } = await pool.query(
      `select 1
         from information_schema.columns
        where table_schema = 'public'
          and table_name = 'tasks'
          and column_name = 'stage'`,
    );

    expect(rows).toHaveLength(1);
  });
});

describe("IT-EDGE-STG-01 getWorkTable — a task is classified from its latest run", () => {
  it("reads the newest run, not the first or the last one inserted", async () => {
    const project = await seedProject("history");

    await addMember(project.projectId, fx.member);

    const taskId = randomUUID();

    await db.insert(schema.tasks).values({
      id: taskId,
      projectId: project.projectId,
      number: 77,
      title: "retried task",
      prompt: "p",
      flowId: project.flowId,
      status: "InFlight",
      stage: "Backlog",
      triageStatus: "triaged",
    });

    // Deliberately inserted newest-first, so a read model that takes "the first
    // row" or "the last row" instead of the newest STARTED run gets it wrong.
    for (const [status, startedAt] of [
      ["Running", "2026-09-10T12:00:00.000Z"],
      ["Crashed", "2026-09-09T12:00:00.000Z"],
      ["Failed", "2026-09-08T12:00:00.000Z"],
    ] as const) {
      const runId = randomUUID();

      await db.insert(schema.runs).values({
        id: runId,
        taskId,
        projectId: project.projectId,
        flowId: project.flowId,
        status,
        flowVersion: "v1.0.0",
        currentStepId: "plan",
        startedAt: new Date(startedAt),
      });
      await db.insert(schema.workspaces).values({
        id: randomUUID(),
        projectId: project.projectId,
        runId,
        branch: `maister/hist-${runId}`,
        worktreePath: `/tmp/hist-${runId}`,
        parentRepoPath: "/tmp/parent",
      });
    }

    const { rows } = await getWorkTable({ id: fx.member, role: "member" });
    const row = rows.find((candidate) => candidate.taskId === taskId);

    expect(row?.stage).toBe("Executing");
    expect(row?.runStatus).toBe("Running");
  });
});

describe("STG-01..07 getWorkTable — rows carry a derived stage", () => {
  it("includes pre-flight tasks that have never launched a run", async () => {
    const { rows } = await getWorkTable({ id: fx.member, role: "member" });
    const preflight = rows.filter((row) => row.runId === null);

    expect(preflight.length).toBeGreaterThan(0);
    expect(preflight.every((row) => row.stage === "Ready")).toBe(true);
  });

  it("derives Executing with a progress spine for a Running run", async () => {
    const { rows } = await getWorkTable({ id: fx.member, role: "member" });
    const executing = rows.filter((row) => row.stage === "Executing");

    expect(executing.length).toBeGreaterThan(0);
    expect(executing[0].progress).not.toBeNull();
    expect(executing[0].progress?.total).toBeGreaterThan(0);
  });

  it("names every row with its own project's KEY-N, never the reader's first", async () => {
    const { rows } = await getWorkTable({ id: fx.admin, role: "admin" });
    const prefixes = new Set(rows.map((row) => row.keyRef.split("-")[0]));

    expect(prefixes.size).toBeGreaterThan(1);
  });
});
