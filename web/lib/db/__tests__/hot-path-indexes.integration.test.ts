// IDX-01…IDX-11 (docs/database-schema.md §Hot-path query plan contract,
// migration 0410) — captures the real SQL emitted by each public reader and
// verifies via `EXPLAIN (FORMAT JSON)` (with seqscan and sort disabled) that
// Postgres can use every declared hot-path index for its reader's exact
// predicates and ordering.
import type * as schema from "@/lib/db/schema";

import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import { NextRequest } from "next/server";
import { type Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  domainEvents,
  executionAssignments,
  librarianMessages,
  librarianTurns,
  projects,
  runs,
  tasks,
  webhookDeliveries,
  webhookEvents,
  webhookSubscriptions,
  workspaces,
} from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import { retrieveLibrarianContext } from "@/lib/librarian/retrieval";
import { getCrossProjectActivityFeed } from "@/lib/queries/activity-feed";
import { getPortfolioObservatory } from "@/lib/queries/observatory";
import { getObservatoryOverview } from "@/lib/queries/observatory-overview";
import { getRunDetail } from "@/lib/queries/run";
import { listRunsPage } from "@/lib/queries/runs-list";
import { findHostRestartRecovery } from "@/lib/runs/host-restart-recovery";
import { runWebhookDeliveryJob } from "@/lib/scheduler/handlers/webhook-delivery";
import { startAgentContinuationWorker } from "@/lib/agents/continuation-worker";
import { startFlowContinuationWorker } from "@/lib/flows/graph/continuation-worker";
import { seedLocalHost } from "@/test-support/execution-host-seed";
import {
  addProjectMember,
  seedActiveUser,
  seedLibrarianTurn,
} from "@/test-support/librarian-seed";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";
import {
  capturePlans,
  type CapturedQuery,
} from "@/test-support/query-plan-capture";

let testDatabase: StartedPostgresTestDb;
let pool: Pool;
let db: NodePgDatabase<typeof schema>;
let attentionGet: typeof import("@/app/api/attention/stream/route").GET;

let adminUserId: string;
let projectIds: string[] = [];
let targetRunId: string;
let segmentId: string;

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));
vi.mock("@/lib/authz", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/authz")>()),
  requireActiveSession: vi.fn(async () => ({
    id: adminUserId,
    role: "admin" as const,
  })),
  requireActiveUserById: vi.fn(async (userId: string) => {
    const res = await pool.query<{
      id: string;
      role: "admin" | "member" | "viewer";
      account_status: string;
    }>(`SELECT id, role, account_status FROM users WHERE id = $1`, [userId]);
    const row = res.rows[0];

    if (!row || row.account_status !== "active") {
      throw new MaisterError("UNAUTHORIZED", "inactive");
    }

    return { id: row.id, role: row.role };
  }),
}));

/** Resolves `seen` once a captured statement's text matches `marker`. */
function firstCaptureOf(marker: RegExp): {
  onCapture: (query: CapturedQuery) => void;
  seen: Promise<void>;
} {
  let mark!: () => void;
  const seen = new Promise<void>((resolve) => {
    mark = resolve;
  });

  return {
    onCapture: (query) => {
      if (marker.test(query.text)) mark();
    },
    seen,
  };
}

