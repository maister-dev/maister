// M36 Phase 10 (ADR-096): one active WRITER per shared worktree, enforced as a
// promote-time guard in promoteNextPending. A shared-mode Pending child is held
// Pending while a writer sibling (same root_run_id, workspace_mode='shared') is
// in a slot-holding status; it promotes once the sibling parks/terminates. The
// guard rides the existing advisory-locked tx and never affects own/non-shared
// runs. Verified against real Postgres.

import { randomUUID } from "node:crypto";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";

import { promoteNextPending } from "@/lib/scheduler";

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;
let projectId: string;
let originalAgentsCap: string | undefined;

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

beforeEach(async () => {
  originalAgentsCap = process.env.MAISTER_MAX_CONCURRENT_AGENTS;
  // A roomy cap so the guard — not the cap — is what holds the sibling Pending.
  process.env.MAISTER_MAX_CONCURRENT_AGENTS = "6";

  await pool.query(`DELETE FROM "runs"`);
  await pool.query(`DELETE FROM "agents"`);
  await pool.query(`DELETE FROM "projects"`);

  projectId = randomUUID();
  await pool.query(
    `INSERT INTO "projects" ("id", "slug", "name", "repo_path", "main_branch", "branch_prefix", "maister_yaml_path", "task_key")
     VALUES ($1, $2, 'P', $3, 'main', 'maister/', '/tmp/maister.yaml', $4)`,
    [
      projectId,
      `p-${projectId.slice(0, 8)}`,
      `/repos/${projectId}`,
      `K${projectId
        .replace(/[^0-9A-Za-z]/g, "")
        .slice(0, 7)
        .toUpperCase()}`,
    ],
  );
  await pool.query(
    `INSERT INTO "agents" ("id", "flow_ref_id", "version_label", "origin", "name", "description", "workspace", "mode", "triggers", "risk_tier", "source_path")
     VALUES ('shared-agent', 'test-pkg', 'v1.0.0', 'git', 'A', 'd', 'worktree', 'session', '["manual"]'::jsonb, 'read_only', '/tmp/agent.md')`,
  );
});

afterEach(() => {
  if (originalAgentsCap === undefined) {
    delete process.env.MAISTER_MAX_CONCURRENT_AGENTS;
  } else {
    process.env.MAISTER_MAX_CONCURRENT_AGENTS = originalAgentsCap;
  }
});

// A root orchestrator run for the tree (its own root).
async function insertRoot(): Promise<string> {
  const id = randomUUID();

  await pool.query(
    `INSERT INTO "runs" ("id", "run_kind", "agent_id", "trigger_source", "project_id", "flow_version", "flow_revision", "status", "root_run_id", "started_at")
     VALUES ($1, 'agent', 'shared-agent', 'manual', $2, 'agent', 'manual', 'WaitingOnChildren', $1, now())`,
    [id, projectId],
  );

  return id;
}

async function insertChild(args: {
  status: string;
  rootRunId: string;
  workspaceMode: "own" | "shared" | null;
  startedOffsetMs?: number;
}): Promise<string> {
  const id = randomUUID();
  const startedAt = new Date(Date.now() + (args.startedOffsetMs ?? 0));

  await pool.query(
    `INSERT INTO "runs" ("id", "run_kind", "agent_id", "trigger_source", "project_id", "flow_version", "flow_revision", "status", "agent_workspace", "parent_run_id", "root_run_id", "workspace_mode", "started_at")
     VALUES ($1, 'agent', 'shared-agent', 'manual', $2, 'agent', 'manual', $3, 'worktree', $4, $4, $5, $6)`,
    [id, projectId, args.status, args.rootRunId, args.workspaceMode, startedAt],
  );

  return id;
}

async function runStatus(id: string): Promise<string> {
  const res = await pool.query(`SELECT "status" FROM "runs" WHERE "id" = $1`, [
    id,
  ]);

  return res.rows[0].status as string;
}

async function promoteAgent(): Promise<string | null> {
  const dispatched: string[] = [];
  const promoted = await promoteNextPending({
    db,
    pool: "agent",
    startAgentRun: (id) => void dispatched.push(id),
    runFlow: () => undefined,
  });

  await new Promise((resolve) => setTimeout(resolve, 0));

  return promoted.promotedRunId;
}

