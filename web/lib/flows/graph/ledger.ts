import "server-only";

import type { MaisterErrorCode } from "@/lib/errors";
import type {
  NodeAttempt,
  NodeAttemptStatus,
  NodeAttemptType,
} from "@/lib/db/schema";
import type { WorkspacePolicy } from "@/lib/config.schema";

import { randomUUID } from "node:crypto";

import { and, asc, eq, gt, isNotNull, isNull } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import pino from "pino";

import { getDb } from "@/lib/db/client";
import { MaisterError } from "@/lib/errors";
import * as schemaModule from "@/lib/db/schema";

// FIXME(any): dual drizzle-orm peer-dep variants (see step-runs.ts / schema
// integration test). Matches the existing store idiom.
const { nodeAttempts, gateResults } = schemaModule as unknown as Record<
  string,
  any
>;

const log = pino({
  name: "flow-node-attempts",
  level: process.env.LOG_LEVEL ?? "info",
});

const STDOUT_HARD_CAP_BYTES = 1024 * 1024;

// FIXME(any): dual drizzle-orm peer-dep variants.
type Db = any;

function truncate(s: string | undefined | null): string | null {
  if (s === undefined || s === null) return null;
  if (s.length <= STDOUT_HARD_CAP_BYTES) return s;

  return s.slice(0, STDOUT_HARD_CAP_BYTES);
}

// Next append-only attempt number for a (run, node): max(attempt) + 1, or 1.
// Computed in app code: M11a runs are single-writer (one runGraph invocation per
// run at a time — the resume CAS guarantees it), so there is no concurrent
// append for the same (run, node). The UNIQUE (run_id, node_id, attempt)
// constraint is the backstop if that assumption is ever broken.
export async function nextAttemptFor(
  runId: string,
  nodeId: string,
  db?: Db,
): Promise<number> {
  const d = db ?? getDb();

  const rows: Array<{ attempt: number }> = await d
    .select({ attempt: nodeAttempts.attempt })
    .from(nodeAttempts)
    .where(and(eq(nodeAttempts.runId, runId), eq(nodeAttempts.nodeId, nodeId)));

  const max = rows.reduce((m: number, r) => (r.attempt > m ? r.attempt : m), 0);

  return max + 1;
}

// Append a fresh, immutable node attempt. `attempt` defaults to nextAttemptFor.
export async function appendNodeAttempt(args: {
  runId: string;
  nodeId: string;
  nodeType: NodeAttemptType;
  attempt?: number;
  reworkFromNode?: string;
  db?: Db;
}): Promise<{ id: string; attempt: number }> {
  const db = args.db ?? getDb();
  const id = randomUUID();
  const attempt =
    args.attempt ?? (await nextAttemptFor(args.runId, args.nodeId, db));

  await db.insert(nodeAttempts).values({
    id,
    runId: args.runId,
    nodeId: args.nodeId,
    nodeType: args.nodeType,
    attempt,
    status: "Pending" as NodeAttemptStatus,
    reworkFromNode: args.reworkFromNode ?? null,
  });

  log.info(
    {
      nodeAttemptId: id,
      runId: args.runId,
      nodeId: args.nodeId,
      nodeType: args.nodeType,
      attempt,
      reworkFromNode: args.reworkFromNode ?? null,
      status: "Pending",
    },
    "node-attempt appended",
  );

  return { id, attempt };
}

// Status-only transition (mirrors the linear markStepRunning). The per-attempt
// acpSessionId is recorded by markNodeSucceeded when the action returns one, so
// re-entering/resuming an attempt never clobbers a previously recorded id.
export async function markNodeRunning(
  nodeAttemptId: string,
  db?: Db,
): Promise<void> {
  const d = db ?? getDb();

  await d
    .update(nodeAttempts)
    .set({ status: "Running" as NodeAttemptStatus })
    .where(eq(nodeAttempts.id, nodeAttemptId));

  log.debug({ nodeAttemptId, status: "Running" }, "node-attempt transition");
}

