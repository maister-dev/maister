/**
 * `IT-NTF-04` / `IT-NTF-05` / `IT-EDGE-NTF-02` — the push sender's two-phase commit
 * and its failure table (ADR-172 D7).
 *
 * The push wire is stubbed at `web-push`, not at HTTP: `webpush.sendNotification`
 * performs ECDH key agreement against the subscription's real keys, and
 * generating a valid browser key pair per case would test the crypto library
 * rather than the delivery discipline. What is under test is the LEDGER: what
 * the row looks like before the send, after a success, after each failure class,
 * and what happens to the endpoint on a `410`.
 */

import { randomUUID } from "node:crypto";

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
  vi,
} from "vitest";

import * as fullSchema from "@/lib/db/schema";
import { testPlatformRunnerRow } from "@/lib/__tests__/runner-fixtures";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

const schema = fullSchema as unknown as Record<string, any>;

// The one seam: the HTTP call `web-push` makes. Everything else is real.
const sendNotification = vi.fn();

vi.mock("web-push", () => ({
  default: {
    sendNotification: (...args: unknown[]) => sendNotification(...args),
  },
}));

let testDatabase: StartedPostgresTestDb;
let db: NodePgDatabase;
let runWebhookDeliveryJob: typeof import("@/lib/scheduler/handlers/webhook-delivery").runWebhookDeliveryJob;

const VAPID = {
  MAISTER_VAPID_PUBLIC_KEY: "BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkFZAvmiCpg",
  MAISTER_VAPID_PRIVATE_KEY: "dGhpcy1pcy1hLWZha2UtcHJpdmF0ZS1rZXk",
  MAISTER_VAPID_SUBJECT: "mailto:ops@example.com",
} as const;

let savedEnv: Record<string, string | undefined> = {};

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "push_delivery_test",
  });
  db = testDatabase.db;
  ({ runWebhookDeliveryJob } = await import(
    "@/lib/scheduler/handlers/webhook-delivery"
  ));
}, 180_000);

afterAll(async () => {
  await testDatabase?.stop();
});

beforeEach(async () => {
  await db.execute(sql`
    TRUNCATE webhook_subscriptions, webhook_events, webhook_deliveries,
             webhook_delivery_attempts, push_subscriptions,
             notification_subscriptions RESTART IDENTITY CASCADE
  `);

  savedEnv = {};
  for (const [k, v] of Object.entries(VAPID)) {
    savedEnv[k] = process.env[k];
    process.env[k] = v;
  }

  sendNotification.mockReset();

  const runnerId = randomUUID();

  await db
    .insert(schema.platformAcpRunners)
    .values(testPlatformRunnerRow(runnerId, "claude"));
  await db.execute(sql`
    INSERT INTO platform_runtime_settings (id, default_runner_id, webhooks_enabled)
    VALUES ('singleton', ${runnerId}, true)
    ON CONFLICT (id) DO UPDATE SET webhooks_enabled = true
  `);
});

