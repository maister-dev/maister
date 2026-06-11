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

// FIXME(any): drizzle-orm dual peer-dep variants — runtime works, cast silences
// the type-only clash (matches schema.integration.test.ts).
import * as fullSchema from "@/lib/db/schema";
import { testPlatformRunnerRow } from "@/lib/__tests__/runner-fixtures";

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
  });

  return { projectId, runId };
}

async function tableColumns(table: string): Promise<string[]> {
  const result = await db.execute(sql`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_name = ${table}
    ORDER BY ordinal_position
  `);

  return (result.rows as Array<{ column_name: string }>).map(
    (r) => r.column_name,
  );
}

describe("webhook tables exist", () => {
  it("webhook_subscriptions has the expected columns", async () => {
    const cols = await tableColumns("webhook_subscriptions");

    expect(cols).toEqual(
      expect.arrayContaining([
        "id",
        "project_id",
        "name",
        "url",
        "method",
        "headers",
        "event_types",
        "signing_secret_ref",
        "secondary_signing_secret_ref",
        "enabled",
        "created_at",
        "updated_at",
      ]),
    );
  });

  it("webhook_events has the expected columns including nullable payload/fanout_at", async () => {
    const cols = await tableColumns("webhook_events");

    expect(cols).toEqual(
      expect.arrayContaining([
        "id",
        "project_id",
        "run_id",
        "type",
        "data",
        "payload",
        "occurred_at",
        "fanout_at",
        "created_at",
      ]),
    );
  });

  it("webhook_deliveries has the expected columns", async () => {
    const cols = await tableColumns("webhook_deliveries");

    expect(cols).toEqual(
      expect.arrayContaining([
        "id",
        "event_id",
        "subscription_id",
        "status",
        "attempt_count",
        "next_attempt_at",
        "lease_expires_at",
        "idempotency_key",
        "last_http_status",
        "last_error_kind",
        "last_error_message",
        "delivered_at",
        "created_at",
        "updated_at",
      ]),
    );
  });

  it("webhook_delivery_attempts has the expected columns", async () => {
    const cols = await tableColumns("webhook_delivery_attempts");

    expect(cols).toEqual(
      expect.arrayContaining([
        "id",
        "delivery_id",
        "attempt_no",
        "requested_at",
        "duration_ms",
        "http_status",
        "error_kind",
        "error_detail",
        "response_snippet",
      ]),
    );
  });
});

