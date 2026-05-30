import "server-only";

import type { MaisterErrorCode } from "@/lib/errors";
import type {
  NodeAttempt,
  NodeAttemptStatus,
  NodeAttemptType,
} from "@/lib/db/schema";
import type { WorkspacePolicy } from "@/lib/config.schema";

import { randomUUID } from "node:crypto";

import { and, asc, eq } from "drizzle-orm";
import pino from "pino";

import { getDb } from "@/lib/db/client";
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

export async function markNodeRunning(
  nodeAttemptId: string,
  args: { acpSessionId?: string } = {},
  db?: Db,
): Promise<void> {
  const d = db ?? getDb();

  await d
    .update(nodeAttempts)
    .set({
      status: "Running" as NodeAttemptStatus,
      acpSessionId: args.acpSessionId ?? null,
    })
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
// attempts stay immutable (append-only ledger, ADR-023).
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