afterEach(() => {
  for (const [k] of Object.entries(VAPID)) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

interface Reader {
  userId: string;
  pushId: string;
}

async function seedReader(
  eventTypes: string[] = ["attention.digest"],
  enabled = true,
): Promise<Reader> {
  const userId = randomUUID();
  const pushId = randomUUID();

  await db.insert(schema.users).values({
    id: userId,
    email: `${userId}@push.test`,
    role: "member",
    accountStatus: "active",
    passwordHash: "x",
  });
  await db.insert(schema.pushSubscriptions).values({
    id: pushId,
    ownerUserId: userId,
    endpoint: `https://push.example.invalid/${pushId}`,
    p256dh: "fake-p256dh",
    auth: "fake-auth",
  });
  await db.insert(schema.notificationSubscriptions).values({
    id: randomUUID(),
    ownerUserId: userId,
    transport: "web_push",
    eventTypes,
    enabled,
  });

  return { userId, pushId };
}

async function emitDigest(ownerUserId: string): Promise<string> {
  const { emitWebhookEvent } = await import("@/lib/webhooks/outbox");

  return emitWebhookEvent({
    db,
    type: "attention.digest",
    ownerUserId,
    data: {
      sentence: "2 promoted · 1 crashed",
      title: "Since your last visit",
    },
  });
}

interface Row {
  id: string;
  status: string;
  attempt_count: number;
  delivered_at: Date | null;
  next_attempt_at: Date;
  last_http_status: number | null;
  last_error_kind: string | null;
  push_subscription_id: string | null;
}

async function pushRow(eventId: string): Promise<Row | undefined> {
  const r = await db.execute(sql`
    SELECT id, status, attempt_count, delivered_at, next_attempt_at,
           last_http_status, last_error_kind, push_subscription_id
    FROM webhook_deliveries
    WHERE event_id = ${eventId} AND push_subscription_id IS NOT NULL
  `);

  return r.rows[0] as unknown as Row | undefined;
}

async function attemptCount(deliveryId: string): Promise<number> {
  const r = await db.execute(sql`
    SELECT count(*)::int AS n FROM webhook_delivery_attempts
    WHERE delivery_id = ${deliveryId}
  `);

  return (r.rows[0] as unknown as { n: number }).n;
}

// `push.example.invalid` never resolves — `.invalid` is reserved — so the
// ADR-077 send-time egress check refuses it before the wire, exactly as it
// would refuse a private address. Allow-listing the fake host is what the
// operator escape hatch exists for and keeps the guard at full strength for
// every other destination; blanket-disabling the check would delete the
// protection this suite's sibling (`UT-NTF-11`) asserts.
process.env.MAISTER_WEBHOOK_ALLOW_HOSTS = "push.example.invalid";

function gone(status: number): Error {
  const err = new Error(
    `received unexpected response code ${status}`,
  ) as Error & {
    statusCode: number;
  };

  err.statusCode = status;

  return err;
}

describe("IT-NTF-04 the push sender's two-phase commit", () => {
  it("persists the delivery row at fanout, BEFORE any send", async () => {
    const reader = await seedReader();
    const eventId = await emitDigest(reader.userId);

    // Drain is disabled for this assertion by making the send hang until we
    // have inspected the row — the point is that the row exists first.
    let released: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      released = resolve;
    });

    sendNotification.mockImplementation(async () => {
      const row = await pushRow(eventId);

      // Intent is already durable, and NOT yet marked delivered.
      expect(row?.status).toBe("pending");
      expect(row?.delivered_at).toBeNull();
      expect(row?.push_subscription_id).toBe(reader.pushId);
      released();

      return { statusCode: 201 };
    });

    await runWebhookDeliveryJob({ db });
    await gate;

    const after = await pushRow(eventId);

    expect(after?.status).toBe("delivered");
    expect(after?.delivered_at).not.toBeNull();
    expect(after?.last_http_status).toBe(201);
  });

  it("leaves the row retryable with delivered_at null on a 500", async () => {
    const reader = await seedReader();

    sendNotification.mockRejectedValue(gone(500));

    const eventId = await emitDigest(reader.userId);
    const summary = await runWebhookDeliveryJob({ db });

    expect(summary.failed).toBe(1);

    const row = await pushRow(eventId);

    expect(row?.status).toBe("pending");
    expect(row?.delivered_at).toBeNull();
    expect(row?.attempt_count).toBe(1);
    expect(new Date(row!.next_attempt_at).getTime()).toBeGreaterThan(
      Date.now(),
    );
    expect(await attemptCount(row!.id)).toBe(1);
  });

  it("retries a network failure and a timeout, not just an HTTP one", async () => {
    const reader = await seedReader();

    sendNotification.mockRejectedValue(new Error("socket hang up"));

    const eventId = await emitDigest(reader.userId);

    await runWebhookDeliveryJob({ db });

    const row = await pushRow(eventId);

    expect(row?.status).toBe("pending");
    expect(row?.last_error_kind).toBe("network");
  });

  it("holds a notification retryable while VAPID is unconfigured", async () => {
    // NTF-10: an operator who exports the keys later must see the queued
    // notification arrive, not find it dead.
    const reader = await seedReader();

    delete process.env.MAISTER_VAPID_PRIVATE_KEY;

    const eventId = await emitDigest(reader.userId);

    await runWebhookDeliveryJob({ db });

    const row = await pushRow(eventId);

    expect(row?.status).toBe("pending");
    expect(row?.last_error_kind).toBe("config");
    expect(sendNotification).not.toHaveBeenCalled();
  });
});

