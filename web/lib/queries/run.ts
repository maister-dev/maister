import "server-only";

import type {
  GateResult,
  GateVerdict,
  HitlRequest,
  NodeAttempt,
} from "@/lib/db/schema";
import type { HitlOption } from "@/lib/queries/hitl";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { and, asc, desc, eq, isNull } from "drizzle-orm";

import { getDb } from "@/lib/db/client";
import * as schema from "@/lib/db/schema";
import { extractOptions } from "@/lib/queries/hitl";

const {
  executors,
  gateResults,
  hitlRequests,
  nodeAttempts,
  projects,
  runs,
  users,
  workspaces,
} = schema;

// FIXME(any): getDb() returns a pg|sqlite drizzle union; narrow to pg. POC = Postgres.
function db(): NodePgDatabase<typeof schema> {
  return getDb() as unknown as NodePgDatabase<typeof schema>;
}

export interface RunPendingHitl {
  hitlRequestId: string;
  kind: HitlRequest["kind"];
  prompt: string;
  options: HitlOption[];
  schema: unknown;
}

export interface RunDetail {
  runId: string;
  projectId: string;
  projectSlug: string;
  status: string;
  currentStepId: string | null;
  branch: string;
  worktreePath: string;
  agent: "claude" | "codex";
  pendingHitl: RunPendingHitl | null;
  // M11b (ADR-030): the user holding an active takeover claim (null unless a
  // takeover node_attempts row is open). Drives the owner-gated Return action.
  takeoverOwnerUserId: string | null;
}

export async function getRunDetail(runId: string): Promise<RunDetail | null> {
  const client = db();
  const rows = await client
    .select({
      runId: runs.id,
      projectId: runs.projectId,
      status: runs.status,
      currentStepId: runs.currentStepId,
      projectSlug: projects.slug,
      branch: workspaces.branch,
      worktreePath: workspaces.worktreePath,
      agent: executors.agent,
    })
    .from(runs)
    .innerJoin(projects, eq(projects.id, runs.projectId))
    .innerJoin(workspaces, eq(workspaces.runId, runs.id))
    .innerJoin(executors, eq(executors.id, runs.executorId))
    .where(eq(runs.id, runId));
  const row = rows[0];

  if (!row) return null;

  const activeTakeoverRows = await client
    .select({ ownerUserId: nodeAttempts.ownerUserId })
    .from(nodeAttempts)
    .where(
      and(
        eq(nodeAttempts.runId, runId),
        isNull(nodeAttempts.endedAt),
        eq(nodeAttempts.nodeType, "human"),
      ),
    )
    .orderBy(desc(nodeAttempts.attempt));
  const takeoverOwnerUserId =
    activeTakeoverRows.find((r) => r.ownerUserId !== null)?.ownerUserId ?? null;

  const hitlRows = await client
    .select({
      id: hitlRequests.id,
      kind: hitlRequests.kind,
      prompt: hitlRequests.prompt,
      rawSchema: hitlRequests.schema,
    })
    .from(hitlRequests)
    .where(and(eq(hitlRequests.runId, runId), isNull(hitlRequests.respondedAt)))
    .orderBy(desc(hitlRequests.createdAt));
  const pending = hitlRows[0];

  return {
    runId: row.runId,
    projectId: row.projectId,
    projectSlug: row.projectSlug,
    status: row.status,
    currentStepId: row.currentStepId,
    branch: row.branch,
    worktreePath: row.worktreePath,
    agent: row.agent,
    takeoverOwnerUserId,
    pendingHitl: pending
      ? {
          hitlRequestId: pending.id,
          kind: pending.kind,
          prompt: pending.prompt,
          options: extractOptions(pending.kind, pending.rawSchema),
          schema: pending.rawSchema,
        }
      : null,
  };
}

// --- M11b: run-detail timeline read model (ADR-030) -----------------------

export interface TimelineGate {
  gateId: string;
  kind: GateResult["kind"];
  mode: GateResult["mode"];
  status: GateResult["status"];
  verdict: GateVerdict | null;
  // `status === 'stale'`: the gate's prior verdict was invalidated (by rework
  // or a takeover return) and MUST rerun before the run can advance.
  stale: boolean;
  endedAt: string | null;
}

