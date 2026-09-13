/**
 * `IT-NTF-02` — the platform scope must not absorb user-owned subscriptions.
 *
 * This is ADR-173 D3's bug one layer UP, and the D2 reader enumeration is what
 * surfaced it. `subscriptions.ts` expresses "platform-wide" as
 * `project_id IS NULL`. A user subscription also has `project_id IS NULL`, so
 * the moment `owner_user_id` exists, every platform-scope query in the admin
 * settings surface starts listing, updating, deleting and exposing the
 * deliveries of other people's PERSONAL subscriptions.
 *
 * "Platform" therefore means `project_id IS NULL AND owner_user_id IS NULL`.
 */

import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import * as fullSchema from "@/lib/db/schema";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

const schema = fullSchema as unknown as Record<string, any>;

let testDatabase: StartedPostgresTestDb;
let db: NodePgDatabase;

let listSubscriptions: typeof import("@/lib/webhooks/subscriptions").listSubscriptions;
let getSubscription: typeof import("@/lib/webhooks/subscriptions").getSubscription;
let deleteSubscription: typeof import("@/lib/webhooks/subscriptions").deleteSubscription;
let listDeliveries: typeof import("@/lib/webhooks/subscriptions").listDeliveries;

const PLATFORM = { projectId: null } as const;

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "platform_scope_owned_test",
  });
  db = testDatabase.db;
  ({ listSubscriptions, getSubscription, deleteSubscription, listDeliveries } =
    await import("@/lib/webhooks/subscriptions"));
}, 180_000);

afterAll(async () => {
  await testDatabase?.stop();
});

beforeEach(async () => {
  await db.execute(sql`
    TRUNCATE webhook_subscriptions, webhook_events, webhook_deliveries,
             webhook_delivery_attempts RESTART IDENTITY CASCADE
  `);
});

async function seedUser(): Promise<string> {
  const id = randomUUID();

  await db.insert(schema.users).values({
    id,
    email: `${id}@scope.test`,
    role: "member",
    accountStatus: "active",
    passwordHash: "x",
  });

  return id;
}

async function seedSubscription(ownerUserId: string | null): Promise<string> {
  const id = randomUUID();

  await db.insert(schema.webhookSubscriptions).values({
    id,
    projectId: null,
    ownerUserId,
    name: ownerUserId
      ? `personal-${id.slice(0, 6)}`
      : `platform-${id.slice(0, 6)}`,
    url: "https://example.invalid/hook",
    eventTypes: ["*"],
    signingSecretRef: "env:WH_TEST_SECRET",
    enabled: true,
  });

  return id;
}

describe("IT-NTF-02 the platform scope excludes user-owned subscriptions", () => {
  it("lists only the platform row, not somebody's personal one", async () => {
    const owner = await seedUser();
    const platformId = await seedSubscription(null);

    await seedSubscription(owner);

    const rows = await listSubscriptions(PLATFORM, db);

    expect(rows.map((r) => r.id)).toEqual([platformId]);
  });

  it("does not read a personal subscription through the platform scope", async () => {
    const owner = await seedUser();
    const personalId = await seedSubscription(owner);

    // An id that exists but belongs to a person answers "not found" to the
    // platform scope — the same existence-hiding rule the project scope uses.
    await expect(getSubscription(PLATFORM, personalId, db)).resolves.toBeNull();
  });

  it("does not delete a personal subscription through the platform scope", async () => {
    const owner = await seedUser();
    const personalId = await seedSubscription(owner);

    await expect(deleteSubscription(PLATFORM, personalId, db)).resolves.toBe(
      false,
    );

    const still = await db.execute(sql`
      SELECT 1 FROM webhook_subscriptions WHERE id = ${personalId}
    `);

    expect(still.rows).toHaveLength(1);
  });

  it("does not expose a personal subscription's deliveries", async () => {
    const owner = await seedUser();
    const personalId = await seedSubscription(owner);
    const eventId = randomUUID();

    await db.insert(schema.webhookEvents).values({
      id: eventId,
      projectId: null,
      runId: null,
      type: "attention.digest",
      data: { ownerUserId: owner },
      occurredAt: new Date(),
    });
    await db.insert(schema.webhookDeliveries).values({
      id: randomUUID(),
      eventId,
      subscriptionId: personalId,
      status: "delivered",
      attemptCount: 1,
      nextAttemptAt: new Date(),
      idempotencyKey: randomUUID(),
    });

    const page = await listDeliveries(PLATFORM, personalId, {}, db);

    expect(page.deliveries).toEqual([]);
  });

  it("still finds the platform row it is supposed to manage", async () => {
    // A scope gate that matches nothing is indistinguishable from a broken one.
    const platformId = await seedSubscription(null);

    await expect(
      getSubscription(PLATFORM, platformId, db),
    ).resolves.toMatchObject({ id: platformId });
    await expect(deleteSubscription(PLATFORM, platformId, db)).resolves.toBe(
      true,
    );
  });
});
