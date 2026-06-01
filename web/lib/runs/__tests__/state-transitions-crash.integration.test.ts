// M19 Phase 1 (T1.A + T1.C): crashRunningRun + markAbandoned GC-deadline
// stamp. Real Postgres testcontainer because the status-guard CAS and the
// same-transaction workspace stamp depend on actual SQL semantics.
//
//   * crashRunningRun: Running → Crashed, sets endedAt, nulls
//     current_step_id + resume_started_at; a second call is a no-op CAS miss.
//   * markAbandoned: in the SAME tx as the run CAS, stamps
//     workspaces.scheduled_removal_at = endedAt + gcAgeDays() days for the
//     run's workspace. A CAS miss (already terminal) leaves no stamp.

import { randomUUID } from "node:crypto";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import * as schemaModule from "@/lib/db/schema";
import { gcAgeDays } from "@/lib/instance-config";
import {
  crashRunningRun,
  markAbandoned,
} from "@/lib/runs/state-transitions";

const schema = schemaModule as unknown as Record<string, any>;
const { executors, flows, projects, runs, tasks, workspaces } = schema;

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;
let projectId: string;
let executorId: string;
let flowId: string;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("state_crash_test")
    .withUsername("test")
    .withPassword("test")
    .start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);
  await migrate(db, { migrationsFolder: "./lib/db/migrations" });

  projectId = randomUUID();
  executorId = randomUUID();

  await db.insert(projects).values({
    id: projectId,
    slug: "crash-app",
    name: "Crash App",
    repoPath: "/repos/crash-app",
    maisterYamlPath: "/repos/crash-app/maister.yaml",
  });

  await db.insert(executors).values({
    id: executorId,
    projectId,
    executorRefId: "claude-sonnet",
    agent: "claude",
    model: "claude-sonnet-4-6",
  });

  flowId = randomUUID();

  await db.insert(flows).values({
    id: flowId,
    projectId,
    flowRefId: "bugfix",
    source: "github.com/x/y",
    version: "v1.0.0",
    installedPath: "/tmp/flows/bugfix",
    manifest: { schemaVersion: 1, name: "Bugfix", steps: [] },
    schemaVersion: 1,
  });
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

beforeEach(async () => {
  await db.delete(workspaces);
  await db.delete(runs);
  await db.delete(tasks);
});

async function seedRun(
  status: string,
  fields: Record<string, unknown> = {},
): Promise<string> {
  const taskId = randomUUID();
  const runId = randomUUID();

  await db.insert(tasks).values({
    id: taskId,
    projectId,
    title: "t",
    prompt: "p",
    flowId,
    status: "InFlight",
  });

  await db.insert(runs).values({
    id: runId,
    taskId,
    projectId,
    flowId,
    executorId,
    status,
    flowVersion: "v1",
    startedAt: new Date(),
    ...fields,
  });

  return runId;
}

async function seedWorkspace(runId: string): Promise<string> {
  const id = randomUUID();

  await db.insert(workspaces).values({
    id,
    runId,
    projectId,
    branch: `maister/${id.slice(0, 8)}`,
    worktreePath: `/tmp/worktrees/${id}`,
    parentRepoPath: "/repos/crash-app",
  });

  return id;
}

async function readRun(runId: string): Promise<any> {
  const rows = await db.select().from(runs).where(eq(runs.id, runId));

  return rows[0];
}

async function readWorkspace(id: string): Promise<any> {
  const rows = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.id, id));

  return rows[0];
}

describe("crashRunningRun (integration)", () => {
  it("Running → Crashed: endedAt set, currentStepId + resumeStartedAt nulled", async () => {
    const runId = await seedRun("Running", {
      currentStepId: "plan",
      resumeStartedAt: new Date(),
    });

    const r = await crashRunningRun(runId, "agent-session-gone", { db });

    expect(r.ok).toBe(true);

    const row = await readRun(runId);

    expect(row.status).toBe("Crashed");
    expect(row.endedAt).not.toBeNull();
    expect(row.currentStepId).toBeNull();
    expect(row.resumeStartedAt).toBeNull();
  }, 60_000);

  it("second call is an idempotent CAS miss → {ok:false}", async () => {
    const runId = await seedRun("Running");

    const first = await crashRunningRun(runId, "worktree-gone", { db });

    expect(first.ok).toBe(true);

    const second = await crashRunningRun(runId, "worktree-gone", { db });

    expect(second.ok).toBe(false);
    if (second.ok === false) {
      expect(second.reason).toBe("status-guard-mismatch");
    }

    const row = await readRun(runId);

    expect(row.status).toBe("Crashed");
  }, 60_000);

  it("rejects a non-Running row (status-guard mismatch)", async () => {
    const runId = await seedRun("NeedsInput");

    const r = await crashRunningRun(runId, "agent-session-gone", { db });

    expect(r.ok).toBe(false);

    const row = await readRun(runId);

    expect(row.status).toBe("NeedsInput");
  }, 60_000);
});

describe("markAbandoned — GC-deadline stamp (integration)", () => {
  it("stamps workspaces.scheduled_removal_at = endedAt + gcAgeDays() in the same tx", async () => {
    const runId = await seedRun("Running");
    const workspaceId = await seedWorkspace(runId);

    const r = await markAbandoned(runId, { db });

    expect(r.ok).toBe(true);

    const run = await readRun(runId);
    const ws = await readWorkspace(workspaceId);

    expect(run.status).toBe("Abandoned");
    expect(run.endedAt).not.toBeNull();
    expect(ws.scheduledRemovalAt).not.toBeNull();

    const endedMs = new Date(run.endedAt).getTime();
    const scheduledMs = new Date(ws.scheduledRemovalAt).getTime();
    const expectedDeltaMs = gcAgeDays() * 24 * 60 * 60 * 1000;

    // Allow a small skew: endedAt and the stamp are computed in the same
    // helper but may be distinct Date instances.
    expect(Math.abs(scheduledMs - endedMs - expectedDeltaMs)).toBeLessThan(
      5_000,
    );
  }, 60_000);

  it("CAS miss (already terminal) leaves scheduled_removal_at untouched", async () => {
    const runId = await seedRun("Done");
    const workspaceId = await seedWorkspace(runId);

    const r = await markAbandoned(runId, { db });

    expect(r.ok).toBe(false);

    const ws = await readWorkspace(workspaceId);

    expect(ws.scheduledRemovalAt).toBeNull();
  }, 60_000);
});