export async function markNodeSucceeded(
  nodeAttemptId: string,
  args: {
    stdout?: string | null;
    vars?: Record<string, unknown>;
    exitCode?: number;
    decision?: string;
    workspacePolicy?: WorkspacePolicy;
    acpSessionId?: string;
  } = {},
  db?: Db,
): Promise<void> {
  const d = db ?? getDb();

  await d
    .update(nodeAttempts)
    .set({
      status: "Succeeded" as NodeAttemptStatus,
      stdout: truncate(args.stdout),
      vars: args.vars ?? {},
      exitCode: args.exitCode ?? null,
      decision: args.decision ?? null,
      workspacePolicy: args.workspacePolicy ?? null,
      acpSessionId: args.acpSessionId ?? null,
      endedAt: new Date(),
    })
    .where(eq(nodeAttempts.id, nodeAttemptId));

  log.debug(
    { nodeAttemptId, status: "Succeeded", decision: args.decision ?? null },
    "node-attempt transition",
  );
}

export async function markNodeFailed(
  nodeAttemptId: string,
  args: {
    errorCode: MaisterErrorCode;
    stdout?: string | null;
    exitCode?: number;
  },
  db?: Db,
): Promise<void> {
  const d = db ?? getDb();

  await d
    .update(nodeAttempts)
    .set({
      status: "Failed" as NodeAttemptStatus,
      stdout: truncate(args.stdout),
      exitCode: args.exitCode ?? null,
      errorCode: args.errorCode,
      endedAt: new Date(),
    })
    .where(eq(nodeAttempts.id, nodeAttemptId));

  log.info(
    { nodeAttemptId, status: "Failed", errorCode: args.errorCode },
    "node-attempt transition",
  );
}

export async function markNodeNeedsInput(
  nodeAttemptId: string,
  db?: Db,
): Promise<void> {
  const d = db ?? getDb();

  await d
    .update(nodeAttempts)
    .set({ status: "NeedsInput" as NodeAttemptStatus })
    .where(eq(nodeAttempts.id, nodeAttemptId));

  log.debug({ nodeAttemptId, status: "NeedsInput" }, "node-attempt transition");
}

// A review node's current attempt is marked Reworked when its reviewer chooses
// a rework decision; the decision/workspacePolicy are recorded on the row.
export async function markNodeReworked(
  nodeAttemptId: string,
  args: { decision: string; workspacePolicy?: WorkspacePolicy } = {
    decision: "rework",
  },
  db?: Db,
): Promise<void> {
  const d = db ?? getDb();

  await d
    .update(nodeAttempts)
    .set({
      status: "Reworked" as NodeAttemptStatus,
      decision: args.decision,
      workspacePolicy: args.workspacePolicy ?? null,
      endedAt: new Date(),
    })
    .where(eq(nodeAttempts.id, nodeAttemptId));

  log.info(
    { nodeAttemptId, status: "Reworked", decision: args.decision },
    "node-attempt transition",
  );
}

// --- M11b: manual-takeover ledger helpers (ADR-030) -----------------------

// Claim a takeover for a human_review node: append a fresh node_attempts row
// of that node carrying `owner_user_id`. Reuses nextAttemptFor (append-only,
// single-writer per (run, node)). The takeover columns base_ref/
// returned_commits/returned_diff stay null until the return is recorded.
export async function claimTakeover(args: {
  runId: string;
  nodeId: string;
  userId: string;
  db?: Db;
}): Promise<{ id: string; attempt: number }> {
  const db = args.db ?? getDb();
  const id = randomUUID();
  const attempt = await nextAttemptFor(args.runId, args.nodeId, db);

  await db.insert(nodeAttempts).values({
    id,
    runId: args.runId,
    nodeId: args.nodeId,
    nodeType: "human" as NodeAttemptType,
    attempt,
    status: "NeedsInput" as NodeAttemptStatus,
    ownerUserId: args.userId,
  });

  log.debug(
    {
      nodeAttemptId: id,
      runId: args.runId,
      nodeId: args.nodeId,
      attempt,
      ownerUserId: args.userId,
    },
    "takeover claimed — node-attempt appended",
  );

  return { id, attempt };
}

