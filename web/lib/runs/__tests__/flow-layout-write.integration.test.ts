import { randomUUID } from "node:crypto";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// FIXME(any): drizzle-orm dual peer-dep variants — runtime works, cast silences
// the type-only clash.
import * as fullSchema from "@/lib/db/schema";
import {
  testPlatformRunnerRow,
  testRunnerSnapshot,
} from "@/lib/__tests__/runner-fixtures";

const schema = fullSchema as unknown as Record<string, any>;

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;

let upsertNodeLayout: typeof import("@/lib/runs/flow-layout-write").upsertNodeLayout;
let getFlowLayout: typeof import("@/lib/queries/flow-layout").getFlowLayout;

// A linear manifest whose compiled graph contains node "plan".
const manifest = {
  schemaVersion: 1,
  name: "demo",
  steps: [
    { id: "plan", type: "agent", mode: "new-session", prompt: "/aif-plan" },
    { id: "review", type: "human", form_schema: "./r.json" },
  ],
};

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("flow_layout_test")
    .withUsername("test")
    .withPassword("test")
    .start();

  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);

  await migrate(db, { migrationsFolder: "./lib/db/migrations" });

  ({ upsertNodeLayout } = await import("@/lib/runs/flow-layout-write"));
  ({ getFlowLayout } = await import("@/lib/queries/flow-layout"));
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

async function countWhere(
  table: string,
  col: string,
  value: string,
): Promise<number> {
  const result = await db.execute(
    sql`select count(*)::int as c from ${sql.identifier(table)} where ${sql.identifier(col)} = ${value}`,
  );

  return Number((result.rows[0] as { c: number }).c);
}

interface SeededProject {
  projectId: string;
  flowId: string;
  runId: string;
  userId: string;
  flowRevisionId: string;
}

async function seedProjectWithFlowRun(): Promise<SeededProject> {
  const projectId = randomUUID();
  const executorId = randomUUID();
  const flowId = randomUUID();
  const flowRevisionId = randomUUID();
  const taskId = randomUUID();
  const runId = randomUUID();
  const workspaceId = randomUUID();
  const userId = randomUUID();
  const slug = `proj-${projectId.slice(0, 8)}`;

  await db.insert(schema.users).values({
    id: userId,
    email: `u-${userId.slice(0, 8)}@test.com`,
    role: "member",
    accountStatus: "active",
  });

  await db.insert(schema.projects).values({
    id: projectId,
    slug,
    name: slug,
    repoPath: `/tmp/${slug}`,
    maisterYamlPath: `/tmp/${slug}/maister.yaml`,
  });

  await db
    .insert(schema.platformAcpRunners)
    .values(testPlatformRunnerRow(executorId, "claude"));

  await db.insert(schema.flowRevisions).values({
    id: flowRevisionId,
    flowRefId: "demo",
    source: "github.com/x/y",
    versionLabel: "v1.0.0",
    resolvedRevision: randomUUID()
      .replace(/-/g, "")
      .padEnd(40, "0")
      .slice(0, 40),
    manifestDigest: `sha256:${randomUUID()}`,
    manifest,
    schemaVersion: 1,
    installedPath: "/tmp/flows/demo@rev",
  });

  await db.insert(schema.flows).values({
    id: flowId,
    projectId,
    flowRefId: "demo",
    source: "github.com/x/y",
    version: "v1.0.0",
    installedPath: "/tmp/flows/demo",
    manifest,
    schemaVersion: 1,
    enabledRevisionId: flowRevisionId,
  });

  await db.insert(schema.tasks).values({
    id: taskId,
    projectId,
    title: "t",
    prompt: "p",
    flowId,
  });

  await db.insert(schema.runs).values({
    id: runId,
    taskId,
    projectId,
    flowId,
    flowRevisionId,
    runnerId: executorId,
    capabilityAgent: "claude",
    runnerSnapshot: testRunnerSnapshot(executorId),
    status: "Running",
    flowVersion: "v1.0.0",
  });

  await db.insert(schema.workspaces).values({
    id: workspaceId,
    runId,
    projectId,
    branch: "feature/test",
    worktreePath: `/tmp/wt-${workspaceId.slice(0, 8)}`,
    parentRepoPath: `/tmp/${slug}`,
  });

  return { projectId, flowId, runId, userId, flowRevisionId };
}

