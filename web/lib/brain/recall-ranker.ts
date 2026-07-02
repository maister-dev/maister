import "server-only";

import type { BrainItemKind } from "./schema";

import { sql, type SQL } from "drizzle-orm";

import { toVectorLiteral } from "./codec";

// Project Brain (ADR-122, D9) — the RecallRanker seam. Keeps the one thing "buy"
// does better (recall ranking) swappable behind an interface without moving the
// system-of-record off Postgres. The default pgvector hybrid implementation
// (`rank`) is below; this file owns the contract + injection so the rest of the
// code depends on the seam.

export const RANKER_VERSION = "hybrid-v1";

// Hybrid score weights (tune-on-real-runs). vector similarity dominates; the
// lexical leg breaks ties and covers items not yet re-embedded mid-reindex; a
// small confidence term rewards reinforced memories.
const RANK_WEIGHTS = { vector: 1.0, lexical: 0.25, confidence: 0.1 } as const;

export type RecallRankerDb = {
  execute(query: SQL): Promise<{ rows: Array<Record<string, unknown>> }>;
};

export interface RecallQuery {
  projectId: string;
  queryText: string;
  // The query embedding is computed once by the caller (recall.ts) and injected,
  // so the ranker performs NO LLM/embedding call itself (E-6).
  queryEmbedding: number[];
  model: string;
  dimensions: number;
  limit: number;
  kinds?: BrainItemKind[];
  minConfidence?: number;
}

export interface RankedBrainItem {
  id: string;
  kind: BrainItemKind;
  title: string;
  content: string;
  confidence: number;
  score: number;
  tags: string[];
  createdAt: Date;
  expiresAt: Date | null;
  provenance: { runId: string | null; gateKind: string | null };
}

export interface RecallRanker {
  readonly version: string;
  rank(db: RecallRankerDb, q: RecallQuery): Promise<RankedBrainItem[]>;
}

// The default pgvector hybrid ranker: a vector leg (cosine KNN over the ACTIVE
// generation, cast `vector::vector(N)` to match the per-generation expression
// HNSW index) + a lexical `tsvector` leg (also covers items not yet re-embedded
// mid-reindex) + a confidence term. NO LLM at read (E-6). Project-scoped;
// excludes expired/superseded and other-project rows; de-dupes a multi-split
// item to its best-scoring segment. `model`/`dimensions` are LITERALS in the
// vector leg so the planner matches the partial HNSW index at plan time; the
// query vector is a bound param (a runtime value).
export const pgVectorRecallRanker: RecallRanker = {
  version: RANKER_VERSION,

  async rank(db: RecallRankerDb, q: RecallQuery): Promise<RankedBrainItem[]> {
    const nRaw = sql.raw(String(q.dimensions));
    const modelLit = sql.raw(`'${q.model.replace(/'/g, "''")}'`);
    const queryVec = toVectorLiteral(q.queryEmbedding);
    // Clamp FIRST, then derive the candidate-pool size from the clamped value —
    // a wild caller limit must never reach a raw SQL LIMIT.
    const limit = Math.max(1, Math.min(Math.floor(q.limit) || 1, 50));
    const knnLimit = Math.max(limit * 4, 20);
    const vecW = sql.raw(String(RANK_WEIGHTS.vector));
    const lexW = sql.raw(String(RANK_WEIGHTS.lexical));
    const confW = sql.raw(String(RANK_WEIGHTS.confidence));

    const kindClause =
      q.kinds && q.kinds.length > 0
        ? sql` AND i.kind IN (${sql.join(
            q.kinds.map((k) => sql`${k}`),
            sql`, `,
          )})`
        : sql``;
    const confClause =
      q.minConfidence != null
        ? sql` AND i.confidence >= ${q.minConfidence}`
        : sql``;

    const res = await db.execute(sql`
      WITH knn AS (
        SELECT item_id,
               (vector::vector(${nRaw})) <=> ${queryVec}::vector(${nRaw}) AS dist
        FROM brain_embeddings
        WHERE embedding_model = ${modelLit} AND embedding_dimensions = ${nRaw}
          -- Scope the candidate pool INSIDE the KNN: without this, the global
          -- top-K across ALL projects (and expired items) consumes the slots
          -- and a project can be starved out of its own vector leg.
          AND EXISTS (
            SELECT 1 FROM brain_items bi
            WHERE bi.id = brain_embeddings.item_id
              AND bi.project_id = ${q.projectId}
              AND bi.status = 'active'
              AND (bi.expires_at IS NULL OR bi.expires_at > now())
          )
        ORDER BY (vector::vector(${nRaw})) <=> ${queryVec}::vector(${nRaw})
        LIMIT ${knnLimit}
      ),
      vec AS (
        SELECT item_id, MIN(dist) AS dist FROM knn GROUP BY item_id
      )
      SELECT i.id, i.kind, i.title, i.content, i.tags,
             i.confidence::float8 AS confidence,
             i.created_at, i.expires_at, i.source_run_id, i.source_gate_kind,
             ( (1 - COALESCE(v.dist, 1)) * ${vecW}
               + LEAST(COALESCE(ts_rank(i.tsv, plainto_tsquery('english', ${q.queryText})), 0), 1) * ${lexW}
               + i.confidence::float8 * ${confW} )::float8 AS score
      FROM brain_items i
      LEFT JOIN vec v ON v.item_id = i.id
      WHERE i.project_id = ${q.projectId}
        AND i.status = 'active'
        AND (i.expires_at IS NULL OR i.expires_at > now())
        AND (v.item_id IS NOT NULL
             OR i.tsv @@ plainto_tsquery('english', ${q.queryText}))
        ${kindClause}
        ${confClause}
      ORDER BY score DESC, i.created_at DESC
      LIMIT ${limit}
    `);

    return res.rows.map((r) => ({
      id: String(r.id),
      kind: r.kind as BrainItemKind,
      title: String(r.title),
      content: String(r.content),
      confidence: Number(r.confidence),
      score: Number(r.score),
      tags: (r.tags as string[] | null) ?? [],
      createdAt: r.created_at as Date,
      expiresAt: (r.expires_at as Date | null) ?? null,
      provenance: {
        runId: (r.source_run_id as string | null) ?? null,
        gateKind: (r.source_gate_kind as string | null) ?? null,
      },
    }));
  },
};

// Injection point (SOLID/DIP): callers pass an override for tests or an
// alternate reranker; otherwise the default pgvector ranker is used.
export function resolveRecallRanker(override?: RecallRanker): RecallRanker {
  return override ?? pgVectorRecallRanker;
}