async function captureAttentionScan(tables: readonly string[]) {
  const controller = new AbortController();
  let scanSeen!: () => void;
  const scanned = new Promise<void>((resolve) => {
    scanSeen = resolve;
  });

  return capturePlans(
    pool,
    async () => {
      // Passing Last-Event-ID forces the initial gap scan immediately on connect.
      const req = new NextRequest("http://localhost/api/attention/stream", {
        headers: { "last-event-id": String(Date.now() - 60_000) },
        signal: controller.signal,
      });
      const res = await attentionGet(req);
      const reader = res.body?.getReader();

      try {
        if (reader) {
          await Promise.race([
            scanned,
            reader.read(),
            new Promise((r) => setTimeout(r, 1_500)),
          ]);
        }
      } finally {
        controller.abort();
        await reader?.cancel().catch(() => undefined);
      }
    },
    {
      tables,
      onCapture: (q) => {
        // The gap scan is one UNION statement naming every source table, so
        // this fires for any `tables` filter.
        if (q.text.includes("webhook_deliveries")) scanSeen();
      },
    },
  );
}

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "hot-path-indexes",
  });
  pool = testDatabase.pool;
  db = testDatabase.db as unknown as NodePgDatabase<typeof schema>;
  ({ GET: attentionGet } = await import("@/app/api/attention/stream/route"));

  adminUserId = await seedActiveUser(db as never, { role: "admin" });

  // Seed several projects so composite leading keys (project_id, ...) matter.
  projectIds = [randomUUID(), randomUUID(), randomUUID()];
  for (let i = 0; i < projectIds.length; i += 1) {
    await db.insert(projects).values({
      id: projectIds[i]!,
      slug: `idx-proj-${i}`,
      name: `Index Project ${i}`,
      repoPath: `/tmp/idx-proj-${i}`,
      mainBranch: "main",
      taskKey: `IDX${i}`,
    });
    await addProjectMember(db as never, {
      projectId: projectIds[i]!,
      userId: adminUserId,
      role: "admin",
    });
  }

  // Seed an execution host for assignments + host-restart recovery.
  const { id: hostId } = await seedLocalHost(db as never);

  // Seed tasks and runs spanning statuses and kinds, plus company (NULL project) runs.
  const statuses = [
    "Pending",
    "Running",
    "NeedsInput",
    "NeedsInputIdle",
    "WaitingOnChildren",
    "Review",
    "Done",
    "Failed",
    "Crashed",
    "Abandoned",
  ] as const;
  const tiedTime = new Date("2026-10-01T12:00:00.000Z");

  targetRunId = randomUUID();
  for (let i = 0; i < statuses.length; i += 1) {
    const projectId = projectIds[i % projectIds.length]!;
    const taskId = randomUUID();
    const runId = i === 1 ? targetRunId : randomUUID();
    const assignmentId = randomUUID();

    await db.insert(tasks).values({
      id: taskId,
      projectId,
      number: i + 1,
      title: `Task ${i}`,
      prompt: `Prompt ${i}`,
      status: statuses[i] === "Done" ? "Done" : "InFlight",
    });
    await db.insert(runs).values({
      id: runId,
      projectId,
      taskId,
      runKind: i % 3 === 0 ? "scratch" : "flow",
      status: statuses[i]!,
      flowVersion: "1",
      startedAt: new Date(Date.now() - i * 60_000),
      endedAt:
        statuses[i] === "Done" ||
        statuses[i] === "Failed" ||
        statuses[i] === "Abandoned"
          ? new Date()
          : null,
    });
    await db.insert(executionAssignments).values({
      id: assignmentId,
      runId,
      executionHostId: hostId,
      epoch: 1,
      state: statuses[i] === "Crashed" ? "released" : "active",
      releasedReason: statuses[i] === "Crashed" ? "crashed" : null,
      endedAt: statuses[i] === "Crashed" ? new Date() : null,
      placementReason: "launch",
    });
    await db
      .update(runs)
      .set({ executionAssignmentId: assignmentId })
      .where(sql`${runs.id} = ${runId}`);

    // Workspaces with equal `created_at` ties to exercise (run_id, created_at DESC, id ASC).
    for (let w = 0; w < 2; w += 1) {
      await db.insert(workspaces).values({
        id: randomUUID(),
        runId,
        projectId,
        branch: `idx-branch-${i}-${w}`,
        worktreePath: `/tmp/idx-wt-${runId}-${w}`,
        parentRepoPath: `/tmp/idx-proj-${i % projectIds.length}`,
        createdAt: tiedTime,
      });
    }
  }

  // Seed historical terminal runs outside the 7-day Observatory window so
  // active-status partial indexes have realistic selectivity (< 3% active)
  // without skewing recent-window Observatory scans.
  await pool.query(
    `INSERT INTO runs (id, project_id, run_kind, status, flow_version, started_at, ended_at)
     SELECT gen_random_uuid()::text, CASE WHEN n % 2 = 0 THEN $1 ELSE $2 END,
            CASE WHEN n % 3 = 0 THEN 'agent' WHEN n % 3 = 1 THEN 'scratch' ELSE 'flow' END,
            'Done', '1', now() - interval '30 days' - (n || ' minutes')::interval, now() - interval '30 days'
     FROM generate_series(1, 200) AS n`,
    [projectIds[1], projectIds[2]],
  );

  // Seed mixed domain events across projects.
  const eventKinds = [
    "run.done",
    "run.failed",
    "run.crashed",
    "run.escalated",
    "run.review",
  ] as const;

  for (let i = 0; i < 30; i += 1) {
    await db.insert(domainEvents).values({
      kind: eventKinds[i % eventKinds.length]!,
      projectId: projectIds[i % projectIds.length]!,
      runId: targetRunId,
      payload: {},
      occurredAt: new Date(Date.now() - i * 10_000),
    });
  }
  // Seed older domain events outside the Observatory period so the occurred_at
  // range predicate narrows on domain_events_project_occurred_idx instead of
  // tying with project_sequence_idx on a 30-row table.
  await pool.query(
    `INSERT INTO domain_events (kind, project_id, run_id, payload, occurred_at)
     SELECT (ARRAY['run.done', 'run.failed', 'run.crashed', 'run.escalated', 'run.review'])[1 + n % 5],
            $1, $2, '{}'::jsonb, now() - interval '30 days' - (n || ' minutes')::interval
     FROM generate_series(1, 200) AS n`,
    [projectIds[0], targetRunId],
  );

  // Seed webhook subscriptions, fanned-out events, and pending/delivered/dead deliveries.
  const subId = randomUUID();

  await db.insert(webhookSubscriptions).values({
    id: subId,
    projectId: projectIds[0]!,
    name: "idx-sub",
    url: "https://example.test/hook",
    eventTypes: ["run.done"],
    signingSecretRef: "env:IDX_TEST_WEBHOOK_SECRET",
    enabled: true,
  });

  const oldFanout = new Date(Date.now() - 10 * 24 * 60 * 60 * 1_000);
  const recentFanout = new Date();
  const deliveryStatuses = ["pending", "delivered", "dead"] as const;

  // Seed enough recent fanned-out and unfanned rows that pruning old rows
  // (< 1% selectivity) prefers webhook_events_fanout_prune_idx over a full
  // primary-key merge join.
  await pool.query(
    `INSERT INTO webhook_events (id, project_id, run_id, type, data, occurred_at, fanout_at)
     SELECT gen_random_uuid()::text, $1, $2, 'run.done', '{}'::jsonb, now(),
            CASE WHEN n <= 200 THEN now() ELSE NULL END
     FROM generate_series(1, 250) AS n`,
    [projectIds[0], targetRunId],
  );

  for (let i = 0; i < 12; i += 1) {
    const eventId = randomUUID();

    await db.insert(webhookEvents).values({
      id: eventId,
      projectId: projectIds[i % projectIds.length]!,
      runId: targetRunId,
      type: "run.done",
      data: {},
      occurredAt: i < 6 ? oldFanout : recentFanout,
      fanoutAt: i < 6 ? oldFanout : recentFanout,
    });
    // Leave half unreferenced so prune exercises both webhook_events and webhook_deliveries.
    if (i >= 6) {
      await db.insert(webhookDeliveries).values({
        id: randomUUID(),
        eventId,
        subscriptionId: subId,
        status: deliveryStatuses[i % deliveryStatuses.length]!,
        nextAttemptAt: new Date(Date.now() + 60_000),
        idempotencyKey: `idem-${i}`,
        updatedAt: new Date(Date.now() - i * 1_000),
      });
    }
  }
  // Seed older settled deliveries so the attention stream's `updated_at > since`
  // range scan selects webhook_deliveries_settled_updated_idx over event_id joins.
  await pool.query(
    `INSERT INTO webhook_deliveries (id, event_id, subscription_id, status, next_attempt_at, idempotency_key, updated_at)
     SELECT gen_random_uuid()::text, e.id, $1,
            CASE WHEN row_number() OVER () % 2 = 0 THEN 'delivered' ELSE 'dead' END,
            now(), 'hist-' || row_number() OVER (), now() - interval '3 days'
     FROM (SELECT id FROM webhook_events WHERE fanout_at IS NOT NULL LIMIT 150) e
     ON CONFLICT DO NOTHING`,
    [subId],
  );

  // Seed librarian conversation, segment, messages, and knowledge-bearing turns.
  const turnId = await seedLibrarianTurn(db as never, adminUserId);
  const segRow = await pool.query<{ id: string; conversation_id: string }>(
    `SELECT id, conversation_id FROM librarian_segments LIMIT 1`,
  );

  segmentId = segRow.rows[0]!.id;
  const conversationId = segRow.rows[0]!.conversation_id;

  for (let seq = 1; seq <= 10; seq += 1) {
    await db.insert(librarianMessages).values({
      id: randomUUID(),
      conversationId,
      segmentId,
      seq: BigInt(seq),
      authorKind: seq % 2 === 0 ? "librarian" : "owner",
      body: `message ${seq}`,
      deliveryState: "processed",
      turnId,
    });
  }
  await db
    .update(librarianTurns)
    .set({
      knowledgeAccess: {
        restricted: false,
        sources: [],
      } as never,
    })
    .where(sql`${librarianTurns.id} = ${turnId}`);

  await pool.query("ANALYZE");
}, 60_000);

