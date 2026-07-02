import "server-only";

import { randomUUID } from "node:crypto";

import { sql, type SQL } from "drizzle-orm";
import pino from "pino";

import { splitForEmbedding } from "./chunk";
import { sha256, toVectorLiteral } from "./codec";
import { ensureEmbeddingIndex } from "./embedding-index";
import { isBrainProvisioned } from "./guard";
import {
  getBrainEmbeddingClient,
  type OpenAiCompatibleClient,
} from "./openai-compatible";

import { getDb } from "@/lib/db/client";
import { isMaisterError } from "@/lib/errors";

// Project Brain (ADR-122, D4/E-2/E-8) reindex worker. A model OR dimension
// switch enqueues one brain_index_jobs row per Brain-enabled project (T5.1). This
// sweep-driven worker re-embeds each project's ACTIVE items into the new
// generation (the current platform embedding_model/dimensions), writing NEW
// brain_embeddings rows and NEVER mutating old ones — old-generation rows + their
// HNSW index stay intact so a rollback is free. Recall (T4.1) follows the active
// settings automatically; mid-reindex, un-re-embedded items are still covered by
// the lexical leg.
//
// Resumability (E-8): an item is "done for this generation" once it has an
// active-generation embedding row, so the worklist is `active items WITHOUT an
// active-generation embedding` — inherently idempotent and crash-safe (each
// item's segments are inserted in ONE transaction). resumable_cursor records the
// last processed item for progress/observability. Dimension change is a
// first-class path: ensureEmbeddingIndex already created the new expression index
// (T5.1); here it is called idempotently as a belt.

const log = pino({
  name: "brain:reindex",
  level: process.env.LOG_LEVEL ?? "info",
});

// Bound per-job work per tick so one huge project cannot starve the sweep; the
// job stays `running` and resumes next tick.
export const REINDEX_MAX_ITEMS_PER_JOB = 200;

export interface BrainReindexSummary {
  ran: boolean;
  jobsProcessed: number;
  jobsCompleted: number;
  itemsEmbedded: number;
  errors: string[];
}

type ReindexTx = {
  execute(query: SQL): Promise<{ rows: Array<Record<string, unknown>> }>;
};
type ReindexDb = ReindexTx & {
  transaction<T>(fn: (tx: ReindexTx) => Promise<T>): Promise<T>;
};

type JobRow = { id: string; project_id: string; status: string };

// Re-embed one item's content into the active generation, all segments in ONE
// transaction. Returns false when the item already has active-generation rows
// (a concurrent/duplicate pass) — the caller skips it.
async function reindexItem(
  db: ReindexDb,
  client: OpenAiCompatibleClient,
  item: { id: string; content: string },
): Promise<void> {
  const content = item.content.trim();

  if (!content) return;

  const contentHash = sha256(content);
  const segments = splitForEmbedding(content);
  // Embed OUTSIDE the transaction (network) — the tx does DB work only.
  const vectors = await client.embed(segments);
  const n = client.dimensions;

  await db.transaction(async (tx) => {
    for (let i = 0; i < segments.length; i++) {
      await tx.execute(sql`
        INSERT INTO brain_embeddings
          (id, item_id, split_ordinal, vector, embedding_provider, embedding_model,
           embedding_dimensions, embedding_version, source_hash, content_hash)
        VALUES
          (${randomUUID()}, ${item.id}, ${i}, ${toVectorLiteral(vectors[i])}::vector,
           ${client.provider}, ${client.model}, ${n}, ${client.version},
           ${sha256(segments[i])}, ${contentHash})
        ON CONFLICT (item_id, split_ordinal, embedding_model, embedding_dimensions)
        DO NOTHING
      `);
    }
  });
}

