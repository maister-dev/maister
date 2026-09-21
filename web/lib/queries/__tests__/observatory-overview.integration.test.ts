// ADR-178 D2/D3/D4: the overview read model on real Postgres.
//
// Everything this read model claims is a database fact — which runs fall in the
// window, which task counts as "in work", which workspace row decides a bucket,
// whether the project-less group is visible, and whether the query count stays
// fixed as the project list grows. None of that can be proven in the unit lane.

import { randomUUID } from "node:crypto";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import * as schema from "@/lib/db/schema";
import { getObservatoryOverview } from "@/lib/queries/observatory-overview";
import { withQueryCount } from "@/test-support/query-count";

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase<typeof schema>;
let alpha: ProjectFixture;
let beta: ProjectFixture;

interface ProjectFixture {
  id: string;
  slug: string;
  name: string;
}

const NOW = new Date("2026-06-05T12:00:00.000Z");
// The day-aligned 30-day preset for NOW.
const SINCE = new Date("2026-05-07T00:00:00.000Z");
const UNTIL = new Date("2026-06-06T00:00:00.000Z");

function at(iso: string): Date {
  return new Date(iso);
}

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("observatory_overview")
    .withUsername("test")
    .withPassword("test")
    .start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool, { schema });
  await migrate(db, { migrationsFolder: "./lib/db/migrations" });
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

beforeEach(async () => {
  await db.delete(schema.workspaces);
  await db.delete(schema.runs);
  await db.delete(schema.tasks);
  await db.delete(schema.flows);
  await db.delete(schema.projects);

  alpha = await seedProject("alpha");
  beta = await seedProject("beta");
});

