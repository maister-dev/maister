import { createHash, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { type AddressInfo } from "node:net";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
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
import { replayDelivery } from "@/lib/webhooks/replay";
import { isMaisterError } from "@/lib/errors";
// FIXME(any): drizzle-orm dual peer-dep variants — runtime works, cast silences
// the type-only clash (matches delivery.integration.test.ts).
import * as fullSchema from "@/lib/db/schema";
import { testPlatformRunnerRow } from "@/lib/__tests__/runner-fixtures";

// =============================================================================
// T10 — replay service + the attempt_no decoupling in the T9 drain (TDD red).
//
// DQ8 replay: a `delivered`|`dead` delivery is reset to `pending`,
// attempt_count=0 (fresh retry budget), next_attempt_at=now, lease cleared —
// but the idempotency_key and the webhook_delivery_attempts audit trail are
// PRESERVED. A `pending` delivery cannot be replayed → MaisterError("CONFLICT").
//
// The audit `attempt_no` sequence is APPEND-ONLY across replays (UNIQUE
// (delivery_id, attempt_no)). Replay resets the retry-curve counter
// (attempt_count) to 0, but the next drain must continue attempt_no from the
// running max — NOT restart it at 1 — or the unique constraint collides.
//
// RED now: replay.ts does not exist; and even stubbed, the drain still derives
// attempt_no from attempt_count+1, so the post-replay drain would write
// attempt_no=1 (collides with the preserved attempt_no=1 audit row).
// =============================================================================

const schema = fullSchema as unknown as Record<string, any>;

const SECRET = "whsec_test_0123456789abcdef";

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;

// ---------------------------------------------------------------------------
// In-process HTTP stub — captures requests, answers a configured status.
// ---------------------------------------------------------------------------

interface CapturedRequest {
  method: string;
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

      requests.push({ method: req.method ?? "", headers, rawBody });
      res.statusCode = status;
      res.end("ok");
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${port}/hook`,
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

function expectedIdempotencyKey(subId: string, eventId: string): string {
  return createHash("sha256").update(`${subId}:${eventId}`).digest("hex");
}

// ---------------------------------------------------------------------------
// Seed helpers (mirror delivery.integration.test.ts).
// ---------------------------------------------------------------------------

interface SeededRun {
  projectId: string;
  projectSlug: string;
  projectName: string;
  runId: string;
  taskId: string;
  flowId: string;
  branch: string;
  status: string;
}

async function seedRun(runStatus = "Review"): Promise<SeededRun> {
  const projectId = randomUUID();
  const executorId = randomUUID();
  const flowId = randomUUID();
  const taskId = randomUUID();
  const runId = randomUUID();
  const workspaceId = randomUUID();
  const slug = `proj-${projectId.slice(0, 8)}`;
  const name = `Project ${projectId.slice(0, 8)}`;
  const branch = `maister/${runId.slice(0, 8)}`;

  await db.insert(schema.projects).values({
    id: projectId,
    slug,
    name,
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
    status: runStatus,
  });

  await db.insert(schema.workspaces).values({
    id: workspaceId,
    runId,
    projectId,
    branch,
    worktreePath: `/tmp/wt-${runId.slice(0, 8)}`,
    parentRepoPath: `/tmp/${slug}`,
  });

  return {
    projectId,
    projectSlug: slug,
    projectName: name,
    runId,
    taskId,
    flowId,
    branch,
    status: runStatus,
  };
}

async function seedSubscription(run: SeededRun, url: string): Promise<string> {
  const subId = randomUUID();

  await db.insert(schema.webhookSubscriptions).values({
    id: subId,
    projectId: run.projectId,
    name: `sub-${subId.slice(0, 8)}`,
    url,
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

async function freezeEventPayload(
  run: SeededRun,
  eventId: string,
): Promise<void> {
  const payload = {
    apiVersion: 1,
    id: eventId,
    type: "run.review",
    occurredAt: new Date().toISOString(),
    project: {
      id: run.projectId,
      slug: run.projectSlug,
      name: run.projectName,
    },
    run: {
      id: run.runId,
      taskId: run.taskId,
      flowId: run.flowId,
      branch: run.branch,
      status: run.status,
    },
    data: { runId: run.runId },
  };

  await db.execute(sql`
    UPDATE webhook_events
    SET payload = ${JSON.stringify(payload)}::jsonb, fanout_at = now()
    WHERE id = ${eventId}
  `);
}

interface SeedDeliveryOpts {
  run: SeededRun;
  subId: string;
  eventId: string;
  status: "pending" | "delivered" | "dead";
  attemptCount?: number;
  lastHttpStatus?: number;
  lastErrorKind?: string;
  lastErrorMessage?: string;
}

async function seedDelivery(opts: SeedDeliveryOpts): Promise<string> {
  const deliveryId = randomUUID();

  await db.insert(schema.webhookDeliveries).values({
    id: deliveryId,
    eventId: opts.eventId,
    subscriptionId: opts.subId,
    status: opts.status,
    attemptCount: opts.attemptCount ?? 1,
    nextAttemptAt: new Date(Date.now() - 1_000),
    leaseExpiresAt: null,
    idempotencyKey: expectedIdempotencyKey(opts.subId, opts.eventId),
    deliveredAt: opts.status === "delivered" ? new Date() : null,
    lastHttpStatus: opts.lastHttpStatus ?? null,
    lastErrorKind: opts.lastErrorKind ?? null,
    lastErrorMessage: opts.lastErrorMessage ?? null,
  });

  return deliveryId;
}

// Seed one prior attempt row so the audit sequence has a running max to continue.
async function seedAttempt(
  deliveryId: string,
  attemptNo: number,
): Promise<void> {
  await db.insert(schema.webhookDeliveryAttempts).values({
    id: randomUUID(),
    deliveryId,
    attemptNo,
    requestedAt: new Date(),
    durationMs: 5,
    httpStatus: 200,
  });
}

interface DeliveryRow {
  id: string;
  status: string;
  attempt_count: number;
  next_attempt_at: Date | null;
  lease_expires_at: Date | null;
  idempotency_key: string;
  event_id: string;
  subscription_id: string;
  delivered_at: Date | null;
  last_http_status: number | null;
  last_error_kind: string | null;
  last_error_message: string | null;
}

async function fetchDelivery(
  deliveryId: string,
): Promise<DeliveryRow | undefined> {
  const r = await db.execute(sql`
    SELECT id, status, attempt_count, next_attempt_at, lease_expires_at,
           idempotency_key, event_id, subscription_id, delivered_at,
           last_http_status, last_error_kind, last_error_message
    FROM webhook_deliveries
    WHERE id = ${deliveryId}
  `);

  return r.rows[0] as unknown as DeliveryRow | undefined;
}

interface AttemptRow {
  attempt_no: number;
  http_status: number | null;
}

async function fetchAttempts(deliveryId: string): Promise<AttemptRow[]> {
  const r = await db.execute(sql`
    SELECT attempt_no, http_status
    FROM webhook_delivery_attempts
    WHERE delivery_id = ${deliveryId}
    ORDER BY attempt_no
  `);

  return r.rows as unknown as AttemptRow[];
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

let stub: HttpStub;
let savedTimeout: string | undefined;

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

  process.env.WH_TEST_SECRET = SECRET;
  // The 127.0.0.1 stub is a blocked loopback destination under the egress
  // policy — exempt it the way an operator exempts a local consumer.
  process.env.MAISTER_WEBHOOK_ALLOW_HOSTS = "127.0.0.1";
  savedTimeout = process.env.MAISTER_WEBHOOK_TIMEOUT_MS;
  delete process.env.MAISTER_WEBHOOK_TIMEOUT_MS;

  await setWebhooksEnabled(true);

  stub = await startStub();
});

afterEach(async () => {
  if (savedTimeout === undefined) delete process.env.MAISTER_WEBHOOK_TIMEOUT_MS;
  else process.env.MAISTER_WEBHOOK_TIMEOUT_MS = savedTimeout;

  await stub?.close();
});

// ===========================================================================
// 1. state matrix — delivered -> pending reset, audit + idempotency preserved.
// ===========================================================================

describe("replay state matrix", () => {
  it("resets a delivered delivery to pending without touching the audit or key", async () => {
    const run = await seedRun("Review");
    const eventId = await seedEvent(run);
    const subId = await seedSubscription(run, stub.url);

    await freezeEventPayload(run, eventId);

    const deliveryId = await seedDelivery({
      run,
      subId,
      eventId,
      status: "delivered",
      attemptCount: 3,
      lastHttpStatus: 200,
    });

    await seedAttempt(deliveryId, 1);

    const before = Date.now();

    await replayDelivery(deliveryId, db);

    const after = Date.now();
    const delivery = await fetchDelivery(deliveryId);

    expect(delivery?.status).toBe("pending");
    expect(delivery?.attempt_count).toBe(0);
    expect(delivery?.lease_expires_at).toBeNull();
    expect(delivery?.next_attempt_at).not.toBeNull();

    // Prior-cycle outcome fields are cleared — a pending row must not carry a
    // delivered_at or a stale terminal status.
    expect(delivery?.delivered_at).toBeNull();
    expect(delivery?.last_http_status).toBeNull();

    const nextMs = new Date(delivery!.next_attempt_at as Date).getTime();

    expect(nextMs).toBeGreaterThanOrEqual(before - 1_000);
    expect(nextMs).toBeLessThanOrEqual(after + 1_000);

    // Idempotency key + linkage are stable across replay — consumer-safe.
    expect(delivery?.idempotency_key).toBe(
      expectedIdempotencyKey(subId, eventId),
    );
    expect(delivery?.event_id).toBe(eventId);
    expect(delivery?.subscription_id).toBe(subId);

    // Audit untouched.
    const attempts = await fetchAttempts(deliveryId);

    expect(attempts).toHaveLength(1);
    expect(attempts[0].attempt_no).toBe(1);
  });

  it("resets a dead delivery to pending and clears the stale error fields", async () => {
    const run = await seedRun("Review");
    const eventId = await seedEvent(run);
    const subId = await seedSubscription(run, stub.url);

    await freezeEventPayload(run, eventId);

    const deliveryId = await seedDelivery({
      run,
      subId,
      eventId,
      status: "dead",
      attemptCount: 8,
      lastHttpStatus: 500,
      lastErrorKind: "http",
      lastErrorMessage: "HTTP 500",
    });

    await replayDelivery(deliveryId, db);

    const delivery = await fetchDelivery(deliveryId);

    expect(delivery?.status).toBe("pending");
    expect(delivery?.attempt_count).toBe(0);
    expect(delivery?.lease_expires_at).toBeNull();
    expect(delivery?.last_http_status).toBeNull();
    expect(delivery?.last_error_kind).toBeNull();
    expect(delivery?.last_error_message).toBeNull();
  });

  it("refuses to replay a pending delivery with MaisterError CONFLICT", async () => {
    const run = await seedRun("Review");
    const eventId = await seedEvent(run);
    const subId = await seedSubscription(run, stub.url);

    await freezeEventPayload(run, eventId);

    const deliveryId = await seedDelivery({
      run,
      subId,
      eventId,
      status: "pending",
      attemptCount: 1,
    });

    let caught: unknown;

    try {
      await replayDelivery(deliveryId, db);
    } catch (err) {
      caught = err;
    }

    expect(isMaisterError(caught)).toBe(true);
    expect((caught as { code?: string }).code).toBe("CONFLICT");

    // Untouched: still pending at its original attempt_count.
    const delivery = await fetchDelivery(deliveryId);

    expect(delivery?.status).toBe("pending");
    expect(delivery?.attempt_count).toBe(1);
  });
});

// ===========================================================================
// 2. replay -> drain — attempt_no CONTINUES from the running max while the
//    retry curve restarts. A prior attempt_no=1 audit row plus a fresh drain
//    yields attempt_no=2 (append-only), the SAME idempotency key on the wire,
//    and the delivery ends `delivered`.
//
//    RED now: the drain derives attempt_no from attempt_count+1 (=1 after a
//    replay reset), which collides with the preserved attempt_no=1 row.
// ===========================================================================

describe("replay -> drain — attempt_no continues, idempotency key stable", () => {
  it("delivers with a NEW attempt_no=2 and the unchanged idempotency key", async () => {
    const run = await seedRun("Review");
    const eventId = await seedEvent(run);
    const subId = await seedSubscription(run, stub.url);

    await freezeEventPayload(run, eventId);

    const deliveryId = await seedDelivery({
      run,
      subId,
      eventId,
      status: "delivered",
      attemptCount: 1,
    });

    // The original delivery already has one recorded attempt (attempt_no=1).
    await seedAttempt(deliveryId, 1);

    // Replay → fresh retry budget, audit preserved.
    await replayDelivery(deliveryId, db);

    stub.setStatus(200);

    const summary = await runWebhookDeliveryJob({ db });

    expect(summary.delivered).toBe(1);

    // Exactly one wire send carrying the SAME idempotency key as the original.
    expect(stub.requests).toHaveLength(1);
    expect(stub.requests[0].headers["x-maister-idempotency-key"]).toBe(
      expectedIdempotencyKey(subId, eventId),
    );

    const delivery = await fetchDelivery(deliveryId);

    expect(delivery?.status).toBe("delivered");

    // The drain's attempt_count restarts on the curve at 1 ...
    expect(delivery?.attempt_count).toBe(1);

    // ... but the AUDIT attempt_no continues append-only: 1 (preserved), 2 (new).
    const attempts = await fetchAttempts(deliveryId);

    expect(attempts.map((a) => a.attempt_no)).toEqual([1, 2]);
    expect(attempts[1].http_status).toBe(200);
  });

  it("a replayed-then-dead delivery carries no stale delivered_at", async () => {
    const run = await seedRun("Review");
    const eventId = await seedEvent(run);
    const subId = await seedSubscription(run, stub.url);

    await freezeEventPayload(run, eventId);

    const deliveryId = await seedDelivery({
      run,
      subId,
      eventId,
      status: "delivered",
      attemptCount: 1,
      lastHttpStatus: 200,
    });

    await replayDelivery(deliveryId, db);

    // 410 → dead at the first attempt of the replay cycle.
    stub.setStatus(410);

    const summary = await runWebhookDeliveryJob({ db });

    expect(summary.dead).toBe(1);

    const delivery = await fetchDelivery(deliveryId);

    expect(delivery?.status).toBe("dead");
    expect(delivery?.delivered_at).toBeNull();
    expect(delivery?.last_http_status).toBe(410);
  });
});