// Process one job: re-embed up to `maxItems` of its active items still missing an
// active-generation embedding. Marks the job `completed` once none remain.
// Returns the number of items embedded this tick.
async function processJob(
  db: ReindexDb,
  client: OpenAiCompatibleClient,
  job: JobRow,
  maxItems: number,
): Promise<number> {
  // Claim (defensive — the system sweep is a singleton, but this makes a double
  // fire a no-op rather than a double-embed).
  const claimed = await db.execute(sql`
    UPDATE brain_index_jobs SET status = 'running'
    WHERE id = ${job.id} AND status IN ('queued', 'running')
    RETURNING id
  `);

  if (claimed.rows.length === 0) return 0;

  const model = client.model;
  const n = client.dimensions;
  let embedded = 0;

  while (embedded < maxItems) {
    const batch = await db.execute(sql`
      SELECT i.id AS id, i.content AS content
      FROM brain_items i
      WHERE i.project_id = ${job.project_id} AND i.status = 'active'
        AND NOT EXISTS (
          SELECT 1 FROM brain_embeddings e
          WHERE e.item_id = i.id
            AND e.embedding_model = ${model}
            AND e.embedding_dimensions = ${n}
        )
      ORDER BY i.id ASC
      LIMIT ${Math.min(maxItems - embedded, 50)}
    `);

    if (batch.rows.length === 0) {
      // Nothing left → this generation is fully materialized for the project.
      // Status flip ONLY — `progress` is the cumulative per-item counter and a
      // per-tick value here would clobber it (a 205-item job finishing on a
      // 5-item tick must not report progress=5).
      await db.execute(sql`
        UPDATE brain_index_jobs
        SET status = 'completed'
        WHERE id = ${job.id}
      `);

      return embedded;
    }

    for (const row of batch.rows) {
      const item = { id: String(row.id), content: String(row.content) };

      try {
        await reindexItem(db, client, item);
      } catch (err) {
        // A deterministic CONFIG rejection (provider 4xx / dimension mismatch)
        // will fail this item on EVERY tick — the ORDER BY id worklist would
        // re-hit it first forever, permanently stalling the project's reindex
        // and burning one paid call per tick. Mark the job `failed` with the
        // offending item recorded; recovery is the reconcile enqueue on the
        // next settings save / project enable. Transient errors propagate —
        // the job stays `running` and retries next tick.
        if (isMaisterError(err) && err.code === "CONFIG") {
          await db.execute(sql`
            UPDATE brain_index_jobs
            SET status = 'failed',
                resumable_cursor = ${JSON.stringify({
                  lastItemId: item.id,
                  error: err.message,
                })}::jsonb
            WHERE id = ${job.id}
          `);
          log.error(
            { jobId: job.id, itemId: item.id, err: err.message },
            "brain reindex job failed on a non-retryable item",
          );

          return embedded;
        }

        throw err;
      }
      embedded += 1;
      await db.execute(sql`
        UPDATE brain_index_jobs
        SET progress = progress + 1,
            resumable_cursor = ${JSON.stringify({ lastItemId: item.id })}::jsonb
        WHERE id = ${job.id}
      `);

      if (embedded >= maxItems) break;
    }
  }

  // Hit the per-tick cap with items still pending — leave `running` for the next
  // tick to resume from the worklist.
  return embedded;
}

export async function runBrainReindexSweep(
  opts: {
    db?: ReindexDb;
    client?: OpenAiCompatibleClient;
    maxItemsPerJob?: number;
  } = {},
): Promise<BrainReindexSummary> {
  // SQLite → Brain disabled (D3): the brain tables do not exist; no-op.
  if (!isBrainProvisioned()) {
    return {
      ran: false,
      jobsProcessed: 0,
      jobsCompleted: 0,
      itemsEmbedded: 0,
      errors: [],
    };
  }

  const db = opts.db ?? (getDb() as unknown as ReindexDb);
  const maxItems = opts.maxItemsPerJob ?? REINDEX_MAX_ITEMS_PER_JOB;
  const errors: string[] = [];

  // Skip jobs of brain-DISABLED projects (the kill switch applies to the write
  // side too — no paid re-embedding for a project whose Brain is off). The rows
  // stay queued/running and resume when the project is re-enabled.
  const jobsResult = await db.execute(sql`
    SELECT j.id, j.project_id, j.status FROM brain_index_jobs j
    JOIN projects p ON p.id = j.project_id AND p.brain_enabled = true
    WHERE j.status IN ('queued', 'running')
    ORDER BY j.created_at ASC
  `);
  const jobs = jobsResult.rows as unknown as JobRow[];

  if (jobs.length === 0) {
    return {
      ran: true,
      jobsProcessed: 0,
      jobsCompleted: 0,
      itemsEmbedded: 0,
      errors: [],
    };
  }

  // Resolve the active-generation client ONCE (all jobs target the current
  // platform embedding settings). A config/outage failure leaves every job
  // queued for the next tick — never throws out of the sweep.
  let client: OpenAiCompatibleClient;

  try {
    client =
      opts.client ??
      (await getBrainEmbeddingClient(
        db as unknown as Parameters<typeof getBrainEmbeddingClient>[0],
      ));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    log.warn({ err: message }, "brain reindex: embedding client unavailable");

    return {
      ran: true,
      jobsProcessed: 0,
      jobsCompleted: 0,
      itemsEmbedded: 0,
      errors: [message],
    };
  }

  // The new generation's expression index (idempotent — created at configure
  // time in T5.1; re-asserted here so a manual job is self-sufficient).
  try {
    await ensureEmbeddingIndex(db, client.model, client.dimensions);
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
  }

  let jobsProcessed = 0;
  let jobsCompleted = 0;
  let itemsEmbedded = 0;

  for (const job of jobs) {
    try {
      const embedded = await processJob(db, client, job, maxItems);

      itemsEmbedded += embedded;
      jobsProcessed += 1;

      const after = await db.execute(sql`
        SELECT status FROM brain_index_jobs WHERE id = ${job.id}
      `);

      if (String(after.rows[0]?.status) === "completed") jobsCompleted += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);

      errors.push(`reindex job ${job.id} failed: ${message}`);
      log.error(
        { err: message, jobId: job.id },
        "brain reindex job failed (left running for retry)",
      );
    }
  }

  return {
    ran: true,
    jobsProcessed,
    jobsCompleted,
    itemsEmbedded,
    errors,
  };
}
