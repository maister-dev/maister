import { randomUUID } from "node:crypto";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// FIXME(any): drizzle-orm dual peer-dep variants — runtime works, cast silences
// the type-only clash (matches emit-run-status.integration.test.ts).
import * as fullSchema from "@/lib/db/schema";
import { testPlatformRunnerRow } from "@/lib/__tests__/runner-fixtures";

// =============================================================================
// T7 (gate) — gate.decided webhook emits (TDD red).
//
// Mirrors the T6 state-transition approach on the cleanest DB writepoints:
// the gate-store helpers in `@/lib/flows/graph/gate-store`. Pins the DQ2
// invariant for `gate.decided`:
//
//   - A gate_results row REACHING a terminal decision (`passed|failed|
//     overridden`) — whether inserted already-terminal (`createGateResult`)
//     or transitioned there (`markGatePassed|markGateFailed|markGateOverridden`,
//     `reportExternalGate`) — captures exactly ONE `gate.decided` outbox row,
//     data `{gateId, kind, mode, status, nodeAttemptId}`, committed with the
//     write.
//   - A NON-terminal landing (`running` insert, `markGateStale`,
//     `markGateSkipped`) emits NOTHING.
//
// gate_results has runId + nodeAttemptId but NO projectId — the emit must
// resolve project_id FROM the run; every row's project_id MUST equal the
// seeded run's projectId. payload NULL, fanout_at NULL.
//
// The emits are NOT wired yet, so the terminal cases MUST fail on "expected 1
// webhook_events row, got 0". The non-terminal cases are vacuously green now
// (0 rows) and become regression guards once the emit lands. Helper calls and
// the testcontainers boot succeed — the only red is the absent outbox row.
// =============================================================================

const schema = fullSchema as unknown as Record<string, any>;

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;

// gate-store helpers accept an explicit `db`, but `reportExternalGate` composes
// `recordArtifact` which falls back to getDb() when none is threaded — mock it
// to the container so no helper ever reaches for a real client.
vi.mock("@/lib/db/client", () => ({
  getDb: () => db,
}));

let createGateResult: typeof import("@/lib/flows/graph/gate-store").createGateResult;
let markGatePassed: typeof import("@/lib/flows/graph/gate-store").markGatePassed;
let markGateFailed: typeof import("@/lib/flows/graph/gate-store").markGateFailed;
let markGateOverridden: typeof import("@/lib/flows/graph/gate-store").markGateOverridden;
let markGateStale: typeof import("@/lib/flows/graph/gate-store").markGateStale;
let markGateSkipped: typeof import("@/lib/flows/graph/gate-store").markGateSkipped;
let reportExternalGate: typeof import("@/lib/flows/graph/gate-store").reportExternalGate;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("maister_test")
    .withUsername("test")
    .withPassword("test")
    .start();

  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);

  await migrate(db, { migrationsFolder: "./lib/db/migrations" });

  ({
    createGateResult,
    markGatePassed,
    markGateFailed,
    markGateOverridden,
    markGateStale,
    markGateSkipped,
    reportExternalGate,
  } = await import("@/lib/flows/graph/gate-store"));
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

// Seeds project + runner + flow + task + run + a node_attempts row (the
// gate_results.nodeAttemptId FK target). Returns the ids the emit must carry.
async function seedRunWithNodeAttempt(): Promise<{
  projectId: string;
  runId: string;
  nodeAttemptId: string;
}> {
  const projectId = randomUUID();
  const executorId = randomUUID();
  const flowId = randomUUID();
  const taskId = randomUUID();
  const runId = randomUUID();
  const nodeAttemptId = randomUUID();

  await db.insert(schema.projects).values({
    taskKey: `T${crypto.randomUUID().slice(0, 8)}`.toUpperCase(),
    id: projectId,
    slug: `proj-${projectId.slice(0, 8)}`,
    name: "Test",
    repoPath: `/tmp/proj-${projectId.slice(0, 8)}`,
    maisterYamlPath: "/tmp/m.yaml",
  });

  await db
    .insert(schema.platformAcpRunners)
    .values(testPlatformRunnerRow(executorId, "claude"));

  await db.insert(schema.flows).values({
    id: flowId,
    projectId,
    flowRefId: "bugfix",
    source: "github.com/x/y",
    version: "v1.0.0",
    installedPath: "/tmp/flows/bugfix",
    manifest: { schemaVersion: 1, name: "Bugfix", steps: [] },
    schemaVersion: 1,
  });

  await db.insert(schema.tasks).values({
    number: Number.parseInt(crypto.randomUUID().slice(0, 6), 16),
    id: taskId,
    projectId,
    title: "Test task",
    prompt: "do the thing",
    flowId,
  });

  await db.insert(schema.runs).values({
    id: runId,
    taskId,
    projectId,
    flowId,
    runnerId: executorId,
    capabilityAgent: "claude",
    flowVersion: "v1.0.0",
    status: "Running",
  });

  await db.insert(schema.nodeAttempts).values({
    id: nodeAttemptId,
    runId,
    nodeId: "implement",
    nodeType: "ai_coding",
  });

  return { projectId, runId, nodeAttemptId };
}