describe("getObservatoryOverview (ADR-178)", () => {
  it("counts runs by kind and by outcome bucket, per project and in the totals", async () => {
    await seedRun({ project: alpha, kind: "flow", status: "Running" });
    await seedRun({ project: alpha, kind: "flow", status: "Pending" });
    await seedRun({
      project: alpha,
      kind: "flow",
      status: "Done",
      workspace: { promotionState: "done", promotionMode: "local_merge" },
    });
    await seedRun({
      project: alpha,
      kind: "flow",
      status: "Done",
      workspace: {
        promotionState: "done",
        promotionMode: "pull_request",
        prState: "open",
      },
    });
    await seedRun({ project: alpha, kind: "scratch", status: "Done" });
    await seedRun({ project: beta, kind: "agent", status: "Failed" });

    const table = await overview();
    const alphaRow = rowFor(table, alpha.slug);
    const betaRow = rowFor(table, beta.slug);

    expect(alphaRow.counts.runs).toEqual({ flow: 4, scratch: 1, agent: 0 });
    expect(bucketsOf(alphaRow)).toEqual({
      Queued: 1,
      Executing: 1,
      Delivered: 1,
      PrOpen: 1,
      // The scratch run has no workspace row at all.
      ResultOnly: 1,
    });
    expect(betaRow.counts.runs).toEqual({ flow: 0, scratch: 0, agent: 1 });
    expect(bucketsOf(betaRow)).toEqual({ Failed: 1 });

    expect(table.totals.runs).toEqual({ flow: 4, scratch: 1, agent: 1 });
    expect(table.totals.buckets.Delivered).toBe(1);
    expect(sumCounts(table)).toBe(6);
  });

  it("bounds runs by [since, until) on started_at", async () => {
    await seedRun({
      project: alpha,
      kind: "flow",
      status: "Done",
      startedAt: at("2026-05-06T23:59:59.999Z"),
    });
    await seedRun({
      project: alpha,
      kind: "flow",
      status: "Done",
      startedAt: SINCE,
    });
    await seedRun({
      project: alpha,
      kind: "flow",
      status: "Done",
      startedAt: at("2026-06-05T23:59:59.999Z"),
    });
    await seedRun({
      project: alpha,
      kind: "flow",
      status: "Done",
      startedAt: UNTIL,
    });

    const table = await overview();

    // `since` is inclusive, `until` exclusive: the two middle runs only.
    expect(rowFor(table, alpha.slug).counts.runs.flow).toBe(2);
  });

  it("counts tasks by overlap and first launch, ignoring non-flow runs", async () => {
    // Launched before the window, still in Review: in work, not new.
    const older = await seedTask(alpha);

    await seedRun({
      project: alpha,
      kind: "flow",
      status: "Review",
      taskId: older,
      startedAt: at("2026-04-20T09:00:00.000Z"),
      endedAt: at("2026-04-25T09:00:00.000Z"),
    });

    // First launched inside the window: both.
    const fresh = await seedTask(alpha);

    await seedRun({
      project: alpha,
      kind: "flow",
      status: "Running",
      taskId: fresh,
      startedAt: at("2026-05-20T09:00:00.000Z"),
    });

    // Settled before the window: excluded.
    const settled = await seedTask(alpha);

    await seedRun({
      project: alpha,
      kind: "flow",
      status: "Done",
      taskId: settled,
      startedAt: at("2026-03-01T09:00:00.000Z"),
      endedAt: at("2026-03-05T09:00:00.000Z"),
    });

    // Relaunched inside the window after an earlier failure: in work, not new.
    const relaunched = await seedTask(alpha);

    await seedRun({
      project: alpha,
      kind: "flow",
      status: "Failed",
      taskId: relaunched,
      startedAt: at("2026-04-10T09:00:00.000Z"),
      endedAt: at("2026-04-12T09:00:00.000Z"),
    });
    await seedRun({
      project: alpha,
      kind: "flow",
      status: "Done",
      taskId: relaunched,
      startedAt: at("2026-05-21T09:00:00.000Z"),
      endedAt: at("2026-05-30T09:00:00.000Z"),
    });

    // A task whose only run is an agent run never reaches the task columns.
    const agentOnly = await seedTask(alpha);

    await seedRun({
      project: alpha,
      kind: "agent",
      status: "Done",
      taskId: agentOnly,
      startedAt: at("2026-05-22T09:00:00.000Z"),
    });

    const row = rowFor(await overview(), alpha.slug);

    expect(row.counts.tasksInWork).toBe(3);
    expect(row.counts.tasksStarted).toBe(1);
  });

  // ADR-178 D2 + D3, one rule. Before this, "settled" for a task was a second,
  // hand-kept status list that said Review/Crashed are NEVER settled — so one
  // crashed run nobody ever discarded kept its task in "in work" in every
  // window, forever. D3 already calls a removed-workspace Review/Crashed run
  // `Abandoned`; both axes now ask the same classifier.
  it("closes a task's interval once its run's workspace is removed", async () => {
    const parked = await seedTask(alpha);

    // Crashed long before the window, worktree still present: the run owes a
    // recover/discard decision, so the task IS still in work.
    await seedRun({
      project: alpha,
      kind: "flow",
      status: "Crashed",
      taskId: parked,
      startedAt: at("2026-01-10T09:00:00.000Z"),
      endedAt: at("2026-01-11T09:00:00.000Z"),
      workspace: { promotionState: "none" },
    });

    expect(rowFor(await overview(), alpha.slug).counts.tasksInWork).toBe(1);

    // Discarded: the same run now counts in the Abandoned column, and the task
    // stops being in work in a window its run never reached.
    const discarded = await seedTask(alpha);

    await seedRun({
      project: alpha,
      kind: "flow",
      status: "Crashed",
      taskId: discarded,
      startedAt: at("2026-01-10T09:00:00.000Z"),
      endedAt: at("2026-01-11T09:00:00.000Z"),
      workspace: { promotionState: "none", removed: true },
    });

    const row = rowFor(await overview(), alpha.slug);

    expect(row.counts.tasksInWork).toBe(1);
    expect(row.counts.tasksStarted).toBe(0);
  });

  // `[started_at, settled_at)` overlaps `[since, until)` when
  // `settled_at > since` — strictly. A run that settled AT the boundary belongs
  // to the previous period, and `>=` let it count in both.
  it("excludes a run that settled exactly at `since`", async () => {
    const onBoundary = await seedTask(alpha);

    await seedRun({
      project: alpha,
      kind: "flow",
      status: "Done",
      taskId: onBoundary,
      startedAt: at("2026-04-01T09:00:00.000Z"),
      endedAt: SINCE,
    });

    expect(rowFor(await overview(), alpha.slug).counts.tasksInWork).toBe(0);

    const justInside = await seedTask(alpha);

    await seedRun({
      project: alpha,
      kind: "flow",
      status: "Done",
      taskId: justInside,
      startedAt: at("2026-04-01T09:00:00.000Z"),
      endedAt: new Date(SINCE.getTime() + 1),
    });

    expect(rowFor(await overview(), alpha.slug).counts.tasksInWork).toBe(1);
  });

  it("keeps the task columns flow-based when the run kind narrows to scratch", async () => {
    const task = await seedTask(alpha);

    await seedRun({
      project: alpha,
      kind: "flow",
      status: "Running",
      taskId: task,
      startedAt: at("2026-05-20T09:00:00.000Z"),
    });
    await seedRun({ project: alpha, kind: "scratch", status: "Done" });

    const row = rowFor(await overview({ runKind: "scratch" }), alpha.slug);

    expect(row.counts.runs).toEqual({ flow: 0, scratch: 1, agent: 0 });
    expect(row.counts.tasksInWork).toBe(1);
    expect(row.counts.tasksStarted).toBe(1);
  });

  it("classifies by the run's NEWEST workspaces row", async () => {
    const runId = await seedRun({
      project: alpha,
      kind: "flow",
      status: "Review",
      workspace: { promotionState: "done", promotionMode: "local_merge" },
    });

    await insertWorkspace(runId, alpha.id, {
      promotionState: "none",
      removed: true,
      createdAt: new Date(NOW.getTime() + 60_000),
    });

    expect(bucketsOf(rowFor(await overview(), alpha.slug))).toEqual({
      Abandoned: 1,
    });
  });

  it("reads the project-less Platform group only for a global admin", async () => {
    await seedRun({ project: null, kind: "scratch", status: "Running" });
    await seedRun({ project: alpha, kind: "flow", status: "Running" });

    const asAdmin = await overview({ includePlatform: true });

    expect(asAdmin.platform).not.toBeNull();
    expect(asAdmin.platform?.counts.runs).toEqual({
      flow: 0,
      scratch: 1,
      agent: 0,
    });
    // Task cells stay empty for the platform row.
    expect(asAdmin.platform?.counts.tasksInWork).toBe(0);
    expect(asAdmin.platform?.counts.tasksStarted).toBe(0);
    expect(asAdmin.totals.runs.scratch).toBe(1);

    const asMember = await overview({ includePlatform: false });

    expect(asMember.platform).toBeNull();
    expect(asMember.totals.runs.scratch).toBe(0);
  });

  it("omits the Platform row when the admin's window holds no project-less run", async () => {
    await seedRun({ project: alpha, kind: "flow", status: "Running" });

    expect((await overview({ includePlatform: true })).platform).toBeNull();
  });

  it("marks the table volatile only while an in-flight run is present", async () => {
    await seedRun({
      project: alpha,
      kind: "flow",
      status: "Done",
      workspace: { promotionState: "done", promotionMode: "local_merge" },
    });

    expect((await overview()).volatile).toBe(false);

    await seedRun({ project: alpha, kind: "flow", status: "NeedsInput" });

    expect((await overview()).volatile).toBe(true);
  });

  it("breaks a project row down by flow ref and by flow-less run kind", async () => {
    const bugfix = await seedFlow(alpha, "bugfix");
    const specKit = await seedFlow(alpha, "spec-kit");

    await seedRun({
      project: alpha,
      kind: "flow",
      status: "Running",
      flowId: bugfix,
    });
    await seedRun({
      project: alpha,
      kind: "flow",
      status: "Failed",
      flowId: bugfix,
    });
    await seedRun({
      project: alpha,
      kind: "flow",
      status: "Running",
      flowId: specKit,
    });
    await seedRun({ project: alpha, kind: "scratch", status: "Done" });

    const table = await overview({
      scope: [alpha],
      includeBreakdown: true,
    });

    expect(
      table.subRows.map((row) => [row.key, row.counts.runs, bucketsOf(row)]),
    ).toEqual([
      [
        "flow:bugfix",
        { flow: 2, scratch: 0, agent: 0 },
        { Executing: 1, Failed: 1 },
      ],
      ["flow:spec-kit", { flow: 1, scratch: 0, agent: 0 }, { Executing: 1 }],
      ["kind:scratch", { flow: 0, scratch: 1, agent: 0 }, { ResultOnly: 1 }],
    ]);
  });

  it("returns an empty table for an empty scope rather than an error", async () => {
    const table = await getObservatoryOverview(db, [], {
      since: SINCE,
      until: UNTIL,
      runKind: "all",
      includePlatform: false,
      includeBreakdown: false,
    });

    expect(table.rows).toEqual([]);
    expect(table.platform).toBeNull();
    expect(table.volatile).toBe(false);
    expect(sumCounts(table)).toBe(0);
  });

  it("issues the same fixed number of queries for one project and for two", async () => {
    await seedRun({ project: alpha, kind: "flow", status: "Running" });
    await seedRun({ project: beta, kind: "flow", status: "Running" });

    const one = withQueryCount(db);

    await getObservatoryOverview(one.db, [alpha], {
      since: SINCE,
      until: UNTIL,
      runKind: "all",
      includePlatform: false,
      includeBreakdown: false,
    });

    const two = withQueryCount(db);

    await getObservatoryOverview(two.db, [alpha, beta], {
      since: SINCE,
      until: UNTIL,
      runKind: "all",
      includePlatform: false,
      includeBreakdown: false,
    });

    expect(one.count()).toBe(two.count());
    expect(one.count()).toBe(2);
  });
});

