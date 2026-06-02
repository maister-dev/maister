import "server-only";

import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { asc, eq } from "drizzle-orm";

import { getDb } from "@/lib/db/client";
import * as schema from "@/lib/db/schema";

const { nodeAttempts, gateResults, artifactInstances, hitlRequests } = schema;

// FIXME(any): getDb() returns a pg|sqlite drizzle union; narrow to pg. POC = Postgres.
function asPg(client: unknown): NodePgDatabase<typeof schema> {
  return client as NodePgDatabase<typeof schema>;
}

export type EvidenceNodeKind =
  | "task-input"
  | "node-attempt"
  | "artifact"
  | "gate"
  | "decision";

export type EvidenceEdgeKind =
  | "input"
  | "output"
  | "supersession"
  | "stale"
  | "flow"
  | "gate";

export interface EvidenceNode {
  id: string;
  kind: EvidenceNodeKind;
  label: string;
  state: string | null;
  meta: Record<string, unknown>;
}

export interface EvidenceEdge {
  id: string;
  source: string;
  target: string;
  kind: EvidenceEdgeKind;
}

export interface EvidenceGraph {
  nodes: EvidenceNode[];
  edges: EvidenceEdge[];
}

const TASK_INPUT_ID = "task-input";

export async function buildEvidenceGraph(
  runId: string,
  db?: unknown,
): Promise<EvidenceGraph> {
  const client = asPg(db ?? getDb());

  const attemptRows = await client
    .select({
      id: nodeAttempts.id,
      nodeId: nodeAttempts.nodeId,
      nodeType: nodeAttempts.nodeType,
      attempt: nodeAttempts.attempt,
      status: nodeAttempts.status,
      startedAt: nodeAttempts.startedAt,
    })
    .from(nodeAttempts)
    .where(eq(nodeAttempts.runId, runId))
    .orderBy(asc(nodeAttempts.startedAt), asc(nodeAttempts.attempt));

  const gateRows = await client
    .select({
      id: gateResults.id,
      nodeAttemptId: gateResults.nodeAttemptId,
      gateId: gateResults.gateId,
      kind: gateResults.kind,
      mode: gateResults.mode,
      status: gateResults.status,
    })
    .from(gateResults)
    .where(eq(gateResults.runId, runId))
    .orderBy(asc(gateResults.createdAt));

  const artifactRows = await client
    .select({
      id: artifactInstances.id,
      nodeAttemptId: artifactInstances.nodeAttemptId,
      kind: artifactInstances.kind,
      validity: artifactInstances.validity,
      supersededById: artifactInstances.supersededById,
    })
    .from(artifactInstances)
    .where(eq(artifactInstances.runId, runId));

  const hitlRows = await client
    .select({
      id: hitlRequests.id,
      kind: hitlRequests.kind,
      decision: hitlRequests.decision,
    })
    .from(hitlRequests)
    .where(eq(hitlRequests.runId, runId));

  const nodes: EvidenceNode[] = [];
  const nodeIds = new Set<string>();

  function pushNode(node: EvidenceNode): void {
    nodes.push(node);
    nodeIds.add(node.id);
  }

  // task-input: exactly one synthetic root.
  pushNode({
    id: TASK_INPUT_ID,
    kind: "task-input",
    label: "Task input",
    state: null,
    meta: {},
  });

  // node-attempt: one per row (already ordered by startedAt, attempt).
  for (const a of attemptRows) {
    pushNode({
      id: `na:${a.id}`,
      kind: "node-attempt",
      label: a.nodeId,
      state: a.status,
      meta: { nodeId: a.nodeId, attempt: a.attempt, nodeType: a.nodeType },
    });
  }

  // artifact: one per row, validity surfaced as state.
  for (const art of artifactRows) {
    pushNode({
      id: `art:${art.id}`,
      kind: "artifact",
      label: art.kind,
      state: art.validity,
      meta: { kind: art.kind, artifactId: art.id },
    });
  }

  // gate: one per row.
  for (const g of gateRows) {
    pushNode({
      id: `gate:${g.id}`,
      kind: "gate",
      label: g.gateId,
      state: g.status,
      meta: { gateKind: g.kind, mode: g.mode },
    });
  }

  // decision: one per hitl row that carries a decision.
  for (const h of hitlRows) {
    if (h.decision === null) continue;

    pushNode({
      id: `dec:${h.id}`,
      kind: "decision",
      label: h.decision,
      state: h.decision,
      meta: { decision: h.decision, hitlKind: h.kind },
    });
  }

  const edges: EvidenceEdge[] = [];

  // No-dangling invariant: only push an edge when BOTH endpoints exist.
  function pushEdge(
    id: string,
    source: string,
    target: string,
    kind: EvidenceEdgeKind,
  ): void {
    if (!nodeIds.has(source) || !nodeIds.has(target)) return;

    edges.push({ id, source, target, kind });
  }

  // input: task-input → the earliest node-attempt(s). attemptRows is ordered;
  // the earliest startedAt wins (ties share the edge).
  if (attemptRows.length > 0) {
    const earliestStart = attemptRows[0].startedAt.getTime();

    for (const a of attemptRows) {
      if (a.startedAt.getTime() !== earliestStart) break;

      pushEdge(`input:${a.id}`, TASK_INPUT_ID, `na:${a.id}`, "input");
    }
  }

  // output: node-attempt → artifact it produced (when attribution present).
  for (const art of artifactRows) {
    if (art.nodeAttemptId === null) continue;

    pushEdge(
      `output:${art.id}`,
      `na:${art.nodeAttemptId}`,
      `art:${art.id}`,
      "output",
    );
  }

  // gate: node-attempt → its gate.
  for (const g of gateRows) {
    pushEdge(`gate:${g.id}`, `na:${g.nodeAttemptId}`, `gate:${g.id}`, "gate");
  }

  // supersession: old artifact → newer artifact (dashed in the UI).
  for (const art of artifactRows) {
    if (art.supersededById === null) continue;

    pushEdge(
      `supersession:${art.id}`,
      `art:${art.id}`,
      `art:${art.supersededById}`,
      "supersession",
    );
  }

  // flow: sequential node-attempts (already ordered by startedAt, attempt).
  for (let i = 0; i + 1 < attemptRows.length; i++) {
    const from = attemptRows[i];
    const to = attemptRows[i + 1];

    pushEdge(
      `flow:${from.id}:${to.id}`,
      `na:${from.id}`,
      `na:${to.id}`,
      "flow",
    );
  }

  return { nodes, edges };
}
