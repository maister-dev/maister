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
let runDecisionsDeltaBackstop: (opts?: {
  db?: unknown;
}) => Promise<{ candidates: number; emitted: number; errors: string[] }>;

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "digest_trigger_test",
  });
  db = testDatabase.db;
  // Imported AFTER the mock is registered.
  ({ runDigestTrigger, DIGEST_MIN_INTERVAL_MS, runDecisionsDeltaBackstop } =
    await import("@/lib/notifications/digest-trigger"));
}, 180_000);

afterAll(async () => {
  await testDatabase?.stop();
});

beforeEach(async () => {
  await db.execute(sql`
    TRUNCATE domain_events, webhook_events, webhook_deliveries, notification_subscriptions,
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

/**
 * A `Crashed` run owing recover/discard — one of the four decision populations,
 * and the cheapest to produce: no HITL row, no domain event, no ACP session.
 * Emitting nothing is exactly what makes it the right fixture for the backstop.
 */
/** A run the event helpers can be pointed at. Returns the ids they need. */
async function seedRunForEvents(): Promise<{
  runId: string;
  projectId: string;
  taskId: string;
}> {
  const projectId = randomUUID();
  const slug = `ev-${projectId.slice(0, 8)}`;
  const flowId = randomUUID();
  const taskId = randomUUID();
  const runId = randomUUID();

  await db.insert(schema.projects).values({
    taskKey: `E${randomUUID().slice(0, 8)}`.toUpperCase(),
    id: projectId,
    slug,
    name: slug,
    repoPath: `/tmp/${slug}`,
    maisterYamlPath: "/tmp/m.yaml",
  });
  await db.insert(schema.flows).values({
    id: flowId,
    projectId,
    flowRefId: "aif",
    source: "github.com/x/y",
    version: "v1.0.0",
    installedPath: "/tmp/flows/aif",
    manifest: { schemaVersion: 1, name: "aif", nodes: [] },
    schemaVersion: 1,
  });
  await db.insert(schema.tasks).values({
    id: taskId,
    projectId,
    number: 1,
    title: "event fixture",
    prompt: "p",
    flowId,
    status: "InFlight",
    stage: "Backlog",
    triageStatus: "triaged",
  });
  await db.insert(schema.runs).values({
    id: runId,
    taskId,
    projectId,
    flowId,
    status: "Running",
    flowVersion: "v1.0.0",
    currentStepId: "implement",
  });

  return { runId, projectId, taskId };
}

async function seedCrashedDecision(): Promise<void> {
  const projectId = randomUUID();
  const slug = `bk-${projectId.slice(0, 8)}`;
  const flowId = randomUUID();
  const taskId = randomUUID();
  const runId = randomUUID();

  await db.insert(schema.projects).values({
    taskKey: `B${randomUUID().slice(0, 8)}`.toUpperCase(),
    id: projectId,
    slug,
    name: slug,
    repoPath: `/tmp/${slug}`,
    maisterYamlPath: "/tmp/m.yaml",
  });
  await db.insert(schema.flows).values({
    id: flowId,
    projectId,
    flowRefId: "aif",
    source: "github.com/x/y",
    version: "v1.0.0",
    installedPath: "/tmp/flows/aif",
    manifest: { schemaVersion: 1, name: "aif", nodes: [] },
    schemaVersion: 1,
  });
  await db.insert(schema.tasks).values({
    id: taskId,
    projectId,
    number: 1,
    title: "crashed work",
    prompt: "p",
    flowId,
    status: "InFlight",
    stage: "Backlog",
    triageStatus: "triaged",
  });
  await db.insert(schema.runs).values({
    id: runId,
    taskId,
    projectId,
    flowId,
    status: "Crashed",
    flowVersion: "v1.0.0",
    currentStepId: "implement",
    endedAt: new Date(),
  });
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

// ---------------------------------------------------------------------------
// IT-NTF-14 — the delta BACKSTOP, which is what actually makes a decision
// notification fire.
//
// ADR-173 D5 made the domain-event consumer the delta trigger. That assumed the
// taxonomy covers decision transitions, and it does not: `DOMAIN_EVENT_KINDS`
// has no member for a HITL opening or a run entering `NeedsInput`, and
// `run.review` is emitted only for runs WITH a parent
// (`emitDelegatedReviewIfChild` returns early on `!parentRunId`). So the two
// commonest ways a decision opens wake the consumer never.
//
// These cases therefore emit NO domain event at all — that is the point. If the
// backstop is removed, nothing is emitted and every assertion below fails.
// ---------------------------------------------------------------------------
describe("IT-NTF-14 the decisions delta backstop", () => {
  async function deltaEvents(ownerUserId: string) {
    const rows = await db.execute(sql`
      SELECT type, data FROM webhook_events
      WHERE data->>'ownerUserId' = ${ownerUserId}
        AND type LIKE 'attention.decision%'
      ORDER BY occurred_at
    `);

    return rows.rows as Array<{ type: string; data: Record<string, unknown> }>;
  }

  async function subscribeToDeltas(userId: string): Promise<void> {
    await db.insert(schema.notificationSubscriptions).values({
      id: randomUUID(),
      ownerUserId: userId,
      transport: "web_push",
      eventTypes: ["attention.decision_opened", "attention.decisions_changed"],
      enabled: true,
    });
  }

  it("emits a delta with no domain event anywhere in the picture", async () => {
    const reader = await seedReader({ wantsDigest: false });

    await subscribeToDeltas(reader);
    await seedCrashedDecision();

    const summary = await runDecisionsDeltaBackstop({ db });

    expect(summary.errors).toEqual([]);
    expect(summary.emitted).toBe(1);

    const events = await deltaEvents(reader);

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("attention.decision_opened");
    expect(events[0].data.decisions).toBe(1);
  });

  it("is idempotent — a second tick over unchanged state emits nothing", async () => {
    const reader = await seedReader({ wantsDigest: false });

    await subscribeToDeltas(reader);
    await seedCrashedDecision();

    await runDecisionsDeltaBackstop({ db });
    const second = await runDecisionsDeltaBackstop({ db });

    expect(second.emitted).toBe(0);
    expect(await deltaEvents(reader)).toHaveLength(1);
  });

  it("leaves a reader who asked for nothing alone", async () => {
    const reader = await seedReader({ wantsDigest: false });

    await seedCrashedDecision();
    await runDecisionsDeltaBackstop({ db });

    expect(await deltaEvents(reader)).toEqual([]);
  });

  it("does not wake a reader whose intent names only the digest", async () => {
    // The digest is the OTHER trigger and has its own cadence floor; a
    // digest-only subscriber must not start receiving per-delta pushes.
    const reader = await seedReader({ wantsDigest: true });

    await seedCrashedDecision();
    await runDecisionsDeltaBackstop({ db });

    expect(await deltaEvents(reader)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// IT-NTF-15 — the two decision-OPENING events, end to end.
//
// This is the half the backstop was compensating for. `createHitlRequest` is the
// only writer of `hitl_requests` and emits `run.needs_input`;
// `emitDelegatedReviewIfChild` emits `run.review_opened` for a run with no
// parent. Both land in `domain_events` in the same transaction as the row they
// describe, and the attention consumer wakes on them.
// ---------------------------------------------------------------------------
describe("IT-NTF-15 decision-opening domain events", () => {
  async function kinds(runId: string): Promise<string[]> {
    const rows = await db.execute(sql`
      SELECT kind FROM domain_events WHERE run_id = ${runId} ORDER BY id
    `);

    return (rows.rows as Array<{ kind: string }>).map((r) => r.kind);
  }

  it("emits run.needs_input from the one HITL writer", async () => {
    const { runId } = await seedRunForEvents();
    const { createHitlRequest } = await import("@/lib/runs/hitl-create");

    await createHitlRequest(db, {
      id: randomUUID(),
      runId,
      stepId: "implement",
      kind: "permission",
      prompt: "may I write the file?",
    });

    expect(await kinds(runId)).toContain("run.needs_input");
  });

  it("stays silent when the caller says the row opens no new decision", async () => {
    const { runId } = await seedRunForEvents();
    const { createHitlRequest } = await import("@/lib/runs/hitl-create");

    await createHitlRequest(
      db,
      {
        id: randomUUID(),
        runId,
        stepId: "implement",
        kind: "permission",
        prompt: "superseding an answered one",
      },
      { silent: true },
    );

    expect(await kinds(runId)).not.toContain("run.needs_input");
  });

  it("emits run.review_opened for a TOP-LEVEL run, not run.review", async () => {
    const { runId, projectId, taskId } = await seedRunForEvents();
    const { emitDelegatedReviewIfChild } = await import(
      "@/lib/runs/delegated-review-emit"
    );

    const emitted = await emitDelegatedReviewIfChild(db, {
      runId,
      projectId,
      taskId,
      flowId: null,
      runKind: "flow",
      parentRunId: null,
      cause: "graph_complete",
      resultStatus: null,
    } as never);

    // Before this, a top-level Review emitted NOTHING — the helper returned
    // false on `!parentRunId` — which is why the commonest promotable decision
    // could never wake the consumer.
    expect(emitted).toBe(true);

    const seen = await kinds(runId);

    expect(seen).toContain("run.review_opened");
    // The orchestrator's kind must NOT widen: its population is unchanged.
    expect(seen).not.toContain("run.review");
  });

  it("still emits run.review for a delegated CHILD", async () => {
    const parent = await seedRunForEvents();
    const child = await seedRunForEvents();
    const { emitDelegatedReviewIfChild } = await import(
      "@/lib/runs/delegated-review-emit"
    );

    await emitDelegatedReviewIfChild(db, {
      runId: child.runId,
      projectId: child.projectId,
      taskId: child.taskId,
      flowId: null,
      runKind: "flow",
      parentRunId: parent.runId,
      cause: "graph_complete",
      resultStatus: null,
    } as never);

    const seen = await kinds(child.runId);

    expect(seen).toContain("run.review");
    expect(seen).not.toContain("run.review_opened");
  });
});