async function overview(
  options: {
    scope?: ProjectFixture[];
    runKind?: "all" | "flow" | "scratch" | "agent";
    includePlatform?: boolean;
    includeBreakdown?: boolean;
  } = {},
) {
  return getObservatoryOverview(db, options.scope ?? [alpha, beta], {
    since: SINCE,
    until: UNTIL,
    runKind: options.runKind ?? "all",
    includePlatform: options.includePlatform ?? false,
    includeBreakdown: options.includeBreakdown ?? false,
  });
}

function rowFor(
  table: Awaited<ReturnType<typeof getObservatoryOverview>>,
  slug: string,
) {
  const row = table.rows.find(
    (candidate) =>
      candidate.identity.kind === "project" &&
      candidate.identity.projectSlug === slug,
  );

  if (!row) throw new Error(`no overview row for ${slug}`);

  return row;
}

/** Non-zero buckets only — an assertion over ten zeroes reads as noise. */
function bucketsOf(row: {
  counts: { buckets: Record<string, number> };
}): Record<string, number> {
  return Object.fromEntries(
    Object.entries(row.counts.buckets).filter(([, count]) => count > 0),
  );
}

function sumCounts(
  table: Awaited<ReturnType<typeof getObservatoryOverview>>,
): number {
  return Object.values(table.totals.runs).reduce<number>(
    (total, value) => total + value,
    0,
  );
}

