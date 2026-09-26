import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { seedProject, seedRun } from "@/test-support/execution-host-seed";
import { seedActiveUser } from "@/test-support/librarian-seed";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

// ADR-183 (T2.3): a librarian run is its owner's private conversation. It
// never appears in a project-scoped read model or a metric, it is never
// TTL-abandoned while parked, and reconcile gives it its own arm.

let database: StartedPostgresTestDb;
let db: NodePgDatabase;

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));

let adminId = "";
let ownerId = "";
let librarianRunId = "";

async function seedParkedLibrarianRun(input: {
  ownerId: string;
  parkedHoursAgo: number;
}): Promise<string> {
  const runId = randomUUID();

  await db.execute(sql`
    INSERT INTO runs
      (id, run_kind, status, flow_version, persistent, created_by_user_id,
       agent_workspace, execution_data_plane_mode, started_at, checkpoint_at)
    VALUES
      (${runId}, 'librarian', 'NeedsInputIdle', 'librarian', true, ${input.ownerId},
       'none', 'canonical_events_v1', now() - interval '2 days',
       now() - make_interval(hours => ${input.parkedHoursAgo}))
  `);

  return runId;
}

beforeAll(async () => {
  database = await startMainPostgresTestDb({
    databaseName: "librarian_run_kind_fanout",
  });
  db = database.db as unknown as NodePgDatabase;
  adminId = await seedActiveUser(db, { role: "admin" });
  ownerId = await seedActiveUser(db);
  librarianRunId = await seedParkedLibrarianRun({
    ownerId,
    parkedHoursAgo: 25,
  });
  // A project run beside it, so an empty result cannot pass by accident.
  const projectId = await seedProject(db);

  await seedRun(db, { projectId, runKind: "scratch", status: "Running" });
}, 180_000);

afterAll(async () => {
  await database?.stop();
});

describe("IT-LCV-04 part 2: a librarian run appears in no project read model or metric", () => {
  it("is absent from the global admin's portfolio", async () => {
    const { getPortfolio } = await import("@/lib/queries/portfolio");
    const portfolio = await getPortfolio(adminId, "admin");

    expect(JSON.stringify(portfolio)).not.toContain(librarianRunId);
  });

  it("is absent from the global admin's /runs ledger", async () => {
    const { listRunsPage, normalizeRunsListFilters } = await import(
      "@/lib/queries/runs-list"
    );
    const page = await listRunsPage({
      db: db as never,
      filters: normalizeRunsListFilters({}),
      user: { id: adminId, role: "admin" },
    });

    expect(page.rows.length).toBeGreaterThan(0);
    expect(page.rows.map((row) => row.runId)).not.toContain(librarianRunId);
  });

  it("is absent from the global admin's work table", async () => {
    const { getWorkTable } = await import("@/lib/queries/work-table");
    const table = await getWorkTable({ id: adminId, role: "admin" });

    expect(JSON.stringify(table)).not.toContain(librarianRunId);
  });

  it("is never counted in the Observatory's project-less platform group", async () => {
    const { getObservatoryOverview } = await import(
      "@/lib/queries/observatory-overview"
    );
    const table = await getObservatoryOverview(db as never, [], {
      since: new Date(Date.now() - 30 * 86_400_000),
      until: new Date(Date.now() + 86_400_000),
      runKind: "all",
      includePlatform: true,
      includeBreakdown: false,
    });

    expect(table.platform).toBeNull();
    expect(Object.values(table.totals.runs).reduce((a, b) => a + b, 0)).toBe(0);
  });

  it("refuses a global admin project access through its NULL project", async () => {
    const { requireProjectActionForUser } = await import("@/lib/authz");

    await expect(
      requireProjectActionForUser(adminId, null as never, "readBoard"),
    ).rejects.toMatchObject({
      code: "UNAUTHORIZED",
      details: { reason: "project_less_run" },
    });
  });
});

describe("IT-EDGE-LCV-05: a parked librarian run survives the keep-alive sweep", () => {
  it("stays NeedsInputIdle after the TTL pass, parked for 25 h", async () => {
    const { runPass2 } = await import("@/lib/runs/keepalive-sweeper");

    await runPass2(db as never);
    const rows = await db.execute(sql`
      SELECT status FROM runs WHERE id = ${librarianRunId}
    `);

    expect((rows as unknown as { rows: { status: string }[] }).rows[0]).toEqual(
      { status: "NeedsInputIdle" },
    );
  });
});

describe("IT-LCV-09 part 1: reconcile gives a librarian run its own arm", () => {
  const base = {
    runKind: "librarian" as const,
    acpSessionId: null,
    currentStepId: null,
    currentNodeKind: null,
    worktreeExists: true,
    resumeStartedAt: null,
    nowMs: Date.now(),
    graceSeconds: 60,
  };

  it("parks a running turn whose host is gone past grace — never the crash arm", async () => {
    const { classifyRunReconcile } = await import("@/lib/reconcile");

    expect(
      classifyRunReconcile({
        ...base,
        runStatus: "Running",
        liveSession: false,
        latestAttemptStartedAt: new Date(Date.now() - 10 * 60_000),
      }),
    ).toEqual({ action: "librarian-park", reason: "librarian-host-lost" });
  });

  it("leaves a live session to its turn owner, a fresh turn to grace, and a parked run alone", async () => {
    const { classifyRunReconcile } = await import("@/lib/reconcile");

    expect(
      classifyRunReconcile({
        ...base,
        runStatus: "Running",
        liveSession: true,
        latestAttemptStartedAt: new Date(Date.now() - 10 * 60_000),
      }),
    ).toEqual({ action: "skip", reason: "live-librarian-session" });
    expect(
      classifyRunReconcile({
        ...base,
        runStatus: "Running",
        liveSession: false,
        latestAttemptStartedAt: new Date(),
      }),
    ).toEqual({ action: "skip", reason: "grace-window" });
    expect(
      classifyRunReconcile({
        ...base,
        runStatus: "NeedsInputIdle",
        liveSession: false,
        latestAttemptStartedAt: null,
      }),
    ).toEqual({ action: "skip", reason: "not-running" });
  });
});