describe("IT-NTF-05 / IT-EDGE-NTF-02 an expired endpoint", () => {
  it("deletes the subscription on 410 rather than retrying it", async () => {
    const reader = await seedReader();

    sendNotification.mockRejectedValue(gone(410));

    const eventId = await emitDigest(reader.userId);

    await runWebhookDeliveryJob({ db });

    const remaining = await db.execute(sql`
      SELECT 1 FROM push_subscriptions WHERE id = ${reader.pushId}
    `);

    expect(remaining.rows).toHaveLength(0);
    // The delivery row cascaded away with its endpoint; the event survives.
    expect(await pushRow(eventId)).toBeUndefined();

    const event = await db.execute(sql`
      SELECT 1 FROM webhook_events WHERE id = ${eventId}
    `);

    expect(event.rows).toHaveLength(1);
  });

  it("treats 404 as gone too", async () => {
    const reader = await seedReader();

    sendNotification.mockRejectedValue(gone(404));
    await emitDigest(reader.userId);
    await runWebhookDeliveryJob({ db });

    const remaining = await db.execute(sql`
      SELECT 1 FROM push_subscriptions WHERE id = ${reader.pushId}
    `);

    expect(remaining.rows).toHaveLength(0);
  });

  it("leaves the reader's OTHER browsers alone", async () => {
    const reader = await seedReader();
    const secondPushId = randomUUID();

    await db.insert(schema.pushSubscriptions).values({
      id: secondPushId,
      ownerUserId: reader.userId,
      endpoint: `https://push.example.invalid/${secondPushId}`,
      p256dh: "fake-p256dh-2",
      auth: "fake-auth-2",
    });

    // The first endpoint is gone, the second accepts.
    sendNotification.mockImplementation(
      async (target: { endpoint: string }) => {
        if (target.endpoint.includes(reader.pushId)) throw gone(410);

        return { statusCode: 201 };
      },
    );

    await emitDigest(reader.userId);
    await runWebhookDeliveryJob({ db });

    const rows = await db.execute(sql`
      SELECT id FROM push_subscriptions WHERE owner_user_id = ${reader.userId}
    `);

    expect(rows.rows.map((r) => (r as { id: string }).id)).toEqual([
      secondPushId,
    ]);
  });

  it("keeps the notification INTENT when an endpoint expires", async () => {
    // The intent says "notify me on web push"; one dead browser does not revoke
    // it, or a reader would silently stop being notified after changing laptops.
    const reader = await seedReader();

    sendNotification.mockRejectedValue(gone(410));
    await emitDigest(reader.userId);
    await runWebhookDeliveryJob({ db });

    const intents = await db.execute(sql`
      SELECT 1 FROM notification_subscriptions
      WHERE owner_user_id = ${reader.userId} AND transport = 'web_push'
    `);

    expect(intents.rows).toHaveLength(1);
  });
});