// Record the return of a takeover: write the raw git log/diff + base ref on
// the active takeover row and end it (ended_at). Targets the latest takeover
// attempt for (run, node) — the row claimTakeover appended.
export async function recordTakeoverReturn(args: {
  runId: string;
  nodeId: string;
  baseRef: string;
  returnedCommits: string;
  returnedDiff: string;
  db?: Db;
}): Promise<void> {
  const db = args.db ?? getDb();
  const active = await getActiveTakeover(args.runId, db);

  if (!active || active.nodeId !== args.nodeId) {
    throw new MaisterError(
      "PRECONDITION",
      `no active takeover to return for run ${args.runId} node ${args.nodeId}`,
    );
  }

  await db
    .update(nodeAttempts)
    .set({
      baseRef: args.baseRef,
      returnedCommits: truncate(args.returnedCommits),
      returnedDiff: truncate(args.returnedDiff),
      endedAt: new Date(),
    })
    .where(eq(nodeAttempts.id, active.id));

  log.debug(
    {
      nodeAttemptId: active.id,
      runId: args.runId,
      nodeId: args.nodeId,
      attempt: active.attempt,
      ownerUserId: active.ownerUserId,
      baseRef: args.baseRef,
    },
    "takeover returned — git log/diff recorded on node-attempt",
  );
}

// Close the active (un-returned) takeover row for a run WITHOUT recording a
// return: set ended_at so getActiveTakeover (owner_user_id IS NOT NULL AND
// ended_at IS NULL) no longer reports an open handoff. Used by the
// release/abandon path (a HumanWorking run released without changes), where no
// git log/diff is recorded — distinct from recordTakeoverReturn, which also
// writes base_ref/returned_commits/returned_diff. No-op when none is active.
export async function endActiveTakeover(runId: string, db?: Db): Promise<void> {
  const d = db ?? getDb();
  const active = await getActiveTakeover(runId, d);

  if (!active) return;

  await d
    .update(nodeAttempts)
    .set({ endedAt: new Date() })
    .where(eq(nodeAttempts.id, active.id));

  log.debug(
    {
      nodeAttemptId: active.id,
      runId,
      nodeId: active.nodeId,
      attempt: active.attempt,
      ownerUserId: active.ownerUserId,
    },
    "takeover ended without return — node-attempt closed",
  );
}

// The active (un-returned) takeover for a run: the latest node_attempts row
// with owner_user_id set and ended_at still null. Returns null when none.
export async function getActiveTakeover(
  runId: string,
  db?: Db,
): Promise<NodeAttempt | null> {
  const d = db ?? getDb();

  const rows: NodeAttempt[] = await d
    .select()
    .from(nodeAttempts)
    .where(
      and(eq(nodeAttempts.runId, runId), isNotNull(nodeAttempts.ownerUserId)),
    )
    .orderBy(asc(nodeAttempts.attempt));

  const active = rows.filter((r) => r.endedAt === null);

  return active.length > 0 ? active[active.length - 1] : null;
}

