/**
 * `IT-NTF-07` (ADR-172 D9) — a token owner may CRUD only their OWN
 * subscriptions, and another owner's id answers "not found", never "forbidden".
 *
 * Both halves matter. A positive grant alone would pass against a store that
 * ignores ownership entirely; a negative alone would pass against one that
 * refuses everything. And the negative asserts the SHAPE of the refusal: a 403
 * confirms the row exists, which is a disclosure about somebody else's account.
 *
 * `NTF-06` rides along: nothing in a returned DTO is signing material, because
 * there is no column for it here — secrets stay `env:` references on
 * `webhook_subscriptions` (asserted below).
 */

import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import * as fullSchema from "@/lib/db/schema";
import {
  deleteNotificationSubscription,
  listNotificationSubscriptions,
  registerPushEndpoint,
  countPushEndpoints,
  updateNotificationSubscription,
  upsertNotificationSubscription,
  validateSubscriptionInput,
} from "@/lib/notifications/subscriptions";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

const schema = fullSchema as unknown as Record<string, any>;

let testDatabase: StartedPostgresTestDb;
let db: NodePgDatabase;

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "notification_subs_test",
  });
  db = testDatabase.db;
}, 180_000);

afterAll(async () => {
  await testDatabase?.stop();
});

beforeEach(async () => {
  await db.execute(sql`
    TRUNCATE notification_subscriptions, push_subscriptions, users
    RESTART IDENTITY CASCADE
  `);
});

async function seedUser(): Promise<string> {
  const id = randomUUID();

  await db.insert(schema.users).values({
    id,
    email: `${id}@ns.test`,
    role: "member",
    accountStatus: "active",
    passwordHash: "x",
  });

  return id;
}

const DIGEST_ONLY = {
  eventTypes: ["attention.digest"] as const,
  transport: "web_push" as const,
};

describe("IT-NTF-07 a token owner reaches only their own subscriptions", () => {
  it("creates, lists, updates and deletes its own", async () => {
    const owner = await seedUser();
    const created = await upsertNotificationSubscription(
      owner,
      { ...DIGEST_ONLY, eventTypes: [...DIGEST_ONLY.eventTypes] },
      db,
    );

    expect(created.transport).toBe("web_push");
    expect(created.eventTypes).toEqual(["attention.digest"]);
    expect(await listNotificationSubscriptions(owner, db)).toHaveLength(1);

    const updated = await updateNotificationSubscription(
      owner,
      created.id,
      {
        eventTypes: ["attention.decision_opened", "attention.digest"],
        transport: "web_push",
        enabled: false,
      },
      db,
    );

    expect(updated?.enabled).toBe(false);
    expect(updated?.eventTypes).toEqual([
      "attention.decision_opened",
      "attention.digest",
    ]);
    expect(await deleteNotificationSubscription(owner, created.id, db)).toBe(
      true,
    );
    expect(await listNotificationSubscriptions(owner, db)).toEqual([]);
  });

  it("does not list another owner's subscriptions", async () => {
    const a = await seedUser();
    const b = await seedUser();

    await upsertNotificationSubscription(
      b,
      { ...DIGEST_ONLY, eventTypes: [...DIGEST_ONLY.eventTypes] },
      db,
    );

    expect(await listNotificationSubscriptions(a, db)).toEqual([]);
  });

  it("answers NOT FOUND, never forbidden, when updating another owner's row", async () => {
    const a = await seedUser();
    const b = await seedUser();
    const theirs = await upsertNotificationSubscription(
      b,
      { ...DIGEST_ONLY, eventTypes: [...DIGEST_ONLY.eventTypes] },
      db,
    );

    // `null` is what the route turns into a 404. Crucially the row is NOT
    // mutated: a "forbidden" implementation that reads first and then refuses
    // would still have confirmed the row exists.
    expect(
      await updateNotificationSubscription(
        a,
        theirs.id,
        { eventTypes: ["attention.digest"], transport: "webhook" },
        db,
      ),
    ).toBeNull();

    const after = await listNotificationSubscriptions(b, db);

    expect(after[0].transport).toBe("web_push");
  });

  it("does not delete another owner's row", async () => {
    const a = await seedUser();
    const b = await seedUser();
    const theirs = await upsertNotificationSubscription(
      b,
      { ...DIGEST_ONLY, eventTypes: [...DIGEST_ONLY.eventTypes] },
      db,
    );

    expect(await deleteNotificationSubscription(a, theirs.id, db)).toBe(false);
    expect(await listNotificationSubscriptions(b, db)).toHaveLength(1);
  });

  it("keeps one intent per transport rather than accumulating rows", async () => {
    const owner = await seedUser();

    await upsertNotificationSubscription(
      owner,
      { eventTypes: ["attention.digest"], transport: "web_push" },
      db,
    );
    await upsertNotificationSubscription(
      owner,
      { eventTypes: ["attention.decision_opened"], transport: "web_push" },
      db,
    );

    const rows = await listNotificationSubscriptions(owner, db);

    expect(rows).toHaveLength(1);
    expect(rows[0].eventTypes).toEqual(["attention.decision_opened"]);
  });
});

