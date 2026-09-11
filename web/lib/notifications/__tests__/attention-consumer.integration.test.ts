/**
 * `IT-NTF-08` / `IT-EDGE-NTF-01` — the consumer against a real outbox.
 *
 * The unit test owns the delta ARITHMETIC; this owns the part that only a
 * database can show: that the previous value is read back out of the consumer's
 * own emissions (which is what lets it stay "one entry plus a cursor row"), and
 * that a redelivered window therefore emits nothing the second time.
 */

import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import * as fullSchema from "@/lib/db/schema";
import { buildAttentionConsumer } from "@/lib/notifications/attention-consumer";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

const schema = fullSchema as unknown as Record<string, any>;

let testDatabase: StartedPostgresTestDb;
let db: NodePgDatabase;

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "attention_consumer_test",
  });
  db = testDatabase.db;
}, 180_000);

afterAll(async () => {
  await testDatabase?.stop();
});

beforeEach(async () => {
  await db.execute(sql`
    TRUNCATE webhook_events, webhook_deliveries, webhook_delivery_attempts,
             project_members, projects, users RESTART IDENTITY CASCADE
  `);
});

async function seedMember(projectId: string): Promise<string> {
  const userId = randomUUID();

  await db.insert(schema.users).values({
    id: userId,
    email: `${userId}@atn.test`,
    role: "member",
    accountStatus: "active",
    passwordHash: "x",
  });
  await db.insert(schema.projectMembers).values({
    projectId,
    userId,
    role: "member",
  });

  return userId;
}

async function seedProject(): Promise<string> {
  const projectId = randomUUID();
  const slug = `atn-${projectId.slice(0, 8)}`;

  await db.insert(schema.projects).values({
    taskKey: `T${randomUUID().slice(0, 8)}`.toUpperCase(),
    id: projectId,
    slug,
    name: slug,
    repoPath: `/tmp/${slug}`,
    maisterYamlPath: "/tmp/m.yaml",
  });

  return projectId;
}

function event(projectId: string, kind = "run.crashed") {
  return {
    id: BigInt(Date.now() + Math.floor(Math.random() * 1000)),
    kind,
    projectId,
    runId: null,
    taskId: null,
    actorType: null,
    actorId: null,
    payload: {},
    occurredAt: new Date(),
  } as unknown as fullSchema.DomainEventRow;
}

async function emissions(
  ownerUserId: string,
): Promise<Array<{ type: string; decisions: number; previous: number }>> {
  const r = await db.execute(sql`
    SELECT type,
           (data->>'decisions')::int AS decisions,
           (data->>'previous')::int AS previous
    FROM webhook_events
    WHERE data->>'ownerUserId' = ${ownerUserId}
    ORDER BY occurred_at, id
  `);

  return r.rows as unknown as Array<{
    type: string;
    decisions: number;
    previous: number;
  }>;
}

describe("IT-NTF-08 the consumer emits on deltas only", () => {
  it("emits nothing when the reader's count did not move", async () => {
    const projectId = await seedProject();
    const userId = await seedMember(projectId);
    // Count stays at zero: three events, no notification.
    const consumer = buildAttentionConsumer({
      db,
      decisionsFor: async () => 0,
    });

    await consumer.handle([
      event(projectId),
      event(projectId, "run.failed"),
      event(projectId, "gate.failed"),
    ]);

    expect(await emissions(userId)).toEqual([]);
  });

  it("emits ONE notification for a window of several events", async () => {
    const projectId = await seedProject();
    const userId = await seedMember(projectId);
    const consumer = buildAttentionConsumer({
      db,
      decisionsFor: async () => 3,
    });

    await consumer.handle([
      event(projectId),
      event(projectId, "run.failed"),
      event(projectId, "gate.failed"),
    ]);

    const rows = await emissions(userId);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      type: "attention.decision_opened",
      decisions: 3,
      previous: 0,
    });
  });

  it("ignores a kind outside the attention taxonomy", async () => {
    const projectId = await seedProject();
    const userId = await seedMember(projectId);
    const consumer = buildAttentionConsumer({
      db,
      decisionsFor: async () => 5,
    });

    // `task.created` is a `task_activity` twin, not an attention fact.
    await consumer.handle([event(projectId, "task.created")]);

    expect(await emissions(userId)).toEqual([]);
  });
});

describe("IT-EDGE-NTF-01 at-least-once redelivery converges", () => {
  it("emits nothing the second time the same window arrives", async () => {
    const projectId = await seedProject();
    const userId = await seedMember(projectId);
    const consumer = buildAttentionConsumer({
      db,
      decisionsFor: async () => 2,
    });
    const window = [event(projectId)];

    await consumer.handle(window);
    await consumer.handle(window);
    await consumer.handle(window);

    // The count is recomputed from current state and compared against the last
    // value this consumer PUBLISHED, so a redelivery is a no-op rather than a
    // second buzz.
    expect(await emissions(userId)).toHaveLength(1);
  });

  it("tracks a sequence of real moves without losing one", async () => {
    const projectId = await seedProject();
    const userId = await seedMember(projectId);
    let count = 0;
    const consumer = buildAttentionConsumer({
      db,
      decisionsFor: async () => count,
    });

    for (const next of [2, 2, 5, 0, 0, 1]) {
      count = next;
      await consumer.handle([event(projectId)]);
    }

    expect((await emissions(userId)).map((r) => r.type)).toEqual([
      "attention.decision_opened", // 0 -> 2
      "attention.decisions_changed", // 2 -> 5
      "attention.decision_closed", // 5 -> 0
      "attention.decision_opened", // 0 -> 1
    ]);
  });
});

describe("IT-NTF-08 reader resolution", () => {
  it("notifies a global admin about a project they are not a member of", async () => {
    const projectId = await seedProject();
    const adminId = randomUUID();

    await db.insert(schema.users).values({
      id: adminId,
      email: `${adminId}@atn.test`,
      role: "admin",
      accountStatus: "active",
      passwordHash: "x",
    });

    const consumer = buildAttentionConsumer({
      db,
      decisionsFor: async () => 1,
    });

    await consumer.handle([event(projectId)]);

    expect(await emissions(adminId)).toHaveLength(1);
  });

  it("does not notify a member of a different project", async () => {
    const projectA = await seedProject();
    const projectB = await seedProject();
    const outsider = await seedMember(projectB);
    const consumer = buildAttentionConsumer({
      db,
      decisionsFor: async () => 1,
    });

    await consumer.handle([event(projectA)]);

    expect(await emissions(outsider)).toEqual([]);
  });

  it("does not notify an inactive account", async () => {
    const projectId = await seedProject();
    const userId = await seedMember(projectId);

    await db.execute(sql`
      UPDATE users SET account_status = 'disabled' WHERE id = ${userId}
    `);

    const consumer = buildAttentionConsumer({
      db,
      decisionsFor: async () => 1,
    });

    await consumer.handle([event(projectId)]);

    expect(await emissions(userId)).toEqual([]);
  });

  it("never throws when a reader's count cannot be computed (poison safety)", async () => {
    // The dispatcher holds the cursor on a throw, so one failing reader would
    // stall every later event for every consumer.
    const projectId = await seedProject();

    await seedMember(projectId);

    const consumer = buildAttentionConsumer({
      db,
      decisionsFor: async () => {
        throw new Error("queue unavailable");
      },
    });

    await expect(consumer.handle([event(projectId)])).resolves.toBeUndefined();
  });
});