describe("webhook insert + FK chain", () => {
  it("accepts a full subscription→event→delivery→attempt chain", async () => {
    const { projectId, runId } = await seedRun();
    const subId = randomUUID();
    const eventId = randomUUID();
    const deliveryId = randomUUID();
    const attemptId = randomUUID();

    await db.insert(schema.webhookSubscriptions).values({
      id: subId,
      projectId,
      name: "test sub",
      url: "https://example.test/hook",
      eventTypes: ["run.started", "run.done"],
      signingSecretRef: "env:WEBHOOK_SECRET",
    });

    await db.insert(schema.webhookEvents).values({
      id: eventId,
      projectId,
      runId,
      type: "run.started",
      data: { runId },
      occurredAt: new Date(),
    });

    await db.insert(schema.webhookDeliveries).values({
      id: deliveryId,
      eventId,
      subscriptionId: subId,
      nextAttemptAt: new Date(),
      idempotencyKey: `${subId}:${eventId}`,
    });

    await db.insert(schema.webhookDeliveryAttempts).values({
      id: attemptId,
      deliveryId,
      attemptNo: 1,
      requestedAt: new Date(),
      durationMs: 42,
    });

    const counts = await db.execute(sql`
      SELECT
        (SELECT count(*)::int FROM webhook_subscriptions WHERE id = ${subId}) AS subs,
        (SELECT count(*)::int FROM webhook_events WHERE id = ${eventId}) AS events,
        (SELECT count(*)::int FROM webhook_deliveries WHERE id = ${deliveryId}) AS deliveries,
        (SELECT count(*)::int FROM webhook_delivery_attempts WHERE id = ${attemptId}) AS attempts
    `);

    expect(counts.rows[0]).toEqual({
      subs: 1,
      events: 1,
      deliveries: 1,
      attempts: 1,
    });
  });

  it("allows a platform-scope subscription with NULL project_id", async () => {
    const subId = randomUUID();

    await expect(
      db.insert(schema.webhookSubscriptions).values({
        id: subId,
        name: "platform sub",
        url: "https://example.test/platform",
        eventTypes: ["*"],
        signingSecretRef: "env:PLATFORM_SECRET",
      }),
    ).resolves.toBeDefined();
  });

  it("defaults method=POST, status=pending, enabled=true", async () => {
    const { projectId, runId } = await seedRun();
    const subId = randomUUID();
    const eventId = randomUUID();
    const deliveryId = randomUUID();

    await db.insert(schema.webhookSubscriptions).values({
      id: subId,
      projectId,
      name: "defaults sub",
      url: "https://example.test/defaults",
      eventTypes: ["run.started"],
      signingSecretRef: "env:S",
    });
    await db.insert(schema.webhookEvents).values({
      id: eventId,
      projectId,
      runId,
      type: "run.started",
      data: {},
      occurredAt: new Date(),
    });
    await db.insert(schema.webhookDeliveries).values({
      id: deliveryId,
      eventId,
      subscriptionId: subId,
      nextAttemptAt: new Date(),
      idempotencyKey: `${subId}:${eventId}`,
    });

    const row = await db.execute(sql`
      SELECT s.method, s.enabled, s.headers, d.status, d.attempt_count
      FROM webhook_subscriptions s
      JOIN webhook_deliveries d ON d.subscription_id = s.id
      WHERE s.id = ${subId}
    `);

    expect(row.rows[0]).toEqual({
      method: "POST",
      enabled: true,
      headers: {},
      status: "pending",
      attempt_count: 0,
    });
  });
});

describe("webhook UNIQUE constraints", () => {
  it("rejects a duplicate (subscription_id, event_id) delivery", async () => {
    const { projectId, runId } = await seedRun();
    const subId = randomUUID();
    const eventId = randomUUID();

    await db.insert(schema.webhookSubscriptions).values({
      id: subId,
      projectId,
      name: "uq sub",
      url: "https://example.test/uq",
      eventTypes: ["run.started"],
      signingSecretRef: "env:S",
    });
    await db.insert(schema.webhookEvents).values({
      id: eventId,
      projectId,
      runId,
      type: "run.started",
      data: {},
      occurredAt: new Date(),
    });
    await db.insert(schema.webhookDeliveries).values({
      id: randomUUID(),
      eventId,
      subscriptionId: subId,
      nextAttemptAt: new Date(),
      idempotencyKey: `${subId}:${eventId}`,
    });

    await expect(
      db.insert(schema.webhookDeliveries).values({
        id: randomUUID(),
        eventId,
        subscriptionId: subId,
        nextAttemptAt: new Date(),
        idempotencyKey: `${subId}:${eventId}`,
      }),
    ).rejects.toThrow();
  });

  it("rejects a duplicate (delivery_id, attempt_no) attempt", async () => {
    const { projectId, runId } = await seedRun();
    const subId = randomUUID();
    const eventId = randomUUID();
    const deliveryId = randomUUID();

    await db.insert(schema.webhookSubscriptions).values({
      id: subId,
      projectId,
      name: "uq sub 2",
      url: "https://example.test/uq2",
      eventTypes: ["run.started"],
      signingSecretRef: "env:S",
    });
    await db.insert(schema.webhookEvents).values({
      id: eventId,
      projectId,
      runId,
      type: "run.started",
      data: {},
      occurredAt: new Date(),
    });
    await db.insert(schema.webhookDeliveries).values({
      id: deliveryId,
      eventId,
      subscriptionId: subId,
      nextAttemptAt: new Date(),
      idempotencyKey: `${subId}:${eventId}`,
    });
    await db.insert(schema.webhookDeliveryAttempts).values({
      id: randomUUID(),
      deliveryId,
      attemptNo: 1,
      requestedAt: new Date(),
      durationMs: 1,
    });

    await expect(
      db.insert(schema.webhookDeliveryAttempts).values({
        id: randomUUID(),
        deliveryId,
        attemptNo: 1,
        requestedAt: new Date(),
        durationMs: 2,
      }),
    ).rejects.toThrow();
  });
});