// M11b (ADR-030, F3): true when a `Running` run carries a RECORDED takeover
// return whose re-entry resume has not yet progressed — i.e. the latest
// takeover node_attempts row has `returned_diff` + `ended_at` set AND there is
// no NON-takeover attempt for `reentryNodeId` started AFTER that takeover row.
// This is the signal the graph runner's resume gate uses to resume a returned
// `Running` run at `runs.current_step_id` (the transitions.takeover re-entry)
// instead of from `graph.entry`. Mirrors the F3 startup sweep's predicate so
// the live return-route resume and the recovery re-dispatch agree.
export async function hasPendingTakeoverResume(
  runId: string,
  reentryNodeId: string,
  db?: Db,
): Promise<boolean> {
  const d = db ?? getDb();

  const takeoverRows: NodeAttempt[] = await d
    .select()
    .from(nodeAttempts)
    .where(
      and(eq(nodeAttempts.runId, runId), isNotNull(nodeAttempts.ownerUserId)),
    )
    .orderBy(asc(nodeAttempts.attempt));

  const returned = takeoverRows.filter(
    (r) => r.returnedDiff !== null && r.endedAt !== null,
  );

  if (returned.length === 0) return false;

  const takeover = returned[returned.length - 1];

  if (!takeover.startedAt) return false;

  // Compare started_at column-to-column in SQL so the takeover boundary keeps
  // its full Postgres microsecond precision. Reading takeover.startedAt into a
  // JS Date (schema mode:"date") truncates to milliseconds; when a pre-takeover
  // re-entry attempt shares the takeover row's millisecond, that truncated
  // bound spuriously matches it as "fresh", falsely reporting the resume
  // already progressed — which strands the returned run (no dispatch claims it).
  const takeoverRow = alias(nodeAttempts, "takeover_row");
  const freshReentry: Array<{ id: string }> = await d
    .select({ id: nodeAttempts.id })
    .from(nodeAttempts)
    .innerJoin(takeoverRow, eq(takeoverRow.id, takeover.id))
    .where(
      and(
        eq(nodeAttempts.runId, runId),
        eq(nodeAttempts.nodeId, reentryNodeId),
        isNull(nodeAttempts.ownerUserId),
        gt(nodeAttempts.startedAt, takeoverRow.startedAt),
      ),
    )
    .limit(1);

  return freshReentry.length === 0;
}

export async function getNodeAttemptsForRun(
  runId: string,
  db?: Db,
): Promise<NodeAttempt[]> {
  const d = db ?? getDb();

  const rows: NodeAttempt[] = await d
    .select()
    .from(nodeAttempts)
    .where(eq(nodeAttempts.runId, runId))
    .orderBy(asc(nodeAttempts.startedAt), asc(nodeAttempts.attempt));

  return rows;
}

// Map of nodeId -> its highest-attempt row (templating highest-attempt-wins).
export function latestAttemptByNode(
  rows: NodeAttempt[],
): Map<string, NodeAttempt> {
  const latest = new Map<string, NodeAttempt>();

  for (const r of rows) {
    const cur = latest.get(r.nodeId);

    if (!cur || r.attempt > cur.attempt) latest.set(r.nodeId, r);
  }

  return latest;
}

// On a rework jump, flip the LATEST attempt of each downstream node
// `Succeeded -> Stale` and any `passed` gate_results attached to those attempts
// `-> stale`. Targets only the highest attempt per node so prior (historical)
// attempts stay immutable (append-only ledger, ADR-027).
export async function markDownstreamStale(
  runId: string,
  downstreamNodeIds: string[],
  db?: Db,
): Promise<{ staledNodes: number; staledGates: number }> {
  const d = db ?? getDb();
  const targets = new Set(downstreamNodeIds);
  const latest = latestAttemptByNode(await getNodeAttemptsForRun(runId, d));

  let staledNodes = 0;
  let staledGates = 0;

  for (const [nodeId, attempt] of latest) {
    if (!targets.has(nodeId)) continue;

    if (attempt.status === "Succeeded") {
      await d
        .update(nodeAttempts)
        .set({ status: "Stale" as NodeAttemptStatus })
        .where(eq(nodeAttempts.id, attempt.id));
      staledNodes += 1;
    }

    // Gate staling fires for the latest attempt regardless of that attempt's
    // own status (not only when it was Succeeded): a `passed` gate verdict on a
    // node whose upstream was reworked is invalidated evidence and MUST go
    // stale so it reruns, even if the node attempt itself is mid-flight.
    const res = await d
      .update(gateResults)
      .set({ status: "stale" })
      .where(
        and(
          eq(gateResults.nodeAttemptId, attempt.id),
          eq(gateResults.status, "passed"),
        ),
      )
      .returning({ id: gateResults.id });

    staledGates += Array.isArray(res) ? res.length : 0;
  }

  log.info(
    { runId, downstream: downstreamNodeIds, staledNodes, staledGates },
    "markDownstreamStale",
  );

  return { staledNodes, staledGates };
}
