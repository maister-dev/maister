/**
 * `IT-NTF-08` (digest half) — the second and only other trigger.
 *
 * The claim under test is "deltas and digests only, never per event": a digest
 * fires at most once per window per reader, never for a reader who did not ask,
 * and never when nothing happened. The SENTENCE's determinism is `UT-ATN-12`'s;
 * this owns when it is sent.
 */

import type { DigestTriggerSummary } from "@/lib/notifications/digest-trigger";

import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import * as fullSchema from "@/lib/db/schema";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

const schema = fullSchema as unknown as Record<string, any>;

let testDatabase: StartedPostgresTestDb;
let db: NodePgDatabase;

// The digest window is computed through `getNowTileCounts` →
// `computeDecisionsQueue` → `getCrossProjectHitlInbox`, and every one of those
// reads the module-level handle. Mocking it is the established integration
// pattern here (`authz-db-authoritative.integration.test.ts`); threading a
// client through `portfolio.ts` would refactor readers this phase does not own.
vi.mock("@/lib/db/client", () => ({
  getDb: () => db,
}));

let runDigestTrigger: (opts?: {
  db?: unknown;
  now?: Date;
}) => Promise<DigestTriggerSummary>;
let DIGEST_MIN_INTERVAL_MS: number;

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "digest_trigger_test",
  });
  db = testDatabase.db;
  // Imported AFTER the mock is registered.
  ({ runDigestTrigger, DIGEST_MIN_INTERVAL_MS } = await import(
    "@/lib/notifications/digest-trigger"
  ));
}, 180_000);

afterAll(async () => {
  await testDatabase?.stop();
});

beforeEach(async () => {
  await db.execute(sql`
    TRUNCATE webhook_events, webhook_deliveries, notification_subscriptions,
             workspaces, runs, tasks, flows, project_members, projects, users
    RESTART IDENTITY CASCADE
  `);
});

async function seedReader(opts: { wantsDigest: boolean }): Promise<string> {
  const userId = randomUUID();

  await db.insert(schema.users).values({
    id: userId,
    email: `${userId}@dg.test`,
    role: "admin",
    accountStatus: "active",
    passwordHash: "x",
  });

  if (opts.wantsDigest) {
    await db.insert(schema.notificationSubscriptions).values({
      id: randomUUID(),
      ownerUserId: userId,
      transport: "web_push",
      eventTypes: ["attention.digest"],
      enabled: true,
    });
  }

  return userId;
}

/**
 * Something for the digest to report. A promoted workspace is the cheapest of
 * the five tiles to produce — no run status machine, no domain event.
 */
async function seedPromotion(): Promise<void> {
  const projectId = randomUUID();
  const slug = `dg-${projectId.slice(0, 8)}`;
  const flowId = randomUUID();
  const taskId = randomUUID();
  const runId = randomUUID();

  await db.insert(schema.projects).values({
    taskKey: `T${randomUUID().slice(0, 8)}`.toUpperCase(),
    id: projectId,
    slug,
    name: slug,
    repoPath: `/tmp/${slug}`,
    maisterYamlPath: "/tmp/m.yaml",
  });
  await db.insert(schema.flows).values({
    id: flowId,
    projectId,
    flowRefId: "bugfix",
    source: "github.com/x/y",
    version: "v1.0.0",
    installedPath: "/tmp/f",
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
    flowVersion: "v1.0.0",
    status: "Done",
  });
  await db.insert(schema.workspaces).values({
    id: randomUUID(),
    runId,
    projectId,
    branch: "maister/x",
    worktreePath: `/tmp/wt-${runId.slice(0, 8)}`,
    parentRepoPath: `/tmp/${slug}`,
    promotedAt: new Date(),
  });
}

async function digests(ownerUserId: string): Promise<string[]> {
  const r = await db.execute(sql`
    SELECT data->>'sentence' AS sentence
    FROM webhook_events
    WHERE type = 'attention.digest' AND data->>'ownerUserId' = ${ownerUserId}
    ORDER BY occurred_at, id
  `);

  return (r.rows as unknown as Array<{ sentence: string }>).map(
    (row) => row.sentence,
  );
}

describe("IT-NTF-08 the digest trigger", () => {
  it("emits one digest carrying the deterministic sentence", async () => {
    const userId = await seedReader({ wantsDigest: true });

    await seedPromotion();

    const summary = await runDigestTrigger({ db });

    expect(summary.candidates).toBe(1);
    expect(summary.emitted).toBe(1);
    expect(await digests(userId)).toEqual(["1 promoted"]);
  });

  it("does not emit for a reader who did not ask", async () => {
    const userId = await seedReader({ wantsDigest: false });

    await seedPromotion();

    const summary = await runDigestTrigger({ db });

    expect(summary.candidates).toBe(0);
    expect(await digests(userId)).toEqual([]);
  });

  it("does not emit when nothing happened", async () => {
    // A digest that says "nothing happened" is the notification a reader mutes
    // the channel over.
    const userId = await seedReader({ wantsDigest: true });
    const summary = await runDigestTrigger({ db });

    expect(summary.skippedEmpty).toBe(1);
    expect(await digests(userId)).toEqual([]);
  });

  it("does not emit twice inside the window, however often the sweep runs", async () => {
    const userId = await seedReader({ wantsDigest: true });

    await seedPromotion();
    await runDigestTrigger({ db });
    await runDigestTrigger({ db });
    await runDigestTrigger({ db });

    expect(await digests(userId)).toHaveLength(1);
  });

  it("emits again once the window has elapsed", async () => {
    const userId = await seedReader({ wantsDigest: true });

    await seedPromotion();
    await runDigestTrigger({ db });

    const later = new Date(Date.now() + DIGEST_MIN_INTERVAL_MS + 60_000);
    const summary = await runDigestTrigger({ db, now: later });

    expect(summary.emitted).toBe(1);
    expect(await digests(userId)).toHaveLength(2);
  });

  it("skips a disabled intent", async () => {
    const userId = await seedReader({ wantsDigest: true });

    await db.execute(sql`
      UPDATE notification_subscriptions SET enabled = false
      WHERE owner_user_id = ${userId}
    `);
    await seedPromotion();

    expect((await runDigestTrigger({ db })).candidates).toBe(0);
  });

  it("skips an intent that does not name the digest", async () => {
    const userId = await seedReader({ wantsDigest: true });

    await db.execute(sql`
      UPDATE notification_subscriptions
      SET event_types = '["attention.decision_opened"]'::jsonb
      WHERE owner_user_id = ${userId}
    `);
    await seedPromotion();

    expect((await runDigestTrigger({ db })).candidates).toBe(0);
  });

  it("writes a project-less, run-less event", async () => {
    const userId = await seedReader({ wantsDigest: true });

    await seedPromotion();
    await runDigestTrigger({ db });

    const r = await db.execute(sql`
      SELECT project_id, run_id FROM webhook_events
      WHERE type = 'attention.digest' AND data->>'ownerUserId' = ${userId}
    `);
    const row = r.rows[0] as unknown as {
      project_id: string | null;
      run_id: string | null;
    };

    expect(row.project_id).toBeNull();
    expect(row.run_id).toBeNull();
  });
});