async function seedProject(prefix: string): Promise<ProjectFixture> {
  const id = randomUUID();
  const fixture = {
    id,
    slug: `${prefix}-${id.slice(0, 8)}`,
    name: `${prefix} project`,
  };

  await db.insert(schema.projects).values({
    id,
    taskKey: `K${id.slice(0, 6)}`.toUpperCase(),
    slug: fixture.slug,
    name: fixture.name,
    repoPath: `/repos/${id}`,
    maisterYamlPath: `/repos/${id}/maister.yaml`,
  });

  return fixture;
}

async function seedFlow(
  project: ProjectFixture,
  flowRefId: string,
): Promise<string> {
  const id = randomUUID();

  await db.insert(schema.flows).values({
    id,
    projectId: project.id,
    flowRefId,
    source: `https://example.invalid/${flowRefId}`,
    version: "v1.0.0",
    installedPath: `/flows/${flowRefId}`,
    manifest: { schemaVersion: 1, name: flowRefId, nodes: [] },
    schemaVersion: 1,
  });

  return id;
}

async function seedTask(project: ProjectFixture): Promise<string> {
  const id = randomUUID();

  await db.insert(schema.tasks).values({
    id,
    projectId: project.id,
    number: Math.floor(Math.random() * 1_000_000),
    title: `Task ${id.slice(0, 6)}`,
    prompt: "do the thing",
    status: "InFlight",
  });

  return id;
}

async function seedRun(input: {
  project: ProjectFixture | null;
  kind: schema.RunKind;
  status: schema.RunStatus;
  startedAt?: Date;
  endedAt?: Date | null;
  taskId?: string;
  flowId?: string;
  workspace?: WorkspaceInput;
}): Promise<string> {
  const runId = randomUUID();
  const startedAt = input.startedAt ?? new Date("2026-05-20T09:00:00.000Z");

  await db.insert(schema.runs).values({
    id: runId,
    projectId: input.project?.id ?? null,
    taskId: input.taskId ?? null,
    flowId: input.flowId ?? null,
    runKind: input.kind,
    status: input.status,
    flowVersion: "v1.0.0",
    startedAt,
    endedAt:
      input.endedAt === undefined
        ? input.status === "Pending" ||
          input.status === "Running" ||
          input.status === "NeedsInput"
          ? null
          : startedAt
        : input.endedAt,
  });

  if (input.workspace && input.project) {
    await insertWorkspace(runId, input.project.id, input.workspace);
  }

  return runId;
}

interface WorkspaceInput {
  promotionState: string;
  promotionMode?: string;
  prState?: "open" | "merged" | "closed";
  removed?: boolean;
  createdAt?: Date;
}

async function insertWorkspace(
  runId: string,
  projectId: string,
  spec: WorkspaceInput,
): Promise<void> {
  const id = randomUUID();

  await db.insert(schema.workspaces).values({
    id,
    runId,
    projectId,
    branch: `maister/${id.slice(0, 8)}`,
    worktreePath: `/worktrees/${id}`,
    parentRepoPath: `/repos/${projectId}`,
    createdAt: spec.createdAt ?? NOW,
    promotionState: spec.promotionState,
    promotionMode: spec.promotionMode ?? null,
    prState: spec.prState ?? null,
    removedAt: spec.removed ? NOW : null,
    removalKind: spec.removed ? "drop" : null,
  });
}
