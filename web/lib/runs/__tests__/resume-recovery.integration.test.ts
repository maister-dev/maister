// M11b Phase 2.6: takeover-aware recovery sweep — REAL Postgres because the
// candidate detection correlates three tables (runs.status='Running',
// node_attempts takeover-return markers, gate_results staleness) that a
// hand-rolled fake DB cannot faithfully reproduce.
//
// Owns two matrix rows:
//   - resume-recovery.test.ts::humanworking-survives-restart
//   - resume-recovery.test.ts::takeover-returned-stranded-running-is-requeued

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
import { createGateResult, markGateStale } from "@/lib/flows/graph/gate-store";
import {
  appendNodeAttempt,
  claimTakeover,
  recordTakeoverReturn,
} from "@/lib/flows/graph/ledger";
import {
  runResumeRecoverySweep,
  runTakeoverReturnRecoverySweep,
} from "@/lib/runs/resume-recovery";

const schema = schemaModule as unknown as Record<string, any>;
const { flows, projects, runs, tasks, users } = schema;

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;
let projectId: string;
let executorId: string;
let flowId: string;
let ownerUserId: string;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("recovery_test")
    .withUsername("test")
    .withPassword("test")
    .start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);
  await migrate(db, { migrationsFolder: "./lib/db/migrations" });

  projectId = randomUUID();
  executorId = randomUUID();
  flowId = randomUUID();
  ownerUserId = randomUUID();

  await db.insert(projects).values({
    id: projectId,
    slug: "recov-app",
    name: "Recov App",
    repoPath: "/repos/recov-app",
    maisterYamlPath: "/repos/recov-app/maister.yaml",
  });
  await db.insert(schema.platformAcpRunners).values(testPlatformRunnerRow(executorId, "claude"));
  await db.insert(flows).values({
    id: flowId,
    projectId,
    flowRefId: "bugfix",
    source: "github.com/x/y",
    version: "v1.0.0",
    installedPath: "/tmp/flows/bugfix",
    manifest: { schemaVersion: 1, name: "Bugfix", nodes: [] },
    schemaVersion: 1,
  });
  await db.insert(users).values({
    id: ownerUserId,
    email: "owner@maister.local",
    role: "member",
  });
}, 180_000);

afterAll(async () => {
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

describe("resume-recovery — HumanWorking exclusion (M11b)", () => {
  it("humanworking-survives-restart: a HumanWorking run is never a sweep candidate and is NOT flipped to Crashed", async () => {
    // Session-less by contract (no acpSessionId) but holds a worktree.
    const runId = await seedRun("HumanWorking", { currentStepId: "review" });

    const result = await runResumeRecoverySweep({
      db,
      loadSessions: async () => ({ ok: true as const, map: new Map() }),
      scheduleDriver: vi.fn(() => "x"),
    });

    expect(result.candidatesFound).toBe(0);

    const row = await readRun(runId);

    expect(row.status).toBe("HumanWorking");
  }, 60_000);
});

describe("resume-recovery — takeover-return stranded Running (M11b F3)", () => {
  // Build the stranded-Running state: claim → return (returned_diff + ended_at
  // set on the takeover row) → re-entry gate created then staled → run flipped
  // to Running with current_step_id at the re-entry, but NO fresh re-entry
  // (checks) node_attempt — i.e. the post-return resume never progressed.
  async function seedStrandedRun(): Promise<string> {
    const runId = await seedRun("Running", { currentStepId: "checks" });

    // PRE-takeover: the re-entry node (checks) ran and passed; its gate
    // existed before the human claimed. Created FIRST so its started_at
    // precedes the takeover return's ended_at (the temporal guard).
    const priorChecks = await appendNodeAttempt({
      runId,
      nodeId: "checks",
      nodeType: "check",
      db,
    });
    const gate = await createGateResult({
      runId,
      nodeAttemptId: priorChecks.id,
      gateId: "test",
      kind: "command_check",
      mode: "blocking",
      db,
    });

    // Claim → return: the return staled the re-entry gate and set the
    // takeover row's returned_diff + ended_at. There is NO fresh checks
    // attempt after the return (the stranded state).
    await claimTakeover({
      runId,
      nodeId: "review",
      userId: ownerUserId,
      db,
    });
    await recordTakeoverReturn({
      runId,
      nodeId: "review",
      baseRef: "base-sha",
      returnedCommits: "abc fix",
      returnedDiff: "diff",
      db,
    });
    await markGateStale(gate.id, db);

    return runId;
  }

  it("takeover-returned-stranded-running-is-requeued: detected as a candidate and re-dispatched via the runner entry (NOT Crashed)", async () => {
    const runId = await seedStrandedRun();
    const runFlowSpy = vi.fn(async () => {});

    const result = await runTakeoverReturnRecoverySweep({
      db,
      runFlow: runFlowSpy,
    });

    expect(result.candidatesFound).toBe(1);
    expect(result.reDispatched).toBe(1);
    expect(runFlowSpy).toHaveBeenCalledTimes(1);
    expect(runFlowSpy).toHaveBeenCalledWith(runId, expect.anything());

    // The sweep MUST NOT crash the run — re-dispatch only.
    const row = await readRun(runId);

    expect(row.status).toBe("Running");
  }, 60_000);

  it("does NOT re-dispatch a Running run that already produced a fresh re-entry attempt after the return (resume progressed)", async () => {
    const runId = await seedStrandedRun();

    // A fresh re-entry attempt after the return → resume already progressed,
    // so the run is NOT stranded and must NOT be re-dispatched.
    await appendNodeAttempt({
      runId,
      nodeId: "checks",
      nodeType: "check",
      db,
    });

    const runFlowSpy = vi.fn(async () => {});
    const result = await runTakeoverReturnRecoverySweep({
      db,
      runFlow: runFlowSpy,
    });

    expect(result.candidatesFound).toBe(0);
    expect(runFlowSpy).not.toHaveBeenCalled();
  }, 60_000);

  it("does NOT treat a plain Running run (no takeover return) as a stranded candidate", async () => {
    await seedRun("Running", { currentStepId: "implement" });

    const runFlowSpy = vi.fn(async () => {});
    const result = await runTakeoverReturnRecoverySweep({
      db,
      runFlow: runFlowSpy,
    });

    expect(result.candidatesFound).toBe(0);
    expect(runFlowSpy).not.toHaveBeenCalled();
  }, 60_000);
});