describe("M36 Phase 10 — shared-worktree write serialization", () => {
  it("holds a 2nd shared child Pending while a writer sibling is active, then promotes it after the sibling parks", async () => {
    const root = await insertRoot();
    const writerA = await insertChild({
      status: "Running",
      rootRunId: root,
      workspaceMode: "shared",
      startedOffsetMs: -60_000,
    });
    const childB = await insertChild({
      status: "Pending",
      rootRunId: root,
      workspaceMode: "shared",
    });

    // A is the active writer → B must stay Pending (nothing promoted).
    expect(await promoteAgent()).toBeNull();
    expect(await runStatus(childB)).toBe("Pending");

    // A parks (yields the writer slot).
    await pool.query(
      `UPDATE "runs" SET "status" = 'NeedsInputIdle' WHERE "id" = $1`,
      [writerA],
    );

    // Now B promotes.
    expect(await promoteAgent()).toBe(childB);
    expect(await runStatus(childB)).toBe("Running");
  });

  it("skips a blocked shared candidate and promotes a ready own-mode child behind it", async () => {
    const root = await insertRoot();

    // Active writer in the shared tree.
    await insertChild({
      status: "Running",
      rootRunId: root,
      workspaceMode: "shared",
      startedOffsetMs: -60_000,
    });
    // A shared Pending child queued FIRST (older) — blocked by the writer.
    const blockedShared = await insertChild({
      status: "Pending",
      rootRunId: root,
      workspaceMode: "shared",
      startedOffsetMs: -30_000,
    });
    // An own-mode child queued LATER — must be promoted past the blocked one.
    const ownChild = await insertChild({
      status: "Pending",
      rootRunId: root,
      workspaceMode: "own",
      startedOffsetMs: -10_000,
    });

    expect(await promoteAgent()).toBe(ownChild);
    expect(await runStatus(ownChild)).toBe("Running");
    expect(await runStatus(blockedShared)).toBe("Pending");
  });

  it("two shared children of DIFFERENT trees do not block each other", async () => {
    const rootA = await insertRoot();
    const rootB = await insertRoot();

    await insertChild({
      status: "Running",
      rootRunId: rootA,
      workspaceMode: "shared",
      startedOffsetMs: -60_000,
    });
    const childB = await insertChild({
      status: "Pending",
      rootRunId: rootB,
      workspaceMode: "shared",
    });

    // The active writer is in tree A; tree B's child is free to promote.
    expect(await promoteAgent()).toBe(childB);
    expect(await runStatus(childB)).toBe("Running");
  });

  it("an own-mode child is never serialized even with a Running same-tree sibling", async () => {
    const root = await insertRoot();

    // A same-tree own-mode Running sibling is NOT a shared writer.
    await insertChild({
      status: "Running",
      rootRunId: root,
      workspaceMode: "own",
      startedOffsetMs: -60_000,
    });
    const ownPending = await insertChild({
      status: "Pending",
      rootRunId: root,
      workspaceMode: "own",
    });

    expect(await promoteAgent()).toBe(ownPending);
    expect(await runStatus(ownPending)).toBe("Running");
  });

  // C3 (real two-racer): two concurrent promote workers against two shared-mode
  // Pending siblings of one root must admit AT MOST ONE writer. The scheduler's
  // advisory lock serializes the two promote transactions and
  // sharedWriterSiblingActive rejects the second under that lock (one active
  // writer per shared tree) — a single-threaded test cannot prove this.
  it("two concurrent promotes admit exactly one shared writer", async () => {
    const root = await insertRoot();
    const childA = await insertChild({
      status: "Pending",
      rootRunId: root,
      workspaceMode: "shared",
      startedOffsetMs: -2_000,
    });
    const childB = await insertChild({
      status: "Pending",
      rootRunId: root,
      workspaceMode: "shared",
      startedOffsetMs: -1_000,
    });

    const [a, b] = await Promise.all([promoteAgent(), promoteAgent()]);

    // Exactly one call promoted a child; the other was held by the writer guard.
    expect([a, b].filter(Boolean).length).toBe(1);

    // Exactly one of the two shared siblings is Running, the other still Pending.
    const statuses = await Promise.all([runStatus(childA), runStatus(childB)]);

    expect(statuses.filter((s) => s === "Running").length).toBe(1);
    expect(statuses.filter((s) => s === "Pending").length).toBe(1);
  }, 60_000);
});