describe("webhook cascade chain", () => {
  it("deleting a subscription cascades its deliveries and attempts", async () => {
    const { projectId, runId } = await seedRun();
    const subId = randomUUID();
    const eventId = randomUUID();
    const deliveryId = randomUUID();
    const attemptId = randomUUID();

    await db.insert(schema.webhookSubscriptions).values({
      id: subId,
      projectId,
      name: "cascade sub",
      url: "https://example.test/cascade",
      eventTypes: ["run.started"],
      signingSecretRef: "env:S",
    });
    await db.insert(schema.webhookEvents).values({
      id: eventId,
      projectId,
      runId,
      type: "run.started",
      data: {},
      occurredAt: new Date(),
    });
    await db.insert(schema.webhookDeliveries).values({
      id: deliveryId,
      eventId,
      subscriptionId: subId,
      nextAttemptAt: new Date(),
      idempotencyKey: `${subId}:${eventId}`,
    });
    await db.insert(schema.webhookDeliveryAttempts).values({
      id: attemptId,
      deliveryId,
      attemptNo: 1,
      requestedAt: new Date(),
      durationMs: 1,
    });

    await db.execute(
      sql`DELETE FROM webhook_subscriptions WHERE id = ${subId}`,
    );

    const remaining = await db.execute(sql`
      SELECT
        (SELECT count(*)::int FROM webhook_deliveries WHERE id = ${deliveryId}) AS deliveries,
        (SELECT count(*)::int FROM webhook_delivery_attempts WHERE id = ${attemptId}) AS attempts
    `);

    expect(remaining.rows[0]).toEqual({ deliveries: 0, attempts: 0 });
  });

  it("deleting a project cascades its webhook_events", async () => {
    const { projectId, runId } = await seedRun();
    const eventId = randomUUID();

    await db.insert(schema.webhookEvents).values({
      id: eventId,
      projectId,
      runId,
      type: "run.started",
      data: {},
      occurredAt: new Date(),
    });

    await db.execute(sql`DELETE FROM projects WHERE id = ${projectId}`);

    const remaining = await db.execute(
      sql`SELECT count(*)::int AS c FROM webhook_events WHERE id = ${eventId}`,
    );

    expect((remaining.rows[0] as { c: number }).c).toBe(0);
  });
});

describe("platform_runtime_settings.webhooks_enabled", () => {
  it("exists and defaults to true", async () => {
    const cols = await tableColumns("platform_runtime_settings");

    expect(cols).toContain("webhooks_enabled");

    const runnerId = randomUUID();

    await db
      .insert(schema.platformAcpRunners)
      .values(testPlatformRunnerRow(runnerId, "claude"));

    await db.insert(schema.platformRuntimeSettings).values({
      id: `settings-${runnerId.slice(0, 8)}`,
      defaultRunnerId: runnerId,
    });

    const row = await db.execute(sql`
      SELECT webhooks_enabled
      FROM platform_runtime_settings
      WHERE id = ${`settings-${runnerId.slice(0, 8)}`}
    `);

    expect(
      (row.rows[0] as { webhooks_enabled: boolean }).webhooks_enabled,
    ).toBe(true);
  });
});
