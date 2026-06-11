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

import { runWebhookDeliveryJob } from "@/lib/scheduler/handlers/webhook-delivery";
// FIXME(any): drizzle-orm dual peer-dep variants — runtime works, cast silences
// the type-only clash (matches delivery.integration.test.ts).
import * as fullSchema from "@/lib/db/schema";
import { testPlatformRunnerRow } from "@/lib/__tests__/runner-fixtures";

// =============================================================================
// T17 — outbox retention prune (TDD red).
//
// The outbox grows on EVERY taxonomy transition. Events that matched NO
// subscription get `fanout_at` set but spawn zero `webhook_deliveries` — those
// must be pruned after 7d or the table grows forever. Events referenced by ANY
// delivery are KEPT FOREVER (replay/audit).
//
// `runWebhookDeliveryJob` must run a prune tail-pass (after drain, before
// returning; NOT when skipped:"disabled") that DELETEs `webhook_events` with
// `fanout_at` older than a fixed 7d AND no referencing `webhook_deliveries`,
// and reports the deleted count as `summary.pruned`.
//
// RED now: the handler has no prune pass and no `pruned` field — the old
// zero-delivery event survives and `summary.pruned` is undefined.
// =============================================================================

const schema = fullSchema as unknown as Record<string, any>;

const DAY_MS = 24 * 60 * 60 * 1000;

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;

// ---------------------------------------------------------------------------
// Seed helper — a run + its FK ancestry so webhook_events (NOT NULL project_id,
// run_id) can be inserted. Mirrors delivery.integration.test.ts seedRun.
// ---------------------------------------------------------------------------

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
    status: "Review",
  });

  return { projectId, runId };
}

// Seed a webhook_events row directly with a controlled fanout_at. A null
// fanoutAt models a never-fanned-out event; a past Date models an aged one.
interface SeedEventOpts {
  run: SeededRun;
  fanoutAt: Date | null;
}

async function seedEvent(opts: SeedEventOpts): Promise<string> {
  const eventId = randomUUID();

  await db.insert(schema.webhookEvents).values({
    id: eventId,
    projectId: opts.run.projectId,
    runId: opts.run.runId,
    type: "run.review",
    data: { runId: opts.run.runId },
    occurredAt: new Date(),
    fanoutAt: opts.fanoutAt,
  });

  return eventId;
}

async function seedSubscription(projectId: string): Promise<string> {
  const subId = randomUUID();

  await db.insert(schema.webhookSubscriptions).values({
    id: subId,
    projectId,
    name: `sub-${subId.slice(0, 8)}`,
    url: "http://127.0.0.1:1/never",
    eventTypes: ["run.review"],
    signingSecretRef: "env:WH_TEST_SECRET",
    enabled: true,
  });

  return subId;
}

// Attach a delivery row to an event so it counts as delivery-referenced. Status
// `delivered` so the drain pass leaves it untouched (no re-send of a dead URL).
async function seedDelivery(eventId: string, subId: string): Promise<void> {
  await db.insert(schema.webhookDeliveries).values({
    id: randomUUID(),
    eventId,
    subscriptionId: subId,
    status: "delivered",
    attemptCount: 1,
    nextAttemptAt: new Date(),
    idempotencyKey: randomUUID(),
  });
}

async function eventExists(eventId: string): Promise<boolean> {
  const r = await db.execute(sql`
    SELECT 1 FROM webhook_events WHERE id = ${eventId}
  `);

  return r.rows.length > 0;
}

async function setWebhooksEnabled(enabled: boolean): Promise<void> {
  const runnerId = randomUUID();

  await db
    .insert(schema.platformAcpRunners)
    .values(testPlatformRunnerRow(runnerId, "claude"));

  await db.execute(sql`
    INSERT INTO platform_runtime_settings (id, default_runner_id, webhooks_enabled)
    VALUES ('singleton', ${runnerId}, ${enabled})
    ON CONFLICT (id) DO UPDATE SET webhooks_enabled = ${enabled}
  `);
}

// ---------------------------------------------------------------------------
// Lifecycle.
// ---------------------------------------------------------------------------

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

  process.env.WH_TEST_SECRET = "whsec_test_0123456789abcdef";
  // The 127.0.0.1 stub is a blocked loopback destination under the egress
  // policy — exempt it the way an operator exempts a local consumer.
  process.env.MAISTER_WEBHOOK_ALLOW_HOSTS = "127.0.0.1";

  // Kill-switch ON so the prune tail-pass runs.
  await setWebhooksEnabled(true);
});

// ===========================================================================
// 1. zero-delivery event fanned out 8 days ago -> pruned.
// ===========================================================================

describe("zero-delivery event older than 7d", () => {
  it("prunes the event and reports it in the summary", async () => {
    const run = await seedRun();
    const oldEventId = await seedEvent({
      run,
      fanoutAt: new Date(Date.now() - 8 * DAY_MS),
    });

    const summary = await runWebhookDeliveryJob({ db });

    expect(await eventExists(oldEventId)).toBe(false);
    expect(summary.pruned).toBeGreaterThanOrEqual(1);
  });
});

// ===========================================================================
// 2. event older than 7d that HAS a delivery -> kept (replay/audit). Proves
//    the NOT EXISTS guard protects every delivery-referenced event.
// ===========================================================================

describe("aged event with a delivery", () => {
  it("keeps an event referenced by any delivery, regardless of age", async () => {
    const run = await seedRun();
    const subId = await seedSubscription(run.projectId);
    const referencedEventId = await seedEvent({
      run,
      fanoutAt: new Date(Date.now() - 8 * DAY_MS),
    });

    await seedDelivery(referencedEventId, subId);

    await runWebhookDeliveryJob({ db });

    expect(await eventExists(referencedEventId)).toBe(true);
  });
});

// ===========================================================================
// 3. fresh zero-delivery event (1 day ago) -> kept (within the 7d window).
// ===========================================================================

describe("fresh zero-delivery event", () => {
  it("keeps a zero-delivery event fanned out within the last 7 days", async () => {
    const run = await seedRun();
    const freshEventId = await seedEvent({
      run,
      fanoutAt: new Date(Date.now() - 1 * DAY_MS),
    });

    await runWebhookDeliveryJob({ db });

    expect(await eventExists(freshEventId)).toBe(true);
  });
});

// ===========================================================================
// 4. never-fanned-out event (fanout_at IS NULL) -> kept, no matter how old.
//    The prune predicate is gated on fanout_at IS NOT NULL; an un-fanned event
//    must never be deleted out from under the fanout pass.
// ===========================================================================

describe("never-fanned-out event", () => {
  it("never prunes an event whose fanout_at is null", async () => {
    const run = await seedRun();

    // created_at defaults to now(), but force an aged row to prove the guard is
    // on fanout_at, not created_at: a stale UNFANNED event still survives.
    const unfannedEventId = await seedEvent({ run, fanoutAt: null });

    await db.execute(sql`
      UPDATE webhook_events
      SET created_at = ${new Date(Date.now() - 30 * DAY_MS)}
      WHERE id = ${unfannedEventId}
    `);

    await runWebhookDeliveryJob({ db });

    expect(await eventExists(unfannedEventId)).toBe(true);
  });
});
