import {
  createHash,
  createHmac,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
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
// FIXME(any): drizzle-orm dual peer-dep variants — runtime works, cast silences
// the type-only clash (matches webhooks-schema.integration.test.ts).
import * as fullSchema from "@/lib/db/schema";
import { testPlatformRunnerRow } from "@/lib/__tests__/runner-fixtures";

// =============================================================================
// T9 — outbound-webhooks fanout + signed delivery executor (TDD red).
//
// The riskiest task: this pins the FULL behavior of `runWebhookDeliveryJob`
// once T9 lands. Today it is the T8 skeleton that only reads
// `platform_runtime_settings.webhooks_enabled` and returns zero counts — every
// delivery-asserting case below MUST fail on the absent delivery/attempt row or
// the absent stub receipt (NOT on a harness/setup error). Case 7 (global
// kill-switch) is the ONLY case that is vacuously green against the skeleton.
//
// Pinned handler contract (one invocation = fanout + drain), per
// `.ai-factory/plans/feature-outbound-webhooks.md` T9 + DQ4/DQ5/DQ6 and
// `docs/system-analytics/outbound-webhooks.md`:
//   FANOUT — for each `webhook_events` row with fanout_at IS NULL (LIMIT batch,
//     FOR UPDATE SKIP LOCKED): build+FREEZE the full envelope payload
//     (taxonomy builder; joins runs⋈projects⋈workspaces⋈tasks for
//     project{id,slug,name} + run{id,taskId,flowId,branch,status}), match
//     enabled subscriptions (match.ts), insert `webhook_deliveries`
//     ON CONFLICT (subscription_id,event_id) DO NOTHING, set
//     `webhook_events.payload` + `fanout_at` in the SAME tx.
//   DRAIN — claim due deliveries (status='pending' AND next_attempt_at<=now AND
//     (lease_expires_at IS NULL OR < now), LIMIT MAISTER_WEBHOOK_DELIVERY_BATCH,
//     SKIP LOCKED, lease=now+5m); per delivery resolve signing secret ref,
//     inject deliveryId+attempt into the frozen payload, sign
//     (HMAC base `${t}.${deliveryId}.${rawBody}`), fetch POST with
//     AbortController timeout MAISTER_WEBHOOK_TIMEOUT_MS + redirect:"manual",
//     classify (backoff.ts), then in one tx insert a
//     `webhook_delivery_attempts` row + CAS the delivery to
//     delivered/dead/pending(+next_attempt_at).
//   Returns { fanout, delivered, failed, dead } (+ skipped:"disabled" when off).
// =============================================================================

const schema = fullSchema as unknown as Record<string, any>;

const RETRY_FIRST_BUCKET_MS = 60_000; // backoff.ts RETRY_SCHEDULE_MS[0]
const JITTER_RATIO = 0.2; // backoff.ts JITTER_RATIO

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;

// ---------------------------------------------------------------------------
// In-process HTTP stub — a stand-in for a real webhook consumer. Captures every
// request (method/url/headers/raw body) and answers per the configured mode.
// ---------------------------------------------------------------------------

type StubMode =
  | { kind: "status"; status: number }
  | { kind: "delay"; ms: number; status: number };

interface CapturedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  rawBody: string;
}

interface HttpStub {
  port: number;
  url: string;
  requests: CapturedRequest[];
  setMode(mode: StubMode): void;
  close(): Promise<void>;
}

async function startStub(): Promise<HttpStub> {
  let mode: StubMode = { kind: "status", status: 200 };
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

      requests.push({
        method: req.method ?? "",
        url: req.url ?? "",
        headers,
        rawBody,
      });

      const respond = () => {
        res.statusCode = mode.status;
        res.end("ok");
      };

      if (mode.kind === "delay") {
        setTimeout(respond, mode.ms);

        return;
      }

      respond();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    port,
    url: `http://127.0.0.1:${port}/hook`,
    requests,
    setMode(next) {
      mode = next;
    },
    close() {
      return new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    },
  };
}

