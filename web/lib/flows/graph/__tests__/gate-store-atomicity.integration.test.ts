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
// the type-only clash (matches emit-gate.integration.test.ts).
import * as fullSchema from "@/lib/db/schema";
import { testPlatformRunnerRow } from "@/lib/__tests__/runner-fixtures";

// =============================================================================
// ADR-076 atomicity + idempotency for `transition()` AND the insert-at-terminal
// path of `createGateResult` in gate-store:
//
//   - ATOMICITY: the gate_results write and the gate.decided outbox INSERT
//     commit in ONE transaction. If the emit fails, the write must roll back —
//     both-or-neither, so a retry re-runs the whole transition. (Previously two
//     autocommit statements: a crash between them flipped the gate but lost the
//     event forever.)
//   - IDEMPOTENCY (CAS): a repeat transition to the SAME status updates 0 rows
//     and emits nothing — a double markGatePassed captures exactly one
//     gate.decided. Cross-status moves (failed → overridden) still emit.
// =============================================================================

const schema = fullSchema as unknown as Record<string, any>;

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;

let failNextEmit = false;

vi.mock("@/lib/db/client", () => ({
  getDb: () => db,
}));

// Passthrough wrapper around the real outbox — `failNextEmit` injects a single
// failure INSIDE the transition's transaction to prove the flip rolls back.
vi.mock("@/lib/webhooks/outbox", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/webhooks/outbox")>();

  return {
    ...actual,
    emitWebhookEvent: (input: unknown) => {
      if (failNextEmit) {
        failNextEmit = false;
        throw new Error("emit failed (test-injected)");
      }

      return actual.emitWebhookEvent(input as never);
    },
  };
});

let createGateResult: typeof import("@/lib/flows/graph/gate-store").createGateResult;
let markGatePassed: typeof import("@/lib/flows/graph/gate-store").markGatePassed;
let markGateFailed: typeof import("@/lib/flows/graph/gate-store").markGateFailed;
let markGateOverridden: typeof import("@/lib/flows/graph/gate-store").markGateOverridden;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("maister_test")
    .withUsername("test")
    .withPassword("test")
    .start();

  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);

  await migrate(db, { migrationsFolder: "./lib/db/migrations" });

  ({ createGateResult, markGatePassed, markGateFailed, markGateOverridden } =
    await import("@/lib/flows/graph/gate-store"));
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

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

async function gateStatus(id: string): Promise<string> {
  const r = await db.execute(sql`
    SELECT status FROM gate_results WHERE id = ${id}
  `);

  return (r.rows[0] as { status: string }).status;
}

async function decidedEventCount(runId: string): Promise<number> {
  const r = await db.execute(sql`
    SELECT count(*)::int AS n FROM webhook_events
    WHERE run_id = ${runId} AND type = 'gate.decided'
  `);

  return (r.rows[0] as { n: number }).n;
}

describe("transition atomicity — flip + emit are both-or-neither", () => {
  it("a failed emit rolls back the status flip (no flipped gate without its event)", async () => {
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

    failNextEmit = true;

    await expect(markGatePassed(id, undefined, db)).rejects.toThrow(
      "emit failed (test-injected)",
    );

    expect(await gateStatus(id)).toBe("running");
    expect(await decidedEventCount(ids.runId)).toBe(0);

    // The transition is retryable after the failure: the retry flips AND emits.
    await markGatePassed(id, undefined, db);

    expect(await gateStatus(id)).toBe("passed");
    expect(await decidedEventCount(ids.runId)).toBe(1);
  });
});

describe("createGateResult insert-at-terminal atomicity — row + emit are both-or-neither", () => {
  it("a failed emit rolls back the terminal insert (reportExternalGate supersede shape)", async () => {
    const ids = await seedRunWithNodeAttempt();

    failNextEmit = true;

    await expect(
      createGateResult({
        runId: ids.runId,
        nodeAttemptId: ids.nodeAttemptId,
        gateId: "ci",
        kind: "external_check",
        mode: "blocking",
        status: "passed",
        db,
      }),
    ).rejects.toThrow("emit failed (test-injected)");

    const rows = await db.execute(sql`
      SELECT count(*)::int AS n FROM gate_results WHERE run_id = ${ids.runId}
    `);

    expect((rows.rows[0] as { n: number }).n).toBe(0);
    expect(await decidedEventCount(ids.runId)).toBe(0);

    // The insert is retryable after the failure: the retry inserts AND emits.
    const { id } = await createGateResult({
      runId: ids.runId,
      nodeAttemptId: ids.nodeAttemptId,
      gateId: "ci",
      kind: "external_check",
      mode: "blocking",
      status: "passed",
      db,
    });

    expect(await gateStatus(id)).toBe("passed");
    expect(await decidedEventCount(ids.runId)).toBe(1);
  });
});

describe("transition idempotency — same-status CAS", () => {
  it("a double markGatePassed captures exactly one gate.decided", async () => {
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

    await markGatePassed(id, undefined, db);
    await markGatePassed(id, undefined, db);

    expect(await gateStatus(id)).toBe("passed");
    expect(await decidedEventCount(ids.runId)).toBe(1);
  });

  it("failed → overridden still moves and emits (CAS is same-status only)", async () => {
    const ids = await seedRunWithNodeAttempt();
    const { id } = await createGateResult({
      runId: ids.runId,
      nodeAttemptId: ids.nodeAttemptId,
      gateId: "review",
      kind: "human_review",
      mode: "blocking",
      status: "running",
      db,
    });

    await markGateFailed(id, undefined, db);

    expect(await decidedEventCount(ids.runId)).toBe(1);

    await markGateOverridden(id, "user-abc", db);

    expect(await gateStatus(id)).toBe("overridden");
    expect(await decidedEventCount(ids.runId)).toBe(2);

    const r = await db.execute(sql`
      SELECT overridden_by FROM gate_results WHERE id = ${id}
    `);

    expect((r.rows[0] as { overridden_by: string }).overridden_by).toBe(
      "user-abc",
    );
  });
});