// Takeover handoff block, present only on a `human_review` takeover attempt
// (the row carries `owner_user_id`). Owner name falls back to email (name is
// nullable). Returned commits/diff are raw `git log`/`git diff` text.
export interface TimelineHandoff {
  ownerUserId: string;
  ownerName: string | null;
  ownerEmail: string | null;
  baseRef: string | null;
  returnedCommits: string | null;
  returnedDiff: string | null;
}

export interface TimelineEntry {
  nodeAttemptId: string;
  nodeId: string;
  nodeType: NodeAttempt["nodeType"];
  attempt: number;
  status: NodeAttempt["status"];
  decision: string | null;
  reworkFromNode: string | null;
  acpSessionId: string | null;
  startedAt: string;
  endedAt: string | null;
  gates: TimelineGate[];
  handoff: TimelineHandoff | null;
}

export interface RunTimeline {
  entries: TimelineEntry[];
}

// One ordered read model over the append-only M11a ledger: every node attempt
// (chronological by started_at then attempt — highest-attempt-wins ordering
// matching M11a templating), its joined gate_results flagged current-vs-stale,
// the acp_session_id checkpoint ref, and the takeover handoff block (owner +
// returned commits/diff/base ref). A legacy linear run with no node_attempts
// yields an empty-but-valid timeline.
export async function getRunTimeline(runId: string): Promise<RunTimeline> {
  const client = db();

  const attemptRows = await client
    .select({
      id: nodeAttempts.id,
      nodeId: nodeAttempts.nodeId,
      nodeType: nodeAttempts.nodeType,
      attempt: nodeAttempts.attempt,
      status: nodeAttempts.status,
      decision: nodeAttempts.decision,
      reworkFromNode: nodeAttempts.reworkFromNode,
      acpSessionId: nodeAttempts.acpSessionId,
      ownerUserId: nodeAttempts.ownerUserId,
      baseRef: nodeAttempts.baseRef,
      returnedCommits: nodeAttempts.returnedCommits,
      returnedDiff: nodeAttempts.returnedDiff,
      startedAt: nodeAttempts.startedAt,
      endedAt: nodeAttempts.endedAt,
      ownerName: users.name,
      ownerEmail: users.email,
    })
    .from(nodeAttempts)
    .leftJoin(users, eq(users.id, nodeAttempts.ownerUserId))
    .where(eq(nodeAttempts.runId, runId))
    .orderBy(asc(nodeAttempts.startedAt), asc(nodeAttempts.attempt));

  const gateRows = await client
    .select({
      nodeAttemptId: gateResults.nodeAttemptId,
      gateId: gateResults.gateId,
      kind: gateResults.kind,
      mode: gateResults.mode,
      status: gateResults.status,
      verdict: gateResults.verdict,
      endedAt: gateResults.endedAt,
    })
    .from(gateResults)
    .where(eq(gateResults.runId, runId))
    .orderBy(asc(gateResults.createdAt));

  const gatesByAttempt = new Map<string, TimelineGate[]>();

  for (const g of gateRows) {
    const list = gatesByAttempt.get(g.nodeAttemptId) ?? [];

    list.push({
      gateId: g.gateId,
      kind: g.kind,
      mode: g.mode,
      status: g.status,
      verdict: g.verdict ?? null,
      stale: g.status === "stale",
      endedAt: g.endedAt ? g.endedAt.toISOString() : null,
    });
    gatesByAttempt.set(g.nodeAttemptId, list);
  }

  const entries: TimelineEntry[] = attemptRows.map((r) => ({
    nodeAttemptId: r.id,
    nodeId: r.nodeId,
    nodeType: r.nodeType,
    attempt: r.attempt,
    status: r.status,
    decision: r.decision,
    reworkFromNode: r.reworkFromNode,
    acpSessionId: r.acpSessionId,
    startedAt: r.startedAt.toISOString(),
    endedAt: r.endedAt ? r.endedAt.toISOString() : null,
    gates: gatesByAttempt.get(r.id) ?? [],
    handoff: r.ownerUserId
      ? {
          ownerUserId: r.ownerUserId,
          ownerName: r.ownerName,
          ownerEmail: r.ownerEmail,
          baseRef: r.baseRef,
          returnedCommits: r.returnedCommits,
          returnedDiff: r.returnedDiff,
        }
      : null,
  }));

  return { entries };
}