// ---------------------------------------------------------------------------
// Independent signature verification — exactly what a real consumer would do
// with node:crypto, against the captured raw body. Proves interop.
//   X-Maister-Signature: t=<unix>,v1=<hex>[,v1=<hex2>]
//   base = `${t}.${deliveryId}.${rawBody}`
// ---------------------------------------------------------------------------

function verifySignatureHeader(
  signatureHeader: string,
  deliveryId: string,
  rawBody: string,
  secret: string,
): boolean {
  const parts = signatureHeader.split(",");
  const tPart = parts.find((p) => p.startsWith("t="));

  if (!tPart) return false;

  const t = Number(tPart.slice("t=".length));

  if (!Number.isFinite(t)) return false;

  const base = `${t}.${deliveryId}.${rawBody}`;
  const expected = createHmac("sha256", secret).update(base).digest("hex");
  const expectedBytes = Uint8Array.from(Buffer.from(expected, "hex"));

  return parts
    .filter((p) => p.startsWith("v1="))
    .some((p) => {
      const got = Uint8Array.from(Buffer.from(p.slice("v1=".length), "hex"));

      return (
        got.length === expectedBytes.length &&
        timingSafeEqual(got, expectedBytes)
      );
    });
}

function expectedIdempotencyKey(subId: string, eventId: string): string {
  return createHash("sha256").update(`${subId}:${eventId}`).digest("hex");
}

// ---------------------------------------------------------------------------
// Seed helpers. seedRun also inserts a workspaces row so the fanout join has a
// `branch` (runs has no branch column — the envelope's run.branch comes from
// workspaces.branch).
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

interface SeedSubscriptionOpts {
  projectId?: string | null;
  eventTypes?: string[];
  enabled?: boolean;
  url: string;
}

async function seedSubscription(opts: SeedSubscriptionOpts): Promise<string> {
  const subId = randomUUID();

  await db.insert(schema.webhookSubscriptions).values({
    id: subId,
    projectId: opts.projectId ?? null,
    name: `sub-${subId.slice(0, 8)}`,
    url: opts.url,
    eventTypes: opts.eventTypes ?? ["run.review"],
    signingSecretRef: "env:WH_TEST_SECRET",
    enabled: opts.enabled ?? true,
  });

  return subId;
}

async function seedEvent(run: SeededRun, type = "run.review"): Promise<string> {
  const eventId = randomUUID();

  await db.insert(schema.webhookEvents).values({
    id: eventId,
    projectId: run.projectId,
    runId: run.runId,
    type,
    data: { runId: run.runId },
    occurredAt: new Date(),
  });

  return eventId;
}

// Seed a delivery row directly (for drain-only cases). Assumes the event is
// already fanned out (payload frozen, fanout_at set) so the handler's drain
// pass is exercised in isolation from fanout.
interface SeedDeliveryOpts {
  run: SeededRun;
  subId: string;
  eventId: string;
  status?: "pending" | "delivered" | "dead";
  attemptCount?: number;
  nextAttemptAt?: Date;
  leaseExpiresAt?: Date | null;
}