interface EventRow {
  id: string;
  type: string;
  project_id: string;
  run_id: string;
  data: Record<string, unknown>;
  payload: Record<string, unknown> | null;
  fanout_at: Date | null;
}

async function eventsForRun(runId: string): Promise<EventRow[]> {
  const result = await db.execute(sql`
    SELECT id, type, project_id, run_id, data, payload, fanout_at
    FROM webhook_events
    WHERE run_id = ${runId}
  `);

  return result.rows as unknown as EventRow[];
}

function expectGateDecided(
  row: EventRow,
  ids: { projectId: string; runId: string; nodeAttemptId: string },
  expected: {
    gateId: string;
    kind: string;
    mode: "blocking" | "advisory";
    status: "passed" | "failed" | "overridden";
  },
): void {
  expect(row.type).toBe("gate.decided");
  expect(row.project_id).toBe(ids.projectId);
  expect(row.run_id).toBe(ids.runId);
  expect(row.payload).toBeNull();
  expect(row.fanout_at).toBeNull();
  expect(row.data).toMatchObject({
    gateId: expected.gateId,
    kind: expected.kind,
    mode: expected.mode,
    status: expected.status,
    nodeAttemptId: ids.nodeAttemptId,
  });
}

// ---------------------------------------------------------------------------
// createGateResult — inserts a gate_results row. When inserted ALREADY-TERMINAL
//   (status passed|failed|overridden) it must emit one gate.decided; a
//   non-terminal insert (running/pending) emits nothing.
// ---------------------------------------------------------------------------
describe("createGateResult (insert-terminal) → gate.decided", () => {
  it("winner: a row inserted at status=passed captures exactly one gate.decided", async () => {
    const ids = await seedRunWithNodeAttempt();

    await createGateResult({
      runId: ids.runId,
      nodeAttemptId: ids.nodeAttemptId,
      gateId: "lint",
      kind: "command_check",
      mode: "blocking",
      status: "passed",
      db,
    });

    const events = await eventsForRun(ids.runId);

    expect(events).toHaveLength(1);
    expectGateDecided(events[0], ids, {
      gateId: "lint",
      kind: "command_check",
      mode: "blocking",
      status: "passed",
    });
  });

  it("loser: a row inserted at status=running emits nothing", async () => {
    const ids = await seedRunWithNodeAttempt();

    await createGateResult({
      runId: ids.runId,
      nodeAttemptId: ids.nodeAttemptId,
      gateId: "lint",
      kind: "command_check",
      mode: "blocking",
      status: "running",
      db,
    });

    expect(await eventsForRun(ids.runId)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// transition helpers on a row created at `running` — each terminal landing
//   (passed|failed|overridden) emits one gate.decided; stale|skipped emit none.
// ---------------------------------------------------------------------------
describe("markGatePassed → gate.decided (status=passed)", () => {
  it("winner: a running gate transitioned to passed captures exactly one gate.decided", async () => {
    const ids = await seedRunWithNodeAttempt();
    const { id } = await createGateResult({
      runId: ids.runId,
      nodeAttemptId: ids.nodeAttemptId,
      gateId: "tests",
      kind: "external_check",
      mode: "blocking",
      status: "running",
      db,
    });

    await markGatePassed(id, undefined, db);

    const events = await eventsForRun(ids.runId);

    expect(events).toHaveLength(1);
    expectGateDecided(events[0], ids, {
      gateId: "tests",
      kind: "external_check",
      mode: "blocking",
      status: "passed",
    });
  });
});

describe("markGateFailed → gate.decided (status=failed)", () => {
  it("winner: a running gate transitioned to failed captures exactly one gate.decided", async () => {
    const ids = await seedRunWithNodeAttempt();
    const { id } = await createGateResult({
      runId: ids.runId,
      nodeAttemptId: ids.nodeAttemptId,
      gateId: "tests",
      kind: "command_check",
      mode: "advisory",
      status: "running",
      db,
    });

    await markGateFailed(id, undefined, db);

    const events = await eventsForRun(ids.runId);

    expect(events).toHaveLength(1);
    expectGateDecided(events[0], ids, {
      gateId: "tests",
      kind: "command_check",
      mode: "advisory",
      status: "failed",
    });
  });
});

describe("markGateOverridden → gate.decided (status=overridden)", () => {
  it("winner: a failed gate overridden by HITL captures exactly one gate.decided", async () => {
    const ids = await seedRunWithNodeAttempt();
    const { id } = await createGateResult({
      runId: ids.runId,
      nodeAttemptId: ids.nodeAttemptId,
      gateId: "tests",
      kind: "human_review",
      mode: "blocking",
      status: "failed",
      db,
    });

    // createGateResult above is insert-terminal (failed) — clear any rows it
    // emits so this assertion isolates the override emit.
    await db.execute(
      sql`DELETE FROM webhook_events WHERE run_id = ${ids.runId}`,
    );

    await markGateOverridden(id, "user-abc", db);

    const events = await eventsForRun(ids.runId);

    expect(events).toHaveLength(1);
    expectGateDecided(events[0], ids, {
      gateId: "tests",
      kind: "human_review",
      mode: "blocking",
      status: "overridden",
    });
  });
});

describe("non-terminal gate transitions emit nothing", () => {
  it("markGateStale on a running gate emits nothing", async () => {
    const ids = await seedRunWithNodeAttempt();
    const { id } = await createGateResult({
      runId: ids.runId,
      nodeAttemptId: ids.nodeAttemptId,
      gateId: "tests",
      kind: "command_check",
      mode: "blocking",
      status: "running",
      db,
    });

    await markGateStale(id, db);

    expect(await eventsForRun(ids.runId)).toHaveLength(0);
  });

  it("markGateSkipped on a running gate emits nothing", async () => {
    const ids = await seedRunWithNodeAttempt();
    const { id } = await createGateResult({
      runId: ids.runId,
      nodeAttemptId: ids.nodeAttemptId,
      gateId: "tests",
      kind: "command_check",
      mode: "advisory",
      status: "running",
      db,
    });

    await markGateSkipped(id, undefined, db);

    expect(await eventsForRun(ids.runId)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// reportExternalGate — ingests a CI verdict, flipping the latest LIVE
//   external_check gate to passed|failed. Seed a `pending` external_check, then
//   report `passed`. The reported flip is a gate.decided. (createGateResult at
//   `pending` is non-terminal → emits nothing, so the report is the sole emit.)
// ---------------------------------------------------------------------------
describe("reportExternalGate → gate.decided", () => {
  it("winner: reporting a pending external_check to passed captures exactly one gate.decided", async () => {
    const ids = await seedRunWithNodeAttempt();

    await createGateResult({
      runId: ids.runId,
      nodeAttemptId: ids.nodeAttemptId,
      gateId: "ci",
      kind: "external_check",
      mode: "blocking",
      status: "pending",
      db,
    });

    await reportExternalGate(
      {
        runId: ids.runId,
        gateId: "ci",
        status: "passed",
        verdict: { commitSha: "abc123" } as never,
      },
      db,
    );

    const events = await eventsForRun(ids.runId);

    expect(events).toHaveLength(1);
    expectGateDecided(events[0], ids, {
      gateId: "ci",
      kind: "external_check",
      mode: "blocking",
      status: "passed",
    });
  });

  // The supersede branch (passed@A + report passed@B, default staleOnNewCommit)
  // re-stales the prior passed row AND createGateResult's a FRESH terminal row.
  // The prime double-emit risk: re-stale must emit nothing, the fresh row emits
  // exactly one gate.decided → count delta == 1. (Re-grep flagged this branch as
  // correct-in-code but unpinned by a test.)
  it("winner: supersede-on-new-commit emits exactly one additional gate.decided (re-stale emits nothing)", async () => {
    const ids = await seedRunWithNodeAttempt();

    await createGateResult({
      runId: ids.runId,
      nodeAttemptId: ids.nodeAttemptId,
      gateId: "ci",
      kind: "external_check",
      mode: "blocking",
      status: "pending",
      db,
    });
    await reportExternalGate(
      {
        runId: ids.runId,
        gateId: "ci",
        status: "passed",
        verdict: { commitSha: "A" } as never,
      },
      db,
    );

    const before = (await eventsForRun(ids.runId)).filter(
      (e) => e.type === "gate.decided",
    ).length;

    await reportExternalGate(
      {
        runId: ids.runId,
        gateId: "ci",
        status: "passed",
        verdict: { commitSha: "B" } as never,
      },
      db,
    );

    const decided = (await eventsForRun(ids.runId)).filter(
      (e) => e.type === "gate.decided",
    );

    expect(decided.length - before).toBe(1);

    const fresh = decided[decided.length - 1];

    expectGateDecided(fresh, ids, {
      gateId: "ci",
      kind: "external_check",
      mode: "blocking",
      status: "passed",
    });
  });
});