describe("IT-NTF-05 a 4xx the push service will never accept", () => {
  it("settles dead on a 403 instead of spending the whole retry curve", async () => {
    const reader = await seedReader();

    sendNotification.mockRejectedValue(gone(403));

    const eventId = await emitDigest(reader.userId);

    await runWebhookDeliveryJob({ db });

    const row = await pushRow(eventId);

    // The discriminant against the 500 case above: same attempt number, same
    // non-2xx status, opposite verdict. `classifyResult` cannot tell them
    // apart from the status alone — it would schedule a retry for both — so a
    // `pending` row here means the sender's `terminal` verdict was dropped.
    expect(row?.status).toBe("dead");
    expect(row?.delivered_at).toBeNull();
    expect(row?.last_http_status).toBe(403);
    expect(row?.attempt_count).toBe(1);
    expect(await attemptCount(row!.id)).toBe(1);

    // Terminal means terminal: a later drain must not pick it up again.
    sendNotification.mockClear();
    await runWebhookDeliveryJob({ db });
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it("keeps the endpoint — a rejected request is not a dead browser", async () => {
    const reader = await seedReader();

    sendNotification.mockRejectedValue(gone(413));
    await emitDigest(reader.userId);
    await runWebhookDeliveryJob({ db });

    const remaining = await db.execute(sql`
      SELECT 1 FROM push_subscriptions WHERE id = ${reader.pushId}
    `);

    expect(remaining.rows).toHaveLength(1);
  });
});

describe("IT-EDGE-NTF-04 a 4xx that means later, not no", () => {
  it("retries a 429 on the normal curve rather than settling it dead", async () => {
    const reader = await seedReader();

    sendNotification.mockRejectedValue(gone(429));

    const eventId = await emitDigest(reader.userId);

    await runWebhookDeliveryJob({ db });

    const row = await pushRow(eventId);

    expect(row?.status).toBe("pending");
    expect(row?.last_http_status).toBe(429);
    expect(new Date(row!.next_attempt_at).getTime()).toBeGreaterThan(
      Date.now(),
    );
  });

  it("retries a 408 too", async () => {
    const reader = await seedReader();

    sendNotification.mockRejectedValue(gone(408));

    const eventId = await emitDigest(reader.userId);

    await runWebhookDeliveryJob({ db });

    expect((await pushRow(eventId))?.status).toBe("pending");
  });
});

describe("NTF-08 the intent gates delivery", () => {
  it("sends nothing when the reader has no web_push intent", async () => {
    const reader = await seedReader([], false);

    await db.execute(sql`
      DELETE FROM notification_subscriptions
      WHERE owner_user_id = ${reader.userId}
    `);

    const eventId = await emitDigest(reader.userId);

    await runWebhookDeliveryJob({ db });

    expect(await pushRow(eventId)).toBeUndefined();
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it("sends nothing when the intent does not name this event type", async () => {
    const reader = await seedReader(["attention.decision_opened"]);
    const eventId = await emitDigest(reader.userId);

    await runWebhookDeliveryJob({ db });

    expect(await pushRow(eventId)).toBeUndefined();
  });

  it("sends nothing when the intent is disabled", async () => {
    const reader = await seedReader(["attention.digest"], false);
    const eventId = await emitDigest(reader.userId);

    await runWebhookDeliveryJob({ db });

    expect(await pushRow(eventId)).toBeUndefined();
  });
});

describe("EDGE-NTF-01 at-least-once converges to one notification", () => {
  it("a second fanout of the same event creates no second delivery", async () => {
    const reader = await seedReader();

    sendNotification.mockResolvedValue({ statusCode: 201 });

    const eventId = await emitDigest(reader.userId);

    await runWebhookDeliveryJob({ db });
    // Re-open the event for fanout, exactly as a redelivery would.
    await db.execute(sql`
      UPDATE webhook_events SET fanout_at = NULL WHERE id = ${eventId}
    `);
    await runWebhookDeliveryJob({ db });

    const rows = await db.execute(sql`
      SELECT count(*)::int AS n FROM webhook_deliveries
      WHERE event_id = ${eventId} AND push_subscription_id IS NOT NULL
    `);

    expect((rows.rows[0] as unknown as { n: number }).n).toBe(1);
    expect(sendNotification).toHaveBeenCalledTimes(1);
  });
});
