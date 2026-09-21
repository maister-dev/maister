// M42 (ADR-114) regression guard for the /runs list reader. The runner mirror
// columns (capability_agent, runner_snapshot, …) were dropped from `runs` and
// moved to `run_sessions`. `listRunsPage` is raw SQL, so a mocked-DB unit test
// can't catch a stale `r.capability_agent` reference — it only fails against the
// real post-drop schema. This runs the query against a migrated Postgres and
// asserts the runner fields resolve from the active run_session.
import type { RunOutcomeBucket } from "@/lib/runs/outcome-bucket";

import { randomUUID } from "node:crypto";

import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { testRunnerSnapshot } from "@/lib/__tests__/runner-fixtures";
import * as schemaModule from "@/lib/db/schema";
import { getObservatoryOverview } from "@/lib/queries/observatory-overview";
import { listRunsPage, type RunsListFilters } from "@/lib/queries/runs-list";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

const schema = schemaModule as unknown as Record<string, any>;

let testDatabase: StartedPostgresTestDb;
let db: NodePgDatabase;

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));

const admin = { id: randomUUID(), role: "admin" as const };

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "runs_list_test",
  });

  db = testDatabase.db;
}, 180_000);

afterAll(async () => {
  await testDatabase?.stop();
});

function filters(overrides: Partial<RunsListFilters> = {}): RunsListFilters {
  return { page: 1, ...overrides };
}

async function seedRunWithSession(agent: "claude" | "codex"): Promise<string> {
  const projectId = randomUUID();
  const slug = `proj-${projectId.slice(0, 8)}`;

  await db.insert(schema.projects).values({
    id: projectId,
    taskKey: `T${randomUUID().slice(0, 8)}`.toUpperCase(),
    slug,
    name: `Project ${slug}`,
    repoPath: `/repos/${slug}`,
    maisterYamlPath: `/repos/${slug}/maister.yaml`,
  });

  const runId = randomUUID();

  await db.insert(schema.runs).values({
    id: runId,
    projectId,
    runKind: "scratch",
    status: "Running",
    flowVersion: "scratch",
    flowRevision: "manual",
    startedAt: new Date(),
  });
  await db.insert(schema.runSessions).values({
    id: randomUUID(),
    runId,
    sessionName: "default",
    runnerId: null,
    capabilityAgent: agent,
    runnerSnapshot: testRunnerSnapshot(runId, agent),
  });

  return runId;
}

