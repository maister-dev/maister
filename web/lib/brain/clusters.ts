import "server-only";

import { sql, type SQL } from "drizzle-orm";
import pino from "pino";

import type { BrainItemKind } from "./schema";
import type { OpenAiCompatibleClient } from "./openai-compatible";
import { sha256 } from "./codec";
import { BRAIN_POLICY } from "./policy";

const log = pino({
  name: "brain:clusters",
  level: process.env.LOG_LEVEL ?? "info",
});

type ClustersDb = {
  execute(query: SQL): Promise<{ rows: Array<Record<string, unknown>> }>;
};

export interface MemoryClusterDto {
  clusterHash: string;
  kind: Extract<BrainItemKind, "lesson" | "observation" | "state_fact">;
  recurrence: number;
  evidenceItemIds: string[];
  summary: string;
  provenance: Record<string, unknown>;
}

interface ClusterRow {
  kind: MemoryClusterDto["kind"];
  gate_kind: string | null;
  run_id: string | null;
  evidence_item_ids: string[] | string;
  recurrence: number;
  summary_title: string | null;
}

function evidenceIds(value: string[] | string): string[] {
  if (Array.isArray(value)) return value.map(String);

  return value
    .replace(/[{}]/g, "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
}

function clusterHash(args: {
  projectId: string;
  kind: string;
  gateKind: string | null;
  runId: string | null;
  evidenceItemIds: string[];
}): string {
  return sha256(
    [
      args.projectId,
      args.kind,
      args.gateKind ?? "",
      args.runId ?? "",
      ...args.evidenceItemIds,
    ].join("\n"),
  );
}

export async function listMemoryClusters(
  db: ClustersDb,
  args: {
    projectId: string;
    client: OpenAiCompatibleClient;
    kinds?: MemoryClusterDto["kind"][];
    minRecurrence?: number;
    limit?: number;
  },
): Promise<MemoryClusterDto[]> {
  const minRecurrence = args.minRecurrence ?? 3;
  const limit = args.limit ?? 10;
  const kinds = args.kinds ?? ["lesson", "observation", "state_fact"];
  const dimRaw = sql.raw(String(args.client.dimensions));
  const maxDistance = 1 - BRAIN_POLICY.dedupCosineThreshold;
  const rows = await db.execute(sql`
    WITH item_vectors AS (
      SELECT i.id,
             i.kind,
             i.title,
             i.source_gate_kind,
             i.source_run_id,
             i.reinforcement_count,
             e.vector
      FROM brain_items i
      JOIN brain_embeddings e ON e.item_id = i.id
      WHERE i.project_id = ${args.projectId}
        AND i.status = 'active'
        AND i.kind IN (${sql.join(
          kinds.map((kind) => sql`${kind}`),
          sql`, `,
        )})
        AND e.split_ordinal = 0
        AND e.embedding_model = ${args.client.model}
        AND e.embedding_dimensions = ${args.client.dimensions}
    ),
    clustered_items AS (
      SELECT b.id,
             b.kind,
             b.title,
             b.source_gate_kind,
             b.source_run_id,
             b.reinforcement_count
      FROM item_vectors a
      JOIN item_vectors b
        ON b.kind = a.kind
       AND coalesce(b.source_gate_kind, '') = coalesce(a.source_gate_kind, '')
       AND coalesce(b.source_run_id, '') = coalesce(a.source_run_id, '')
       AND (a.vector::vector(${dimRaw}) <=> b.vector::vector(${dimRaw})) <= ${maxDistance}
      GROUP BY b.id, b.kind, b.title, b.source_gate_kind, b.source_run_id,
               b.reinforcement_count
    )
    SELECT b.kind,
           NULLIF(coalesce(b.source_gate_kind, ''), '') AS gate_kind,
           NULLIF(coalesce(b.source_run_id, ''), '') AS run_id,
           array_agg(DISTINCT b.id ORDER BY b.id) AS evidence_item_ids,
           sum(1 + b.reinforcement_count)::int AS recurrence,
           min(b.title) AS summary_title
    FROM clustered_items b
    GROUP BY b.kind, coalesce(b.source_gate_kind, ''), coalesce(b.source_run_id, '')
    HAVING sum(1 + b.reinforcement_count) >= ${minRecurrence}
    ORDER BY sum(1 + b.reinforcement_count) DESC, min(b.title) ASC
    LIMIT ${limit}
  `);
  const clusters = (rows.rows as unknown as ClusterRow[]).map((row) => {
    const ids = evidenceIds(row.evidence_item_ids);

    return {
      clusterHash: clusterHash({
        projectId: args.projectId,
        kind: row.kind,
        gateKind: row.gate_kind,
        runId: row.run_id,
        evidenceItemIds: ids,
      }),
      kind: row.kind,
      recurrence: Number(row.recurrence),
      evidenceItemIds: ids,
      summary: `Recurring ${row.kind}: ${row.summary_title ?? ids[0]}`,
      provenance: {
        gateKind: row.gate_kind,
        runId: row.run_id,
      },
    };
  });

  log.debug(
    { projectId: args.projectId, kinds, clusterCount: clusters.length },
    "brain memory clusters listed",
  );

  return clusters;
}
