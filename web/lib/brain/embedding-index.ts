import "server-only";

import { sql, type SQL } from "drizzle-orm";

import { MaisterError } from "@/lib/errors";

// Project Brain (ADR-122, D4): per-generation HNSW expression indexes over the
// dimension-untyped `brain_embeddings.vector` column. HNSW needs a fixed
// dimension, so each (model, dimensions) generation gets its own partial
// expression index — `USING hnsw ((vector::vector(N)) vector_cosine_ops) WHERE
// embedding_model = M AND embedding_dimensions = N`. Created at configure/reindex
// time (T5.1/T5.5), NOT in the migration. A model OR dimension switch adds a NEW
// index; old-generation indexes + rows stay intact — no schema migration ever.
//
// The recall vector leg MUST repeat the exact `vector::vector(N)` cast + the
// `embedding_model`/`embedding_dimensions` predicate so the planner uses this
// index (pgvector README FAQ: an expression index is only used when the query
// expression matches it verbatim).

type Executor = { execute(query: SQL): Promise<unknown> };

// Deterministic, collision-resistant-enough index name for a (model, N)
// generation. Postgres identifiers cap at 63 bytes; the prefix is 22 chars, so
// the model slug is truncated to keep the whole name well under the cap.
export function embeddingIndexName(model: string, dimensions: number): string {
  const slug = model
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 32);

  return `brain_embeddings_hnsw_${slug}_${dimensions}`;
}

// Idempotently create the HNSW expression index for one embedding generation.
// Returns the index name (for logging / test assertion). Postgres only — the
// caller must have already established the dialect is pg (guard.ts).
export async function ensureEmbeddingIndex(
  db: Executor,
  model: string,
  dimensions: number,
): Promise<string> {
  if (!model || !model.trim()) {
    throw new MaisterError(
      "CONFIG",
      "embedding model is required to build the HNSW index",
    );
  }

  if (!Number.isInteger(dimensions) || dimensions < 1) {
    throw new MaisterError(
      "CONFIG",
      `embedding dimensions must be a positive integer (got ${dimensions})`,
    );
  }

  const indexName = embeddingIndexName(model, dimensions);
  // model is admin-configured, not arbitrary user input, but escape the literal
  // anyway (a stray quote would otherwise break the DDL). dimensions is an
  // integer, safe to interpolate as a type modifier + predicate value. DDL
  // cannot take bind params in this position, so build the statement literally.
  const modelLiteral = model.replace(/'/g, "''");

  await db.execute(
    sql.raw(
      `CREATE INDEX IF NOT EXISTS "${indexName}" ON "brain_embeddings" ` +
        `USING hnsw ((vector::vector(${dimensions})) vector_cosine_ops) ` +
        `WHERE embedding_model = '${modelLiteral}' AND embedding_dimensions = ${dimensions}`,
    ),
  );

  return indexName;
}