afterAll(async () => {
  await testDatabase?.stop();
});

describe("hot-path Postgres indexes (migration 0410, IDX-01…IDX-11)", () => {
  it("IDX-01 listRunsPage lateral and getRunDetail join use workspaces_run_created_idx", async () => {
    const listCapture = await capturePlans(
      pool,
      () =>
        listRunsPage({
          db: db as never,
          filters: { page: 1 },
          user: { id: adminUserId, role: "admin" },
        }),
      { tables: ["workspaces"] },
    );

    expect([...listCapture.indexNames]).toContain("workspaces_run_created_idx");

    const detailCapture = await capturePlans(
      pool,
      () => getRunDetail(targetRunId),
      { tables: ["workspaces"] },
    );

    expect([...detailCapture.indexNames]).toContain(
      "workspaces_run_created_idx",
    );
  });

  it("IDX-02 getObservatoryOverview uses runs_project_started_idx", async () => {
    // Scope to one project while other projects hold the bulk of runs so the
    // leading project_id column narrows the scan ahead of started_at.
    const scope = [
      {
        id: projectIds[0]!,
        slug: "idx-proj-0",
        name: "Index Project 0",
      },
    ];
    const now = new Date();
    const capture = await capturePlans(
      pool,
      () =>
        getObservatoryOverview(db, scope, {
          since: new Date(now.getTime() - 7 * 86_400_000),
          until: now,
          runKind: "all",
          includePlatform: false,
          includeBreakdown: true,
        }),
      { tables: ["runs"] },
    );

    expect([...capture.indexNames]).toContain("runs_project_started_idx");
  });

  it("IDX-03 listRunsPage ordering uses runs_started_id_idx", async () => {
    const capture = await capturePlans(
      pool,
      () =>
        listRunsPage({
          db: db as never,
          filters: { page: 1 },
          user: { id: adminUserId, role: "admin" },
        }),
      { tables: ["runs"] },
    );

    expect([...capture.indexNames]).toContain("runs_started_id_idx");
  });

  it("IDX-04 flow and agent continuation candidate selection use runs_continuation_active_idx", async () => {
    // Each worker opens its first tick with the candidate select from "runs";
    // waiting for that statement replaces a fixed sleep.
    const flowCandidate = firstCaptureOf(/from "runs"/i);
    const flowCapture = await capturePlans(
      pool,
      async () => {
        const worker = startFlowContinuationWorker({ db });

        try {
          await flowCandidate.seen;
        } finally {
          await worker.stop();
        }
      },
      { tables: ["runs"], onCapture: flowCandidate.onCapture },
    );

    expect([...flowCapture.indexNames]).toContain(
      "runs_continuation_active_idx",
    );

    // Agent continuation queries two run_kinds (`IN ('agent','scratch')`) across
    // OR-ed active status arms, so Postgres proves the partial index per arm via
    // BitmapOr + Sort over the active rows rather than a single ordered scan.
    const agentCandidate = firstCaptureOf(/from "runs"/i);
    const agentCapture = await capturePlans(
      pool,
      async () => {
        const worker = startAgentContinuationWorker({ db });

        try {
          await agentCandidate.seen;
        } finally {
          await worker.stop();
        }
      },
      {
        tables: ["runs"],
        onCapture: agentCandidate.onCapture,
        disableSort: false,
      },
    );

    expect([...agentCapture.indexNames]).toContain(
      "runs_continuation_active_idx",
    );
  });

  it("IDX-05 findHostRestartRecovery uses runs_host_restart_recovery_idx", async () => {
    const capture = await capturePlans(
      pool,
      () => findHostRestartRecovery(db, {}),
      { tables: ["runs"] },
    );

    expect([...capture.indexNames]).toContain("runs_host_restart_recovery_idx");
  });

  it("IDX-06 activity feed, attention stream, and Observatory budget summary use domain_events_project_occurred_idx", async () => {
    const feedCapture = await capturePlans(
      pool,
      () => getCrossProjectActivityFeed({ id: adminUserId, role: "admin" }),
      { tables: ["domain_events"] },
    );

    expect([...feedCapture.indexNames]).toContain(
      "domain_events_project_occurred_idx",
    );

    const budgetCapture = await capturePlans(
      pool,
      () =>
        getPortfolioObservatory(
          adminUserId,
          "admin",
          { projectSlug: "idx-proj-0" },
          db,
        ),
      { tables: ["domain_events"] },
    );

    expect([...budgetCapture.indexNames]).toContain(
      "domain_events_project_occurred_idx",
    );

    const streamCapture = await captureAttentionScan(["domain_events"]);

    expect([...streamCapture.indexNames]).toContain(
      "domain_events_project_occurred_idx",
    );
  });

  it("IDX-07 and IDX-09 webhook prune pass uses webhook_deliveries_event_idx and webhook_events_fanout_prune_idx", async () => {
    const capture = await capturePlans(
      pool,
      () => runWebhookDeliveryJob({ db }),
      { tables: ["webhook_deliveries", "webhook_events"] },
    );

    expect([...capture.indexNames]).toContain("webhook_deliveries_event_idx");
    expect([...capture.indexNames]).toContain(
      "webhook_events_fanout_prune_idx",
    );
  });

  it("IDX-08 attention stream and activity feed deliveries use webhook_deliveries_settled_updated_idx", async () => {
    const feedCapture = await capturePlans(
      pool,
      () => getCrossProjectActivityFeed({ id: adminUserId, role: "admin" }),
      { tables: ["webhook_deliveries"] },
    );

    expect(
      feedCapture.indexNames.has("webhook_deliveries_settled_updated_idx"),
    ).toBe(true);

    const streamCapture = await captureAttentionScan(["webhook_deliveries"]);

    expect([...streamCapture.indexNames]).toContain(
      "webhook_deliveries_settled_updated_idx",
    );
  });

  it("IDX-10 and IDX-11 retrieveLibrarianContext uses librarian_messages_segment_seq_idx and librarian_turns_segment_knowledge_idx", async () => {
    const capture = await capturePlans(
      pool,
      () =>
        retrieveLibrarianContext(db, {
          ownerId: adminUserId,
          segmentId,
          beforeSeq: 10n,
          forgetGeneration: 0,
          historyGeneration: 0,
          useMemory: false,
        }),
      { tables: ["librarian_messages", "librarian_turns"] },
    );

    expect([...capture.indexNames]).toContain(
      "librarian_messages_segment_seq_idx",
    );
    expect(
      capture.indexNames.has("librarian_turns_segment_knowledge_idx"),
    ).toBe(true);
  });
});
