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

import { emitWebhookEvent } from "@/lib/webhooks/outbox";
// FIXME(any): drizzle-orm dual peer-dep variants — runtime works, cast silences
// the type-only clash (matches webhooks-schema.integration.test.ts).
import * as fullSchema from "@/lib/db/schema";
import { testPlatformRunnerRow } from "@/lib/__tests__/runner-fixtures";

// =============================================================================
// T5 — outbound-webhooks outbox emit (TDD red).
//
// Pins emitWebhookEvent from docs/system-analytics/outbound-webhooks.md
// ("(a) Capture — same-transaction outbox INSERT"):
//   - ONE INSERT of the minimal record into webhook_events
//     { id, project_id, run_id, type, data, payload=NULL, occurred_at,
//       fanout_at=NULL }; no reads/joins on the write path.
//   - returns the new event id.
//   - inserts on whatever handle it is given (plain db OR a tx) so the capture
//     rides the caller's transaction and rolls back WITH it (DQ1 invariant).
//   - occurredAt defaults to now() when omitted; override is honored.
//   Module `@/lib/webhooks/outbox` does not exist yet — this MUST fail with
//   module-not-found until it lands verbatim. The testcontainers boot below
//   should succeed regardless.
// =============================================================================

const schema = fullSchema as unknown as Record<string, any>;

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;

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

async function seedRun(): Promise<{ projectId: string; runId: string }> {
  const projectId = randomUUID();
  const executorId = randomUUID();
  const flowId = randomUUID();
  const taskId = randomUUID();
  const runId = randomUUID();

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
  });

  return { projectId, runId };
}

interface EventRow {
  id: string;
  type: string;
  project_id: string;
  run_id: string;
  data: Record<string, unknown>;
  payload: Record<string, unknown> | null;
  occurred_at: Date | null;
  fanout_at: Date | null;
  created_at: Date | null;
}

async function fetchEvent(eventId: string): Promise<EventRow | undefined> {
  const result = await db.execute(sql`
    SELECT id, type, project_id, run_id, data, payload,
           occurred_at, fanout_at, created_at
    FROM webhook_events
    WHERE id = ${eventId}
  `);

  return result.rows[0] as unknown as EventRow | undefined;
}

async function countEvents(eventId: string): Promise<number> {
  const result = await db.execute(
    sql`SELECT count(*)::int AS c FROM webhook_events WHERE id = ${eventId}`,
  );

  return (result.rows[0] as { c: number }).c;
}

describe("emitWebhookEvent — plain db handle", () => {
  it("inserts exactly one minimal row with payload/fanout_at NULL and returns its id", async () => {
    const { projectId, runId } = await seedRun();
    const data = { runId, foo: "bar" };

    const eventId = await emitWebhookEvent({
      db,
      type: "run.done",
      projectId,
      runId,
      data,
    });

    expect(typeof eventId).toBe("string");
    expect(eventId.length).toBeGreaterThan(0);

    const row = await fetchEvent(eventId);

    expect(row).toBeDefined();
    expect(row?.id).toBe(eventId);
    expect(row?.type).toBe("run.done");
    expect(row?.project_id).toBe(projectId);
    expect(row?.run_id).toBe(runId);
    expect(row?.data).toEqual(data);
    expect(row?.payload).toBeNull();
    expect(row?.fanout_at).toBeNull();
    expect(row?.occurred_at).not.toBeNull();
    expect(
      Number.isNaN(new Date(row?.occurred_at as unknown as string).getTime()),
    ).toBe(false);
    expect(row?.created_at).not.toBeNull();
    expect(
      Number.isNaN(new Date(row?.created_at as unknown as string).getTime()),
    ).toBe(false);
  });
});

describe("emitWebhookEvent — transaction composition", () => {
  it("a committed tx persists the row", async () => {
    const { projectId, runId } = await seedRun();

    let eventId = "";

    await db.transaction(async (tx) => {
      eventId = await emitWebhookEvent({
        db: tx,
        type: "run.started",
        projectId,
        runId,
        data: { runId },
      });
    });

    expect(await countEvents(eventId)).toBe(1);
  });

  it("a rolled-back tx leaves no row (same-tx capture invariant)", async () => {
    const { projectId, runId } = await seedRun();

    let eventId = "";

    await expect(
      db.transaction(async (tx) => {
        eventId = await emitWebhookEvent({
          db: tx,
          type: "run.failed",
          projectId,
          runId,
          data: { runId },
        });
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");

    expect(eventId.length).toBeGreaterThan(0);
    expect(await countEvents(eventId)).toBe(0);
  });
});

describe("emitWebhookEvent — occurredAt", () => {
  it("honors an explicit occurredAt override", async () => {
    const { projectId, runId } = await seedRun();
    const occurredAt = new Date("2020-01-02T03:04:05.000Z");

    const eventId = await emitWebhookEvent({
      db,
      type: "run.promoted",
      projectId,
      runId,
      data: {},
      occurredAt,
    });

    const row = await fetchEvent(eventId);

    expect(row?.occurred_at).not.toBeNull();
    expect(new Date(row?.occurred_at as unknown as string).toISOString()).toBe(
      occurredAt.toISOString(),
    );
  });
});
