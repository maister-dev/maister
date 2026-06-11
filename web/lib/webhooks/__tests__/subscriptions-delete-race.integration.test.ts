import { randomUUID } from "node:crypto";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { deleteSubscription } from "@/lib/webhooks/subscriptions";
import { isMaisterError } from "@/lib/errors";
// FIXME(any): drizzle-orm dual peer-dep variants — runtime works, cast silences
// the type-only clash (matches replay.integration.test.ts).
import * as fullSchema from "@/lib/db/schema";
import { testPlatformRunnerRow } from "@/lib/__tests__/runner-fixtures";

// =============================================================================
// Usage-guarded delete vs concurrent fanout (codex finding #1).
//
// The FK webhook_deliveries.subscription_id is ON DELETE CASCADE, so the
// usage-guard (SELECT deliveries → DELETE sub) executed as two autocommit
// statements loses a racing fanout INSERT: the INSERT lands in the gap and the
// cascade erases the append-only audit row. The fixed deleteSubscription runs
// one transaction with the subscription row locked FOR UPDATE — the fanout
// INSERT's FOR KEY SHARE on the parent row serializes against it, so the
// usage check always sees a settled ledger.
//
// The race is made deterministic by holding an UNCOMMITTED delivery INSERT
// (the in-flight fanout) while the delete runs: the unfixed delete's unlocked
// usage check sees nothing, then its DELETE queues behind the FK lock and
// cascades the freshly committed audit row away.
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

beforeEach(async () => {
  await db.execute(sql`
    TRUNCATE webhook_subscriptions, webhook_events, webhook_deliveries,
             webhook_delivery_attempts RESTART IDENTITY CASCADE
  `);
});

interface SeededRun {
  projectId: string;
  runId: string;
}

async function seedRun(): Promise<SeededRun> {
  const projectId = randomUUID();
  const executorId = randomUUID();
  const flowId = randomUUID();
  const taskId = randomUUID();
  const runId = randomUUID();
  const slug = `proj-${projectId.slice(0, 8)}`;

  await db.insert(schema.projects).values({
    taskKey: `T${crypto.randomUUID().slice(0, 8)}`.toUpperCase(),
    id: projectId,
    slug,
    name: `Project ${projectId.slice(0, 8)}`,
    repoPath: `/tmp/${slug}`,
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
    status: "Review",
  });

  return { projectId, runId };
}

async function seedSubscription(run: SeededRun): Promise<string> {
  const subId = randomUUID();

  await db.insert(schema.webhookSubscriptions).values({
    id: subId,
    projectId: run.projectId,
    name: `sub-${subId.slice(0, 8)}`,
    url: "https://example.com/hook",
    eventTypes: ["run.review"],
    signingSecretRef: "env:WH_TEST_SECRET",
    enabled: true,
  });

  return subId;
}

async function seedEvent(run: SeededRun): Promise<string> {
  const eventId = randomUUID();

  await db.insert(schema.webhookEvents).values({
    id: eventId,
    projectId: run.projectId,
    runId: run.runId,
    type: "run.review",
    data: { runId: run.runId },
    occurredAt: new Date(),
  });

  return eventId;
}

async function countRows(table: string, subId: string): Promise<number> {
  const r = await db.execute(sql`
    SELECT count(*)::int AS n FROM ${sql.raw(table)}
    WHERE ${sql.raw(table === "webhook_subscriptions" ? "id" : "subscription_id")} = ${subId}
  `);

  return (r.rows[0] as { n: number }).n;
}

describe("deleteSubscription vs concurrent fanout INSERT", () => {
  it("refuses with CONFLICT and preserves the racing audit row", async () => {
    const run = await seedRun();
    const eventId = await seedEvent(run);
    const subId = await seedSubscription(run);

    const racer = await pool.connect();

    try {
      // In-flight fanout: the INSERT holds FOR KEY SHARE on the subscription
      // row until COMMIT.
      await racer.query("BEGIN");
      await racer.query(
        `INSERT INTO webhook_deliveries (
           id, event_id, subscription_id, status, attempt_count,
           next_attempt_at, idempotency_key
         ) VALUES ($1, $2, $3, 'pending', 0, now(), $4)`,
        [randomUUID(), eventId, subId, `key-${subId.slice(0, 8)}`],
      );

      const racingDelete = deleteSubscription(
        { projectId: run.projectId },
        subId,
        db,
      ).then(
        (value) => ({ outcome: "resolved" as const, value }),
        (err) => ({ outcome: "rejected" as const, err }),
      );

      // Let the delete reach the lock wait before the fanout commits.
      await new Promise((resolve) => setTimeout(resolve, 200));
      await racer.query("COMMIT");

      const settled = await racingDelete;

      expect(settled.outcome).toBe("rejected");

      const err = (settled as { err: unknown }).err;

      expect(isMaisterError(err)).toBe(true);
      expect((err as { code?: string }).code).toBe("CONFLICT");
    } finally {
      racer.release();
    }

    expect(await countRows("webhook_subscriptions", subId)).toBe(1);
    expect(await countRows("webhook_deliveries", subId)).toBe(1);
  });

  it("still hard-deletes a never-delivered subscription", async () => {
    const run = await seedRun();
    const subId = await seedSubscription(run);

    const deleted = await deleteSubscription(
      { projectId: run.projectId },
      subId,
      db,
    );

    expect(deleted).toBe(true);
    expect(await countRows("webhook_subscriptions", subId)).toBe(0);
  });

  it("returns false for a subscription outside the scope", async () => {
    const run = await seedRun();
    const subId = await seedSubscription(run);

    const deleted = await deleteSubscription({ projectId: null }, subId, db);

    expect(deleted).toBe(false);
    expect(await countRows("webhook_subscriptions", subId)).toBe(1);
  });
});