async function freezeEventPayload(
  run: SeededRun,
  eventId: string,
  type = "run.review",
): Promise<void> {
  // Mirror the envelope the fanout pass would freeze, so drain-only cases have a
  // realistic frozen payload to sign and send.
  const payload = {
    apiVersion: 1,
    id: eventId,
    type,
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

async function seedDelivery(opts: SeedDeliveryOpts): Promise<string> {
  const deliveryId = randomUUID();

  await db.insert(schema.webhookDeliveries).values({
    id: deliveryId,
    eventId: opts.eventId,
    subscriptionId: opts.subId,
    status: opts.status ?? "pending",
    attemptCount: opts.attemptCount ?? 0,
    nextAttemptAt: opts.nextAttemptAt ?? new Date(Date.now() - 1_000),
    leaseExpiresAt: opts.leaseExpiresAt ?? null,
    idempotencyKey: expectedIdempotencyKey(opts.subId, opts.eventId),
  });

  return deliveryId;
}

// ---------------------------------------------------------------------------
// Row fetch helpers (cast through unknown — drizzle execute is loosely typed).
// ---------------------------------------------------------------------------

interface DeliveryRow {
  id: string;
  status: string;
  attempt_count: number;
  next_attempt_at: Date | null;
  lease_expires_at: Date | null;
  last_http_status: number | null;
  last_error_kind: string | null;
  delivered_at: Date | null;
}

async function fetchDeliveryByEvent(
  eventId: string,
): Promise<DeliveryRow | undefined> {
  const r = await db.execute(sql`
    SELECT id, status, attempt_count, next_attempt_at, lease_expires_at,
           last_http_status, last_error_kind, delivered_at
    FROM webhook_deliveries
    WHERE event_id = ${eventId}
  `);

  return r.rows[0] as unknown as DeliveryRow | undefined;
}

async function fetchDelivery(
  deliveryId: string,
): Promise<DeliveryRow | undefined> {
  const r = await db.execute(sql`
    SELECT id, status, attempt_count, next_attempt_at, lease_expires_at,
           last_http_status, last_error_kind, delivered_at
    FROM webhook_deliveries
    WHERE id = ${deliveryId}
  `);

  return r.rows[0] as unknown as DeliveryRow | undefined;
}

interface AttemptRow {
  attempt_no: number;
  http_status: number | null;
  error_kind: string | null;
  duration_ms: number | null;
}

async function fetchAttempts(deliveryId: string): Promise<AttemptRow[]> {
  const r = await db.execute(sql`
    SELECT attempt_no, http_status, error_kind, duration_ms
    FROM webhook_delivery_attempts
    WHERE delivery_id = ${deliveryId}
    ORDER BY attempt_no
  `);

  return r.rows as unknown as AttemptRow[];
}

async function countDeliveriesForEventSub(
  eventId: string,
  subId: string,
): Promise<number> {
  const r = await db.execute(sql`
    SELECT count(*)::int AS c FROM webhook_deliveries
    WHERE event_id = ${eventId} AND subscription_id = ${subId}
  `);

  return (r.rows[0] as { c: number }).c;
}

async function fetchEventPayload(eventId: string): Promise<{
  payload: Record<string, unknown> | null;
  fanout_at: Date | null;
}> {
  const r = await db.execute(sql`
    SELECT payload, fanout_at FROM webhook_events WHERE id = ${eventId}
  `);

  return r.rows[0] as unknown as {
    payload: Record<string, unknown> | null;
    fanout_at: Date | null;
  };
}

async function setWebhooksEnabled(enabled: boolean): Promise<void> {
  // platform_runtime_settings is a singleton keyed by id='singleton'. The
  // handler reads webhooks_enabled there. Ensure exactly one row, then flip it.
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

const ENV_KEYS = [
  "WH_TEST_SECRET",
  "MAISTER_WEBHOOK_DELIVERY_BATCH",
  "MAISTER_WEBHOOK_TIMEOUT_MS",
  "MAISTER_WEBHOOK_MAX_ATTEMPTS",
] as const;

const SECRET = "whsec_test_0123456789abcdef";

let savedEnv: Record<string, string | undefined> = {};
let stub: HttpStub;

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
  // Reset webhook state so each case starts clean — removes the implicit
  // cross-case coupling (a prior case's pending/retry delivery being re-drained)
  // and the closed-stub port-reuse flake vector.
  await db.execute(sql`
    TRUNCATE webhook_subscriptions, webhook_events, webhook_deliveries,
             webhook_delivery_attempts RESTART IDENTITY CASCADE
  `);

  savedEnv = {};
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];

  process.env.WH_TEST_SECRET = SECRET;
  delete process.env.MAISTER_WEBHOOK_DELIVERY_BATCH;
  delete process.env.MAISTER_WEBHOOK_TIMEOUT_MS;
  delete process.env.MAISTER_WEBHOOK_MAX_ATTEMPTS;

  // Kill-switch ON by default so fanout/drain run for every case except #7.
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
// 1. Happy path — fanout freezes envelope, drain delivers + signs, stub
//    receives exactly one POST whose headers + signature verify.
//    RED now: skeleton fans out nothing and sends nothing.
// ===========================================================================

describe("happy path — fanout + signed delivery", () => {
  it("freezes the envelope, delivers, records an attempt, and the stub verifies the signature", async () => {
    const run = await seedRun("Review");
    const eventId = await seedEvent(run, "run.review");
    const subId = await seedSubscription({
      projectId: run.projectId,
      eventTypes: ["run.review"],
      url: stub.url,
    });

    stub.setMode({ kind: "status", status: 200 });

    const summary = await runWebhookDeliveryJob({ db });

    expect(summary.skipped).toBeUndefined();
    expect(summary.fanout).toBe(1);
    expect(summary.delivered).toBe(1);

    // Event payload frozen with the full v1 envelope.
    const ev = await fetchEventPayload(eventId);

    expect(ev.fanout_at).not.toBeNull();
    expect(ev.payload).not.toBeNull();

    const payload = ev.payload as Record<string, any>;

    expect(payload.apiVersion).toBe(1);
    expect(payload.id).toBe(eventId);
    expect(payload.type).toBe("run.review");
    expect(payload.project).toEqual({
      id: run.projectId,
      slug: run.projectSlug,
      name: run.projectName,
    });
    expect(payload.run).toEqual({
      id: run.runId,
      taskId: run.taskId,
      flowId: run.flowId,
      branch: run.branch,
      status: "Review",
    });
    expect(payload.data).toBeDefined();

    // Delivery row in `delivered`.
    const delivery = await fetchDeliveryByEvent(eventId);

    expect(delivery).toBeDefined();
    expect(delivery?.status).toBe("delivered");
    expect(delivery?.delivered_at).not.toBeNull();

    // Exactly one attempt row, attempt_no 1, 200, duration set.
    const attempts = await fetchAttempts(delivery!.id);

    expect(attempts).toHaveLength(1);
    expect(attempts[0].attempt_no).toBe(1);
    expect(attempts[0].http_status).toBe(200);
    expect(attempts[0].duration_ms).not.toBeNull();
    expect(attempts[0].duration_ms).toBeGreaterThanOrEqual(0);

    // Stub received exactly one POST.
    expect(stub.requests).toHaveLength(1);

    const sent = stub.requests[0];

    expect(sent.method).toBe("POST");

    // Body parses to the envelope (with deliveryId + attempt injected).
    const body = JSON.parse(sent.rawBody) as Record<string, any>;

    expect(body.apiVersion).toBe(1);
    expect(body.id).toBe(eventId);
    expect(body.type).toBe("run.review");
    expect(body.deliveryId).toBe(delivery!.id);
    expect(body.attempt).toBe(1);
    expect(body.run.branch).toBe(run.branch);
    expect(body.run.status).toBe("Review");

    // All 7 headers present.
    expect(sent.headers["content-type"]).toContain("application/json");
    expect(sent.headers["user-agent"]).toBe("MAIster-Webhooks/1");
    expect(sent.headers["x-maister-event"]).toBe("run.review");
    expect(sent.headers["x-maister-event-id"]).toBe(eventId);
    expect(sent.headers["x-maister-delivery-id"]).toBe(delivery!.id);
    expect(sent.headers["x-maister-idempotency-key"]).toBe(
      expectedIdempotencyKey(subId, eventId),
    );
    expect(sent.headers["x-maister-signature"]).toBeDefined();

    // Signature VERIFIES against the secret + captured raw body — a real
    // consumer would accept this.
    expect(
      verifySignatureHeader(
        sent.headers["x-maister-signature"],
        delivery!.id,
        sent.rawBody,
        SECRET,
      ),
    ).toBe(true);
  });
});

// ===========================================================================
// 2. 500 -> retry. Delivery stays pending, attempt_count=1,
//    last_http_status=500, last_error_kind="http", next_attempt_at in the
//    first-retry bucket window. One attempt row.
//    RED now: skeleton sends nothing, no delivery row.
// ===========================================================================

describe("500 -> retry", () => {
  it("leaves the delivery pending and schedules a future retry", async () => {
    const run = await seedRun("Review");
    const eventId = await seedEvent(run, "run.review");

    await seedSubscription({
      projectId: run.projectId,
      eventTypes: ["run.review"],
      url: stub.url,
    });

    stub.setMode({ kind: "status", status: 500 });

    const before = Date.now();
    const summary = await runWebhookDeliveryJob({ db });
    const after = Date.now();

    expect(summary.delivered).toBe(0);
    expect(summary.failed).toBe(1);

    const delivery = await fetchDeliveryByEvent(eventId);

    expect(delivery).toBeDefined();
    expect(delivery?.status).toBe("pending");
    expect(delivery?.attempt_count).toBe(1);
    expect(delivery?.last_http_status).toBe(500);
    expect(delivery?.last_error_kind).toBe("http");

    expect(stub.requests).toHaveLength(1);

    const attempts = await fetchAttempts(delivery!.id);

    expect(attempts).toHaveLength(1);
    expect(attempts[0].http_status).toBe(500);

    // next_attempt_at ~ now + first-retry bucket (60s) ± 20% jitter. Assert it
    // is in the future and within (0, 5min] — bracketing the 1m bucket with a
    // wide upper bound so jitter never flakes.
    expect(delivery?.next_attempt_at).not.toBeNull();

    const nextMs = new Date(delivery!.next_attempt_at as Date).getTime();

    expect(nextMs).toBeGreaterThan(after);
    expect(nextMs).toBeLessThan(before + 5 * 60_000);

    // Tighter sanity: at least ~the jitter floor of the 1m bucket above "now".
    const jitterFloor = RETRY_FIRST_BUCKET_MS * (1 - JITTER_RATIO);

    expect(nextMs).toBeGreaterThan(before + jitterFloor - 5_000);
  });
});

// ===========================================================================
// 3. timeout -> retry. Stub delays beyond MAISTER_WEBHOOK_TIMEOUT_MS (set low).
//    Delivery pending, last_error_kind="timeout", next_attempt_at in future.
//    RED now: skeleton sends nothing.
// ===========================================================================

describe("timeout -> retry", () => {
  it("classifies an aborted slow response as a timeout retry", async () => {
    process.env.MAISTER_WEBHOOK_TIMEOUT_MS = "200";

    const run = await seedRun("Review");
    const eventId = await seedEvent(run, "run.review");

    await seedSubscription({
      projectId: run.projectId,
      eventTypes: ["run.review"],
      url: stub.url,
    });

    // Respond well after the 200ms timeout so the AbortController fires first.
    stub.setMode({ kind: "delay", ms: 2_000, status: 200 });

    const before = Date.now();
    const summary = await runWebhookDeliveryJob({ db });

    expect(summary.delivered).toBe(0);
    expect(summary.failed).toBe(1);

    const delivery = await fetchDeliveryByEvent(eventId);

    expect(delivery).toBeDefined();
    expect(delivery?.status).toBe("pending");
    expect(delivery?.attempt_count).toBe(1);
    expect(delivery?.last_error_kind).toBe("timeout");

    expect(delivery?.next_attempt_at).not.toBeNull();
    expect(
      new Date(delivery!.next_attempt_at as Date).getTime(),
    ).toBeGreaterThan(before);

    const attempts = await fetchAttempts(delivery!.id);

    expect(attempts).toHaveLength(1);
    expect(attempts[0].error_kind).toBe("timeout");
  }, 30_000);
});

// ===========================================================================
// 4. 410 -> dead immediately (even at attempt 1).
//    RED now: skeleton sends nothing.
// ===========================================================================

describe("410 -> dead", () => {
  it("marks the delivery dead on HTTP 410 Gone at the first attempt", async () => {
    const run = await seedRun("Review");
    const eventId = await seedEvent(run, "run.review");

    await seedSubscription({
      projectId: run.projectId,
      eventTypes: ["run.review"],
      url: stub.url,
    });

    stub.setMode({ kind: "status", status: 410 });

    const summary = await runWebhookDeliveryJob({ db });

    expect(summary.dead).toBe(1);

    const delivery = await fetchDeliveryByEvent(eventId);

    expect(delivery).toBeDefined();
    expect(delivery?.status).toBe("dead");
    expect(delivery?.last_http_status).toBe(410);

    expect(stub.requests).toHaveLength(1);

    const attempts = await fetchAttempts(delivery!.id);

    expect(attempts).toHaveLength(1);
    expect(attempts[0].http_status).toBe(410);
  });
});

// ===========================================================================
// 5. max-attempts -> dead. Seed a delivery already at
//    attempt_count = MAISTER_WEBHOOK_MAX_ATTEMPTS - 1, due now; stub 500 -> the
//    handler's attempt becomes the max-th, so classify -> dead (max_attempts).
//    Drain-only: event is pre-fanned-out (payload frozen) so we drive drain in
//    isolation.
//    RED now: skeleton sends nothing, delivery stays pending at N-1.
// ===========================================================================

describe("max-attempts -> dead", () => {
  it("marks the delivery dead when the failing attempt reaches the cap", async () => {
    const maxAttempts = 8; // MAISTER_WEBHOOK_MAX_ATTEMPTS default
    const run = await seedRun("Review");
    const eventId = await seedEvent(run, "run.review");
    const subId = await seedSubscription({
      projectId: run.projectId,
      eventTypes: ["run.review"],
      url: stub.url,
    });

    await freezeEventPayload(run, eventId, "run.review");

    const deliveryId = await seedDelivery({
      run,
      subId,
      eventId,
      status: "pending",
      attemptCount: maxAttempts - 1,
      nextAttemptAt: new Date(Date.now() - 1_000),
    });

    stub.setMode({ kind: "status", status: 500 });

    const summary = await runWebhookDeliveryJob({ db });

    expect(summary.dead).toBe(1);

    const delivery = await fetchDelivery(deliveryId);

    expect(delivery?.status).toBe("dead");
    expect(delivery?.attempt_count).toBe(maxAttempts);

    expect(stub.requests).toHaveLength(1);
  });
});

// ===========================================================================
// 6. disabled subscription skipped at fanout. enabled=false -> after fanout NO
//    delivery row exists for it, but the event is still fanned out (payload
//    frozen, fanout_at set).
//    RED now: skeleton never fans out, so fanout_at stays NULL (the
//    "event still fanned out" assertion fails). No delivery row is vacuously
//    true under the skeleton, but the fanout assertion still drives the red.
// ===========================================================================

describe("disabled subscription skipped at fanout", () => {
  it("fans out the event but creates no delivery for a disabled subscription", async () => {
    const run = await seedRun("Review");
    const eventId = await seedEvent(run, "run.review");
    const subId = await seedSubscription({
      projectId: run.projectId,
      eventTypes: ["run.review"],
      enabled: false,
      url: stub.url,
    });

    const summary = await runWebhookDeliveryJob({ db });

    expect(summary.fanout).toBe(1);

    // No delivery for the disabled subscription.
    expect(await countDeliveriesForEventSub(eventId, subId)).toBe(0);

    // The event is still considered fanned out (payload frozen, cursor advanced).
    const ev = await fetchEventPayload(eventId);

    expect(ev.fanout_at).not.toBeNull();
    expect(ev.payload).not.toBeNull();

    // And nothing was sent.
    expect(stub.requests).toHaveLength(0);
  });
});

// ===========================================================================
// 7. global kill-switch. webhooks_enabled=false -> handler returns
//    { skipped:"disabled" }, no fanout (event stays fanout_at IS NULL), stub
//    receives nothing.
//    VACUOUSLY GREEN now: the skeleton already short-circuits on the
//    kill-switch — this case is expected to PASS against the skeleton and
//    guards the disabled branch through the T9 rewrite.
// ===========================================================================

describe("global kill-switch", () => {
  it("returns skipped:'disabled', does not fan out, and sends nothing", async () => {
    await setWebhooksEnabled(false);

    const run = await seedRun("Review");
    const eventId = await seedEvent(run, "run.review");

    await seedSubscription({
      projectId: run.projectId,
      eventTypes: ["run.review"],
      url: stub.url,
    });

    const summary = await runWebhookDeliveryJob({ db });

    expect(summary.skipped).toBe("disabled");
    expect(summary.fanout).toBe(0);
    expect(summary.delivered).toBe(0);

    const ev = await fetchEventPayload(eventId);

    expect(ev.fanout_at).toBeNull();
    expect(ev.payload).toBeNull();

    expect(stub.requests).toHaveLength(0);
  });
});

// ===========================================================================
// 8. two concurrent drains -> exactly one send. Seed one due delivery; invoke
//    the handler TWICE concurrently. SKIP LOCKED + lease guarantees the stub
//    receives the POST EXACTLY once; the delivery ends `delivered` with exactly
//    one attempt row.
//    RED now: skeleton sends nothing.
// ===========================================================================

describe("two concurrent drains -> exactly one send", () => {
  it("never double-sends a single due delivery under concurrent invocations", async () => {
    const run = await seedRun("Review");
    const eventId = await seedEvent(run, "run.review");
    const subId = await seedSubscription({
      projectId: run.projectId,
      eventTypes: ["run.review"],
      url: stub.url,
    });

    await freezeEventPayload(run, eventId, "run.review");

    const deliveryId = await seedDelivery({
      run,
      subId,
      eventId,
      status: "pending",
      attemptCount: 0,
      nextAttemptAt: new Date(Date.now() - 1_000),
    });

    stub.setMode({ kind: "status", status: 200 });

    await Promise.all([
      runWebhookDeliveryJob({ db }),
      runWebhookDeliveryJob({ db }),
    ]);

    // The endpoint was hit exactly once despite two concurrent drains.
    expect(stub.requests).toHaveLength(1);

    const delivery = await fetchDelivery(deliveryId);

    expect(delivery?.status).toBe("delivered");
    expect(delivery?.attempt_count).toBe(1);

    const attempts = await fetchAttempts(deliveryId);

    expect(attempts).toHaveLength(1);
    expect(attempts[0].attempt_no).toBe(1);
  });
});

// ===========================================================================
// 9. lease-expiry reclaim (at-least-once). A pending delivery with a STALE
//    lease_expires_at (in the past) and next_attempt_at<=now is reclaimed and
//    sent.
//
//    NOTE (DQ6 at-least-once): a crash between the POST and the attempt-record
//    write leaves the delivery still `pending` with an expired lease; the next
//    drain reclaims and re-POSTs it. That duplicate send is intentional and is
//    absorbed consumer-side by the stable X-Maister-Idempotency-Key
//    (hex sha256(`subId:eventId`)), which is identical across the original and
//    the reclaimed send.
//    RED now: skeleton sends nothing.
// ===========================================================================

describe("lease-expiry reclaim (at-least-once)", () => {
  it("reclaims a pending delivery whose lease has expired and sends it", async () => {
    const run = await seedRun("Review");
    const eventId = await seedEvent(run, "run.review");
    const subId = await seedSubscription({
      projectId: run.projectId,
      eventTypes: ["run.review"],
      url: stub.url,
    });

    await freezeEventPayload(run, eventId, "run.review");

    const deliveryId = await seedDelivery({
      run,
      subId,
      eventId,
      status: "pending",
      attemptCount: 0,
      nextAttemptAt: new Date(Date.now() - 10_000),
      leaseExpiresAt: new Date(Date.now() - 5_000), // stale lease
    });

    stub.setMode({ kind: "status", status: 200 });

    await runWebhookDeliveryJob({ db });

    // The stale lease did NOT block reclaim — the delivery was sent.
    expect(stub.requests).toHaveLength(1);

    const delivery = await fetchDelivery(deliveryId);

    expect(delivery?.status).toBe("delivered");

    // The idempotency key on the wire matches the stable derivation — the key a
    // duplicate (post-crash) send would carry verbatim.
    expect(stub.requests[0].headers["x-maister-idempotency-key"]).toBe(
      expectedIdempotencyKey(subId, eventId),
    );
  });
});