describe("upsertNodeLayout (integration)", () => {
  it("writes one row, then a second upsert on the same (flow,node) updates it", async () => {
    const { flowId, runId, userId } = await seedProjectWithFlowRun();

    await upsertNodeLayout({
      runId,
      nodeId: "plan",
      x: 10,
      y: 20,
      userId,
      db: db as never,
    });

    expect(await countWhere("flow_graph_layouts", "flow_id", flowId)).toBe(1);

    await upsertNodeLayout({
      runId,
      nodeId: "plan",
      x: 99,
      y: 88,
      userId,
      db: db as never,
    });

    expect(await countWhere("flow_graph_layouts", "flow_id", flowId)).toBe(1);

    const map = await getFlowLayout(flowId, db as never);

    expect(map.plan).toEqual({ x: 99, y: 88 });
  });

  it("reads back the upserted position via getFlowLayout", async () => {
    const { flowId, runId, userId } = await seedProjectWithFlowRun();

    await upsertNodeLayout({
      runId,
      nodeId: "plan",
      x: 5,
      y: 6,
      userId,
      db: db as never,
    });

    const map = await getFlowLayout(flowId, db as never);

    expect(map).toEqual({ plan: { x: 5, y: 6 } });
  });

  it("isolates layout writes across projects (only A's flow_id row is touched)", async () => {
    const a = await seedProjectWithFlowRun();
    const b = await seedProjectWithFlowRun();

    await upsertNodeLayout({
      runId: a.runId,
      nodeId: "plan",
      x: 1,
      y: 2,
      userId: a.userId,
      db: db as never,
    });

    expect(await countWhere("flow_graph_layouts", "flow_id", a.flowId)).toBe(1);
    expect(await countWhere("flow_graph_layouts", "flow_id", b.flowId)).toBe(0);

    const bMap = await getFlowLayout(b.flowId, db as never);

    expect(bMap).toEqual({});
  });

  it("derives flow_id from the run (naming B's run writes B's flow_id, never A's)", async () => {
    const a = await seedProjectWithFlowRun();
    const b = await seedProjectWithFlowRun();

    // flow_id is resolved server-side from the run, so a write naming B's run
    // lands on B's flow_id and can never bleed into A. (The route's
    // requireProjectAction(run.projectId) is the access barrier; this asserts
    // the structural data-layer invariant the keying relies on.)
    await upsertNodeLayout({
      runId: b.runId,
      nodeId: "plan",
      x: 3,
      y: 4,
      userId: b.userId,
      db: db as never,
    });

    expect(await countWhere("flow_graph_layouts", "flow_id", b.flowId)).toBe(1);
    expect(await countWhere("flow_graph_layouts", "flow_id", a.flowId)).toBe(0);
    expect(await getFlowLayout(b.flowId, db as never)).toEqual({
      plan: { x: 3, y: 4 },
    });
  });

  it("survives M19 revision GC: deleting flow_revisions keeps the layout row", async () => {
    const { flowId, runId, userId, flowRevisionId } =
      await seedProjectWithFlowRun();

    await upsertNodeLayout({
      runId,
      nodeId: "plan",
      x: 7,
      y: 8,
      userId,
      db: db as never,
    });

    await db.execute(
      sql`delete from flow_revisions where id = ${flowRevisionId}`,
    );

    expect(await countWhere("flow_graph_layouts", "flow_id", flowId)).toBe(1);
  });

  it("cascade-deletes the layout row when the flows row is deleted", async () => {
    const { flowId, runId, userId } = await seedProjectWithFlowRun();

    await upsertNodeLayout({
      runId,
      nodeId: "plan",
      x: 7,
      y: 8,
      userId,
      db: db as never,
    });

    // tasks.flow_id is a restricting (NO ACTION) FK to flows.id, so the parent
    // delete is blocked until the referencing task is gone; runs.flow_id is
    // CASCADE and is removed automatically. Clearing tasks lets the delete
    // reach flow_graph_layouts and exercise its ON DELETE CASCADE.
    await db.execute(sql.raw(`delete from tasks where flow_id = '${flowId}'`));
    await db.execute(sql.raw(`delete from flows where id = '${flowId}'`));

    expect(await countWhere("flow_graph_layouts", "flow_id", flowId)).toBe(0);
  });
});
