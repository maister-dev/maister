/**
 * ADR-173 — the widened outbound-webhook engine.
 *
 * `IT-EDGE-NTF-03` is a REGRESSION guard, and the only honest way to run one is
 * green-before and green-after: it is written and run against the un-widened
 * tree first (proving it exercises the project-scoped path rather than passing
 * vacuously), then re-run after the ADR-173 widening makes `webhook_events.project_id`
 * and `.run_id` nullable. A guard that was never green before the change cannot
 * tell a regression from a test that never worked.
 *
 * `IT-NTF-02` and `IT-NTF-03` are the new behaviour: a project-less, run-less
 * event reaching every reader, and scope matching in BOTH directions.
 */

import { createHmac, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { type AddressInfo } from "node:net";

import { sql } from "drizzle-orm";
import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";

import { runWebhookDeliveryJob } from "@/lib/scheduler/handlers/webhook-delivery";
// FIXME(any): drizzle-orm dual peer-dep variants — runtime works, the cast
// silences the type-only clash (matches delivery.integration.test.ts).
import * as fullSchema from "@/lib/db/schema";
import { testPlatformRunnerRow } from "@/lib/__tests__/runner-fixtures";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

const schema = fullSchema as unknown as Record<string, any>;

const SECRET = "whsec_user_scoped_0123456789abcdef";
const ENV_KEYS = ["WH_TEST_SECRET", "MAISTER_WEBHOOK_ALLOW_HOSTS"] as const;

let testDatabase: StartedPostgresTestDb;
let db: NodePgDatabase;
let savedEnv: Record<string, string | undefined> = {};
let stub: HttpStub;

interface CapturedRequest {
  headers: Record<string, string>;
  rawBody: string;
}

interface HttpStub {
  url: string;
  requests: CapturedRequest[];
  setStatus(status: number): void;
  close(): Promise<void>;
}

async function startStub(): Promise<HttpStub> {
  let status = 200;
  const requests: CapturedRequest[] = [];
  const server: Server = createServer((req, res) => {
    req.setEncoding("utf8");
    let rawBody = "";

    req.on("data", (c: string) => {
      rawBody += c;
    });
    req.on("end", () => {
      const headers: Record<string, string> = {};

      for (const [k, v] of Object.entries(req.headers)) {
        headers[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : (v ?? "");
      }
      requests.push({ headers, rawBody });
      res.statusCode = status;
      res.end("ok");
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`,
    requests,
    setStatus(next) {
      status = next;
    },
    close() {
      return new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    },
  };
}

interface SeededRun {
  projectId: string;
  projectSlug: string;
  runId: string;
}

async function seedRun(): Promise<SeededRun> {
  const projectId = randomUUID();
  const runnerId = randomUUID();
  const flowId = randomUUID();
  const taskId = randomUUID();
  const runId = randomUUID();
  const slug = `proj-${projectId.slice(0, 8)}`;

  await db.insert(schema.projects).values({
    taskKey: `T${randomUUID().slice(0, 8)}`.toUpperCase(),
    id: projectId,
    slug,
    name: `Project ${slug}`,
    repoPath: `/tmp/${slug}`,
    maisterYamlPath: "/tmp/m.yaml",
  });
  await db
    .insert(schema.platformAcpRunners)
    .values(testPlatformRunnerRow(runnerId, "claude"));
  await db.insert(schema.flows).values({
    id: flowId,
    projectId,
    flowRefId: "bugfix",
    source: "github.com/x/y",
    version: "v1.0.0",
    installedPath: "/tmp/flows/bugfix",
    manifest: { schemaVersion: 1, name: "Bugfix", nodes: [] },
    schemaVersion: 1,
  });
  await db.insert(schema.tasks).values({
    number: Number.parseInt(randomUUID().slice(0, 6), 16),
    id: taskId,
    projectId,
    title: "t",
    prompt: "p",
    flowId,
  });
  await db.insert(schema.runs).values({
    id: runId,
    taskId,
    projectId,
    flowId,
    runnerId,
    capabilityAgent: "claude",
    flowVersion: "v1.0.0",
    status: "Review",
  });
  await db.insert(schema.workspaces).values({
    id: randomUUID(),
    runId,
    projectId,
    branch: `maister/${runId.slice(0, 8)}`,
    worktreePath: `/tmp/wt-${runId.slice(0, 8)}`,
    parentRepoPath: `/tmp/${slug}`,
  });

  return { projectId, projectSlug: slug, runId };
}

async function seedUser(): Promise<string> {
  const id = randomUUID();

  await db.insert(schema.users).values({
    id,
    email: `${id}@ntf.test`,
    role: "member",
    accountStatus: "active",
    passwordHash: "x",
  });

  return id;
}

async function seedSubscription(opts: {
  projectId?: string | null;
  ownerUserId?: string | null;
  eventTypes?: string[];
}): Promise<string> {
  const id = randomUUID();

  await db.insert(schema.webhookSubscriptions).values({
    id,
    projectId: opts.projectId ?? null,
    ownerUserId: opts.ownerUserId ?? null,
    name: `sub-${id.slice(0, 8)}`,
    url: stub.url,
    eventTypes: opts.eventTypes ?? ["*"],
    signingSecretRef: "env:WH_TEST_SECRET",
    enabled: true,
  });

  return id;
}

async function setWebhooksEnabled(enabled: boolean): Promise<void> {
  // The singleton row requires a default runner, so one is seeded alongside it.
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

async function deliveriesFor(
  eventId: string,
): Promise<Array<{ subscription_id: string; status: string }>> {
  const r = await db.execute(sql`
    SELECT subscription_id, status FROM webhook_deliveries
    WHERE event_id = ${eventId}
    ORDER BY subscription_id
  `);

  return r.rows as unknown as Array<{
    subscription_id: string;
    status: string;
  }>;
}

async function frozenPayload(
  eventId: string,
): Promise<Record<string, unknown> | null> {
  const r = await db.execute(sql`
    SELECT payload FROM webhook_events WHERE id = ${eventId}
  `);

  return (r.rows[0] as unknown as { payload: Record<string, unknown> | null })
    ?.payload;
}

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "user_scoped_webhooks_test",
  });
  db = testDatabase.db;
}, 180_000);

afterAll(async () => {
  await testDatabase?.stop();
});

beforeEach(async () => {
  await db.execute(sql`
    TRUNCATE webhook_subscriptions, webhook_events, webhook_deliveries,
             webhook_delivery_attempts RESTART IDENTITY CASCADE
  `);

  savedEnv = {};
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  process.env.WH_TEST_SECRET = SECRET;
  process.env.MAISTER_WEBHOOK_ALLOW_HOSTS = "127.0.0.1";

  await setWebhooksEnabled(true);
  stub = await startStub();
});

afterEach(async () => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  await stub?.close();
});

// ===========================================================================
// IT-EDGE-NTF-03 — the widening changes NOTHING for a row that fills the
// columns. Green before the widening and green after; that is the whole claim.
// ===========================================================================

describe("IT-EDGE-NTF-03 project-scoped webhooks are untouched by the widening", () => {
  it("fans out to project-scoped AND platform-wide subscriptions and delivers both", async () => {
    const run = await seedRun();
    const projectSub = await seedSubscription({ projectId: run.projectId });
    const platformSub = await seedSubscription({ projectId: null });
    const eventId = randomUUID();

    await db.insert(schema.webhookEvents).values({
      id: eventId,
      projectId: run.projectId,
      runId: run.runId,
      type: "run.review",
      data: { runId: run.runId },
      occurredAt: new Date(),
    });

    const summary = await runWebhookDeliveryJob({ db });

    expect(summary.fanout).toBe(1);
    expect(summary.delivered).toBe(2);

    const rows = await deliveriesFor(eventId);

    expect(rows.map((r) => r.status)).toEqual(["delivered", "delivered"]);
    expect(rows.map((r) => r.subscription_id).sort()).toEqual(
      [projectSub, platformSub].sort(),
    );
  });

  it("freezes a populated project and run block, not nulls", async () => {
    const run = await seedRun();

    await seedSubscription({ projectId: run.projectId });

    const eventId = randomUUID();

    await db.insert(schema.webhookEvents).values({
      id: eventId,
      projectId: run.projectId,
      runId: run.runId,
      type: "run.review",
      data: {},
      occurredAt: new Date(),
    });

    await runWebhookDeliveryJob({ db });

    const payload = await frozenPayload(eventId);

    expect(payload).not.toBeNull();
    expect((payload as { project: { slug: string } }).project.slug).toBe(
      run.projectSlug,
    );
    expect((payload as { run: { id: string } }).run.id).toBe(run.runId);
  });

  it("still signs what a consumer can verify", async () => {
    const run = await seedRun();

    await seedSubscription({ projectId: run.projectId });

    const eventId = randomUUID();

    await db.insert(schema.webhookEvents).values({
      id: eventId,
      projectId: run.projectId,
      runId: run.runId,
      type: "run.review",
      data: {},
      occurredAt: new Date(),
    });

    await runWebhookDeliveryJob({ db });

    expect(stub.requests).toHaveLength(1);

    const captured = stub.requests[0];
    const signature = captured.headers["x-maister-signature"] ?? "";
    const t = Number(
      signature
        .split(",")
        .find((p) => p.startsWith("t="))
        ?.slice(2),
    );
    const deliveryId = captured.headers["x-maister-delivery-id"] ?? "";
    const expected = createHmac("sha256", SECRET)
      .update(`${t}.${deliveryId}.${captured.rawBody}`)
      .digest("hex");

    expect(signature).toContain(`v1=${expected}`);
  });

  it("still prunes a fanned-out project event that matched nothing", async () => {
    const run = await seedRun();
    const eventId = randomUUID();

    await db.insert(schema.webhookEvents).values({
      id: eventId,
      projectId: run.projectId,
      runId: run.runId,
      type: "run.review",
      data: {},
      occurredAt: new Date(),
    });

    // No subscription: fanout stamps it and creates zero deliveries.
    await runWebhookDeliveryJob({ db });
    await db.execute(sql`
      UPDATE webhook_events SET fanout_at = now() - interval '30 days'
      WHERE id = ${eventId}
    `);

    const summary = await runWebhookDeliveryJob({ db });

    expect(summary.pruned).toBeGreaterThanOrEqual(1);

    const remaining = await db.execute(sql`
      SELECT 1 FROM webhook_events WHERE id = ${eventId}
    `);

    expect(remaining.rows).toHaveLength(0);
  });
});

// ===========================================================================
// IT-NTF-02 — a project-less, run-less event reaches every reader. The table is
// per-READER, because ADR-173 D2's defect shape is "a reader that structurally
// cannot see a NULL row", and that is invisible to a test that only checks the
// happy delivery.
// ===========================================================================

async function emitUserEvent(
  ownerUserId: string,
  type = "attention.digest",
): Promise<string> {
  const { emitWebhookEvent } = await import("@/lib/webhooks/outbox");

  return emitWebhookEvent({
    db,
    type: type as "attention.digest",
    ownerUserId,
    data: { sentence: "2 promoted · 1 crashed" },
  });
}

describe("IT-NTF-02 readers of the nullable columns", () => {
  it("emitWebhookEvent writes a row with NULL project and run", async () => {
    const owner = await seedUser();
    const eventId = await emitUserEvent(owner);
    const r = await db.execute(sql`
      SELECT project_id, run_id, type, data
      FROM webhook_events WHERE id = ${eventId}
    `);
    const row = r.rows[0] as unknown as {
      project_id: string | null;
      run_id: string | null;
      type: string;
      data: { ownerUserId?: string };
    };

    expect(row.project_id).toBeNull();
    expect(row.run_id).toBeNull();
    expect(row.type).toBe("attention.digest");
    // The owner rides in `data` — ADR-173 rejected a `user_id` column.
    expect(row.data.ownerUserId).toBe(owner);
  });

  it("the fanout pass freezes an envelope whose project and run are null", async () => {
    const owner = await seedUser();

    await seedSubscription({ ownerUserId: owner });

    const eventId = await emitUserEvent(owner);

    await runWebhookDeliveryJob({ db });

    const payload = await frozenPayload(eventId);

    expect(payload).not.toBeNull();
    expect((payload as { project: unknown }).project).toBeNull();
    expect((payload as { run: unknown }).run).toBeNull();
    expect((payload as { type: string }).type).toBe("attention.digest");
  });

  it("the drain pass signs and sends it like any other delivery", async () => {
    const owner = await seedUser();

    await seedSubscription({ ownerUserId: owner });
    const eventId = await emitUserEvent(owner);
    const summary = await runWebhookDeliveryJob({ db });

    expect(summary.delivered).toBe(1);
    expect(stub.requests).toHaveLength(1);

    const body = JSON.parse(stub.requests[0].rawBody) as {
      project: unknown;
      run: unknown;
      type: string;
    };

    expect(body.project).toBeNull();
    expect(body.run).toBeNull();
    expect(body.type).toBe("attention.digest");

    const rows = await deliveriesFor(eventId);

    expect(rows.map((r) => r.status)).toEqual(["delivered"]);
  });

  it("the drain pass retries a failing user delivery on the existing curve", async () => {
    const owner = await seedUser();

    await seedSubscription({ ownerUserId: owner });
    stub.setStatus(500);

    const eventId = await emitUserEvent(owner);
    const summary = await runWebhookDeliveryJob({ db });

    expect(summary.failed).toBe(1);

    const r = await db.execute(sql`
      SELECT status, attempt_count, next_attempt_at, delivered_at
      FROM webhook_deliveries WHERE event_id = ${eventId}
    `);
    const row = r.rows[0] as unknown as {
      status: string;
      attempt_count: number;
      next_attempt_at: Date;
      delivered_at: Date | null;
    };

    // NTF-04: intent persisted, delivered_at still null, row still retryable.
    expect(row.status).toBe("pending");
    expect(row.attempt_count).toBe(1);
    expect(row.delivered_at).toBeNull();
    expect(new Date(row.next_attempt_at).getTime()).toBeGreaterThan(Date.now());
  });

  it("the prune pass GCs a user event that matched nothing", async () => {
    const owner = await seedUser();
    const eventId = await emitUserEvent(owner);

    await runWebhookDeliveryJob({ db });
    await db.execute(sql`
      UPDATE webhook_events SET fanout_at = now() - interval '30 days'
      WHERE id = ${eventId}
    `);
    await runWebhookDeliveryJob({ db });

    const remaining = await db.execute(sql`
      SELECT 1 FROM webhook_events WHERE id = ${eventId}
    `);

    expect(remaining.rows).toHaveLength(0);
  });

  it("the disabled kill-switch skips a user event the same way", async () => {
    const owner = await seedUser();

    await seedSubscription({ ownerUserId: owner });
    await setWebhooksEnabled(false);

    const eventId = await emitUserEvent(owner);
    const summary = await runWebhookDeliveryJob({ db });

    expect(summary.skipped).toBe("disabled");
    expect(summary.skippedEvents).toBe(1);
    expect(await deliveriesFor(eventId)).toEqual([]);
  });
});

// ===========================================================================
// IT-NTF-03 — scope matching end to end, BOTH directions, through the real
// fanout pass rather than through the pure predicate.
// ===========================================================================

describe("IT-NTF-03 scope matching through the engine", () => {
  it("a user event reaches its owner and nobody else", async () => {
    const owner = await seedUser();
    const stranger = await seedUser();
    const mine = await seedSubscription({ ownerUserId: owner });

    await seedSubscription({ ownerUserId: stranger });
    await seedSubscription({ projectId: null });

    const run = await seedRun();

    await seedSubscription({ projectId: run.projectId });

    const eventId = await emitUserEvent(owner);

    await runWebhookDeliveryJob({ db });

    const rows = await deliveriesFor(eventId);

    expect(rows.map((r) => r.subscription_id)).toEqual([mine]);
  });

  it("a project event never reaches a user subscription", async () => {
    const owner = await seedUser();
    const run = await seedRun();
    const projectSub = await seedSubscription({ projectId: run.projectId });

    await seedSubscription({ ownerUserId: owner });

    const eventId = randomUUID();

    await db.insert(schema.webhookEvents).values({
      id: eventId,
      projectId: run.projectId,
      runId: run.runId,
      type: "run.review",
      data: {},
      occurredAt: new Date(),
    });

    await runWebhookDeliveryJob({ db });

    const rows = await deliveriesFor(eventId);

    expect(rows.map((r) => r.subscription_id)).toEqual([projectSub]);
  });
});
