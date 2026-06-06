// M19 Phase 1 (T1.A + T1.B): crash-then-promote with resume-on-promote.
// Real Postgres testcontainer — the advisory-lock + count-then-update path
// is not faithfully mockable.
//
//   * crashRunningRun frees a slot; promoteNextPending then promotes the
//     OLDEST Pending row into it.
//   * A promoted Pending row WITH an acp_session_id is resumed (dispatched
//     via opts.resumeRun, NOT runFlow) and gets a fresh resume_started_at;
//     the promote tx sets status=Running, started_at, resume_started_at.
//   * A promoted Pending row with a null acp_session_id is dispatched via
//     opts.runFlow (resume_started_at stays null), unchanged from M8.

import { randomUUID } from "node:crypto";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
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

import * as schemaModule from "@/lib/db/schema";
import { testPlatformRunnerRow, testRunnerSnapshot } from "@/lib/__tests__/runner-fixtures";
import { promoteNextPending } from "@/lib/scheduler";
import { crashRunningRun } from "@/lib/runs/state-transitions";

const schema = schemaModule as unknown as Record<string, any>;
const { flows, projects, runs, tasks } = schema;

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;
let originalDbUrl: string | undefined;
let projectId: string;
let executorId: string;
let flowId: string;
let originalCap: string | undefined;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("sched_crash_test")
    .withUsername("test")
    .withPassword("test")
    .start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);
  await migrate(db, { migrationsFolder: "./lib/db/migrations" });

  originalDbUrl = process.env.DB_URL;
  process.env.DB_URL = container.getConnectionUri();

  projectId = randomUUID();
  executorId = randomUUID();

  await db.insert(projects).values({
    id: projectId,
    slug: "sched-crash-app",
    name: "Sched Crash App",
    repoPath: "/repos/sched-crash-app",
    maisterYamlPath: "/repos/sched-crash-app/maister.yaml",
  });

  await db.insert(schema.platformAcpRunners).values(testPlatformRunnerRow(executorId, "claude"));

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

  originalCap = process.env.MAISTER_MAX_CONCURRENT_RUNS;
  process.env.MAISTER_MAX_CONCURRENT_RUNS = "3";
}, 180_000);

afterAll(async () => {
  if (originalCap === undefined) {
    delete process.env.MAISTER_MAX_CONCURRENT_RUNS;
  } else {
    process.env.MAISTER_MAX_CONCURRENT_RUNS = originalCap;
  }
  if (originalDbUrl === undefined) {
    delete process.env.DB_URL;
  } else {
    process.env.DB_URL = originalDbUrl;
  }
  await pool?.end();
  await container?.stop();
});

beforeEach(async () => {
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
    runnerId: executorId,
    capabilityAgent: "claude",
    runnerSnapshot: testRunnerSnapshot(executorId),
    status,
    flowVersion: "v1",
    startedAt: new Date(),
    ...fields,
  });

  return runId;
}

async function readRun(runId: string): Promise<any> {
  const rows = await db.select().from(runs).where(eq(runs.id, runId));

  return rows[0];
}

// promoteNextPending dispatches the post-commit hook via queueMicrotask;
// flush it so the spy assertions are stable.
async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("crash → promote (integration)", () => {
  it("crashing a Running run frees a slot and promoteNextPending promotes the OLDEST Pending", async () => {
    // Cap = 3, fully consumed by 3 Running rows.
    const crashing = await seedRun("Running");

    await seedRun("Running");
    await seedRun("Running");

    // Two queued Pending rows; the older one must win.
    const oldestPending = await seedRun("Pending", {
      startedAt: new Date(Date.now() - 60_000),
    });

    await seedRun("Pending", { startedAt: new Date(Date.now() - 30_000) });

    // No free slot yet — promote is a no-op.
    const before = await promoteNextPending({ db, runFlow: vi.fn() });

    expect(before.promotedRunId).toBeNull();

    // Crash one Running → a slot frees.
    const crashed = await crashRunningRun(crashing, "agent-session-gone", {
      db,
    });

    expect(crashed.ok).toBe(true);

    const after = await promoteNextPending({ db, runFlow: vi.fn() });

    expect(after.promotedRunId).toBe(oldestPending);
    expect((await readRun(oldestPending)).status).toBe("Running");
  }, 60_000);

  it("a promoted Pending WITH acpSessionId is resumed via resumeRun (not runFlow), refreshing resumeStartedAt", async () => {
    // One free slot: 2 live rows, cap 3.
    await seedRun("Running");
    await seedRun("NeedsInput");

    const pending = await seedRun("Pending", {
      acpSessionId: "acp-session-abc",
      resumeStartedAt: null,
      startedAt: new Date(Date.now() - 60_000),
    });

    const resumeRun = vi.fn();
    const runFlow = vi.fn();

    const r = await promoteNextPending({ db, resumeRun, runFlow });

    await flushMicrotasks();

    expect(r.promotedRunId).toBe(pending);

    const row = await readRun(pending);

    expect(row.status).toBe("Running");
    expect(row.startedAt).not.toBeNull();
    expect(row.resumeStartedAt).not.toBeNull();

    expect(resumeRun).toHaveBeenCalledTimes(1);
    expect(resumeRun).toHaveBeenCalledWith(pending);
    expect(runFlow).not.toHaveBeenCalled();
  }, 60_000);

  it("a promoted Pending with null acpSessionId is dispatched via runFlow (resumeStartedAt stays null)", async () => {
    await seedRun("Running");
    await seedRun("NeedsInput");

    const pending = await seedRun("Pending", {
      acpSessionId: null,
      startedAt: new Date(Date.now() - 60_000),
    });

    const resumeRun = vi.fn();
    const runFlow = vi.fn();

    const r = await promoteNextPending({ db, resumeRun, runFlow });

    await flushMicrotasks();

    expect(r.promotedRunId).toBe(pending);

    const row = await readRun(pending);

    expect(row.status).toBe("Running");
    expect(row.resumeStartedAt).toBeNull();

    expect(runFlow).toHaveBeenCalledTimes(1);
    expect(runFlow).toHaveBeenCalledWith(pending);
    expect(resumeRun).not.toHaveBeenCalled();
  }, 60_000);
});