describe("NTF-08 the input validator refuses a per-event subscription", () => {
  it("accepts only the four attention types", () => {
    expect(() =>
      validateSubscriptionInput({
        eventTypes: ["run.done"],
        transport: "web_push",
      }),
    ).toThrow(/attention\./u);
  });

  it("refuses an empty type list", () => {
    expect(() =>
      validateSubscriptionInput({ eventTypes: [], transport: "web_push" }),
    ).toThrow(/non-empty/u);
  });

  it("refuses an unknown transport", () => {
    expect(() =>
      validateSubscriptionInput({
        eventTypes: ["attention.digest"],
        transport: "telegram",
      }),
    ).toThrow(/transport/u);
  });

  it("REFUSES a body naming an owner rather than ignoring it", () => {
    // D9: dropping it silently would let a caller believe they had set an owner.
    for (const key of ["ownerUserId", "owner", "userId"]) {
      expect(() =>
        validateSubscriptionInput({
          [key]: "someone-else",
          eventTypes: ["attention.digest"],
          transport: "web_push",
        }),
      ).toThrow(/authenticated context/u);
    }
  });

  it("normalizes the type list so two equivalent requests store the same row", () => {
    const a = validateSubscriptionInput({
      eventTypes: ["attention.digest", "attention.decision_opened"],
      transport: "webhook",
    });
    const b = validateSubscriptionInput({
      eventTypes: [
        "attention.decision_opened",
        "attention.digest",
        "attention.digest",
      ],
      transport: "webhook",
    });

    expect(a.eventTypes).toEqual(b.eventTypes);
  });
});

describe("IT-NTF-07 push endpoints are owner-scoped and idempotent", () => {
  it("re-registering the same browser updates rather than duplicates", async () => {
    const owner = await seedUser();
    const endpoint = "https://push.example.invalid/abc";

    const first = await registerPushEndpoint(
      owner,
      { endpoint, p256dh: "k1", auth: "a1" },
      db,
    );
    const second = await registerPushEndpoint(
      owner,
      { endpoint, p256dh: "k2", auth: "a2" },
      db,
    );

    expect(second.id).toBe(first.id);
    expect(await countPushEndpoints(owner, db)).toBe(1);

    const row = await db.execute(sql`
      SELECT p256dh FROM push_subscriptions WHERE id = ${first.id}
    `);

    expect((row.rows[0] as unknown as { p256dh: string }).p256dh).toBe("k2");
  });

  it("lets two owners hold the same endpoint string without collision", async () => {
    // The unique constraint is on (owner, endpoint), not on endpoint: two
    // accounts on one shared browser profile is unusual but not an error.
    const a = await seedUser();
    const b = await seedUser();
    const endpoint = "https://push.example.invalid/shared";

    await registerPushEndpoint(a, { endpoint, p256dh: "x", auth: "y" }, db);
    await registerPushEndpoint(b, { endpoint, p256dh: "x", auth: "y" }, db);

    expect(await countPushEndpoints(a, db)).toBe(1);
    expect(await countPushEndpoints(b, db)).toBe(1);
  });

  it("cascades both tables when the owner is deleted", async () => {
    const owner = await seedUser();

    await registerPushEndpoint(
      owner,
      { endpoint: "https://push.example.invalid/z", p256dh: "x", auth: "y" },
      db,
    );
    await upsertNotificationSubscription(
      owner,
      { eventTypes: ["attention.digest"], transport: "web_push" },
      db,
    );
    await db.execute(sql`DELETE FROM users WHERE id = ${owner}`);

    expect(await countPushEndpoints(owner, db)).toBe(0);
    expect(await listNotificationSubscriptions(owner, db)).toEqual([]);
  });
});

describe("NTF-06 no signing material lives in these tables", () => {
  it("has no secret-bearing column on either new table", async () => {
    const cols = await db.execute(sql`
      SELECT table_name, column_name
      FROM information_schema.columns
      WHERE table_name IN ('notification_subscriptions', 'push_subscriptions')
    `);
    const names = (cols.rows as unknown as Array<{ column_name: string }>).map(
      (r) => r.column_name,
    );

    for (const forbidden of ["secret", "signing_secret", "token", "password"]) {
      expect(names, forbidden).not.toContain(forbidden);
    }
  });

  it("keeps webhook signing material an env reference", async () => {
    // The gate must still see what it forbids elsewhere: `webhook_subscriptions`
    // is where signing material lives, and it is a REFERENCE.
    const cols = await db.execute(sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'webhook_subscriptions'
    `);
    const names = (cols.rows as unknown as Array<{ column_name: string }>).map(
      (r) => r.column_name,
    );

    expect(names).toContain("signing_secret_ref");
    expect(names).not.toContain("signing_secret");
  });
});