describe("listRunsPage (integration, post-M42 schema)", () => {
  it("projects the runner label from the active run_session, not dropped runs columns", async () => {
    const runId = await seedRunWithSession("claude");

    const page = await listRunsPage({ filters: filters(), user: admin });
    const row = page.rows.find((r) => r.runId === runId);

    expect(row).toBeDefined();
    expect(row?.runnerLabel).toBe("claude · claude-sonnet-4-6");
  });

  it("filters by agent via the active run_session", async () => {
    const claudeRun = await seedRunWithSession("claude");
    const codexRun = await seedRunWithSession("codex");

    const page = await listRunsPage({
      filters: filters({ agent: "claude" }),
      user: admin,
    });
    const ids = page.rows.map((r) => r.runId);

    expect(ids).toContain(claudeRun);
    expect(ids).not.toContain(codexRun);
  });

  it("filters by run kind (ADR-177 D8)", async () => {
    const project = await seedBucketProject();
    const flowRun = await seedBucketRun(project, {
      kind: "flow",
      status: "Running",
    });
    const scratchRun = await seedBucketRun(project, {
      kind: "scratch",
      status: "Running",
    });

    const page = await listRunsPage({
      filters: filters({ projectSlug: project.slug, kind: "flow" }),
      user: admin,
    });

    expect(page.rows.map((row) => row.runId)).toEqual([flowRun]);
    expect(page.totalRows).toBe(1);
    expect(page.rows.map((row) => row.runId)).not.toContain(scratchRun);
  });

  it("filters by each settled outcome bucket", async () => {
    const project = await seedBucketProject();
    const seeded: Array<[RunOutcomeBucket, string]> = [
      [
        "Delivered",
        await seedBucketRun(project, {
          kind: "flow",
          status: "Done",
          workspace: { promotionState: "done", promotionMode: "local_merge" },
        }),
      ],
      [
        "PrOpen",
        await seedBucketRun(project, {
          kind: "flow",
          status: "Done",
          workspace: {
            promotionState: "done",
            promotionMode: "pull_request",
            prState: "open",
          },
        }),
      ],
      [
        "ResultOnly",
        await seedBucketRun(project, { kind: "flow", status: "Done" }),
      ],
      [
        "Failed",
        await seedBucketRun(project, { kind: "flow", status: "Failed" }),
      ],
      [
        "Abandoned",
        await seedBucketRun(project, {
          kind: "flow",
          status: "Review",
          workspace: { promotionState: "none", removed: true },
        }),
      ],
      [
        "Review",
        await seedBucketRun(project, {
          kind: "flow",
          status: "Review",
          workspace: { promotionState: "none" },
        }),
      ],
    ];

    for (const [bucket, runId] of seeded) {
      const page = await listRunsPage({
        filters: filters({ projectSlug: project.slug, bucket }),
        user: admin,
      });

      expect(
        page.rows.map((row) => row.runId),
        bucket,
      ).toEqual([runId]);
      expect(page.totalRows, bucket).toBe(1);
    }
  });

  it("agrees with the Observatory overview cell for the same params", async () => {
    const project = await seedBucketProject();

    await seedBucketRun(project, {
      kind: "flow",
      status: "Done",
      workspace: { promotionState: "done", promotionMode: "local_merge" },
    });
    await seedBucketRun(project, {
      kind: "flow",
      status: "Done",
      workspace: { promotionState: "done", promotionMode: "local_merge" },
    });
    await seedBucketRun(project, {
      kind: "flow",
      status: "Done",
      workspace: {
        promotionState: "done",
        promotionMode: "pull_request",
        prState: "open",
      },
    });
    await seedBucketRun(project, {
      kind: "flow",
      status: "Review",
      workspace: { promotionState: "none", removed: true },
    });
    await seedBucketRun(project, {
      kind: "flow",
      status: "Review",
      workspace: { promotionState: "none" },
    });

    const table = await getObservatoryOverview(db as never, [project], {
      since: BUCKET_SINCE,
      until: BUCKET_UNTIL,
      runKind: "all",
      includePlatform: false,
      includeBreakdown: false,
    });
    const cells = table.rows[0]?.counts.buckets;

    for (const bucket of [
      "Delivered",
      "PrOpen",
      "Abandoned",
      "Review",
    ] as const) {
      const page = await listRunsPage({
        filters: filters({
          projectSlug: project.slug,
          bucket,
          dateFrom: "2026-05-07",
          dateTo: "2026-06-05",
        }),
        user: admin,
      });

      expect(page.totalRows, bucket).toBe(cells?.[bucket]);
    }

    expect(cells?.Delivered).toBe(2);
  });

  // ADR-177 D4/D8. The Platform row counts `project_id IS NULL` runs; this
  // query is `INNER JOIN projects`. So NO ledger URL can reproduce a Platform
  // cell — and a link with no `project=` does not narrow to those runs, it
  // WIDENS to every project's. That is why the overview renders the Platform
  // row's cells as plain numbers (pinned in `overview-table.test.ts`); this is
  // the database fact the render decision rests on. Should `/runs` ever gain a
  // project-less mode, THIS test is the one that has to change first.
  it("cannot reach a project-less run, whatever the filters", async () => {
    const project = await seedBucketProject();
    const visible = await seedBucketRun(project, {
      kind: "scratch",
      status: "Done",
    });
    const platformRun = randomUUID();

    await db.insert(schema.runs).values({
      id: platformRun,
      projectId: null,
      runKind: "scratch",
      status: "Done",
      flowVersion: "scratch",
      startedAt: BUCKET_STARTED_AT,
      endedAt: BUCKET_STARTED_AT,
    });

    const table = await getObservatoryOverview(db as never, [], {
      since: BUCKET_SINCE,
      until: BUCKET_UNTIL,
      runKind: "all",
      includePlatform: true,
      includeBreakdown: false,
    });

    // The overview counts it on the Platform row...
    expect(table.platform?.counts.buckets.ResultOnly).toBe(1);

    // ...and the ledger the cell would have opened cannot return it. Without a
    // `project=`, the reader gets somebody else's run instead of this one.
    const unscoped = await listRunsPage({
      filters: filters({ kind: "scratch", bucket: "ResultOnly" }),
      user: admin,
    });

    expect(unscoped.rows.map((row) => row.runId)).not.toContain(platformRun);
    expect(unscoped.rows.map((row) => row.runId)).toContain(visible);

    // And no project slug selects it either — it has none.
    const scoped = await listRunsPage({
      filters: filters({
        projectSlug: project.slug,
        kind: "scratch",
        bucket: "ResultOnly",
      }),
      user: admin,
    });

    expect(scoped.rows.map((row) => row.runId)).not.toContain(platformRun);
  });
});

// The overview's day-aligned 30-day preset for 2026-06-05T12:00Z, and the
// `from`/`to` the drill-down link spells it as.
const BUCKET_SINCE = new Date("2026-05-07T00:00:00.000Z");
const BUCKET_UNTIL = new Date("2026-06-06T00:00:00.000Z");
const BUCKET_STARTED_AT = new Date("2026-05-20T09:00:00.000Z");

async function seedBucketProject(): Promise<{
  id: string;
  slug: string;
  name: string;
}> {
  const id = randomUUID();
  const slug = `bkt-${id.slice(0, 8)}`;

  await db.insert(schema.projects).values({
    id,
    taskKey: `B${randomUUID().slice(0, 8)}`.toUpperCase(),
    slug,
    name: `Bucket ${slug}`,
    repoPath: `/repos/${slug}`,
    maisterYamlPath: `/repos/${slug}/maister.yaml`,
  });

  return { id, slug, name: `Bucket ${slug}` };
}

async function seedBucketRun(
  project: { id: string },
  input: {
    kind: "flow" | "scratch" | "agent";
    status: string;
    workspace?: {
      promotionState: string;
      promotionMode?: string;
      prState?: "open" | "merged" | "closed";
      removed?: boolean;
    };
  },
): Promise<string> {
  const runId = randomUUID();

  await db.insert(schema.runs).values({
    id: runId,
    projectId: project.id,
    runKind: input.kind,
    status: input.status,
    flowVersion: "v1.0.0",
    startedAt: BUCKET_STARTED_AT,
    endedAt: input.status === "Running" ? null : BUCKET_STARTED_AT,
  });

  if (input.workspace) {
    const wsId = randomUUID();

    await db.insert(schema.workspaces).values({
      id: wsId,
      runId,
      projectId: project.id,
      branch: `maister/${wsId.slice(0, 8)}`,
      worktreePath: `/worktrees/${wsId}`,
      parentRepoPath: `/repos/${project.id}`,
      promotionState: input.workspace.promotionState,
      promotionMode: input.workspace.promotionMode ?? null,
      prState: input.workspace.prState ?? null,
      removedAt: input.workspace.removed ? BUCKET_STARTED_AT : null,
      removalKind: input.workspace.removed ? "drop" : null,
    });
  }

  return runId;
}
