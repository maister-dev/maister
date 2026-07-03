import "server-only";

import { randomUUID } from "node:crypto";

import { sql, type SQL } from "drizzle-orm";
import pino from "pino";

import {
  ChunkerError,
  createBuiltInChunkerRegistry,
} from "./chunkers/registry";
import type { BrainChunkDraft } from "./chunkers/types";
import { splitForEmbedding } from "./chunk";
import { sha256, toVectorLiteral } from "./codec";
import type { OpenAiCompatibleClient } from "./openai-compatible";
import { readBrainSourceContent } from "./sources";

import { isMaisterError } from "@/lib/errors";

const log = pino({
  name: "brain:indexer",
  level: process.env.LOG_LEVEL ?? "info",
});

type IndexerTx = {
  execute(query: SQL): Promise<{ rows: Array<Record<string, unknown>> }>;
};

export type SourceIndexerDb = IndexerTx & {
  transaction<T>(fn: (tx: IndexerTx) => Promise<T>): Promise<T>;
};

export interface SourceJobRow {
  id: string;
  project_id: string;
  source_id: string;
  status: string;
}

interface SourceRow {
  id: string;
  project_id: string;
  kind: string;
  path: string;
  source_hash: string | null;
  chunker_id: string;
  chunker_version: string;
  enabled: boolean;
  repo_path: string;
  main_branch: string;
}

interface ExistingChunk {
  id: string;
  stable_id: string;
  content_hash: string;
  has_current_embedding: boolean;
}

interface ChunkPlan {
  draft: BrainChunkDraft;
  contentHash: string;
  existing: ExistingChunk | undefined;
  shouldEmbed: boolean;
  segments: string[];
  vectors: number[][];
}

export interface SourceIndexResult {
  chunksEmbedded: number;
}

async function claimSourceJob(
  db: SourceIndexerDb,
  job: SourceJobRow,
): Promise<boolean> {
  const claimed = await db.execute(sql`
    UPDATE brain_index_jobs
    SET status = 'running'
    WHERE id = ${job.id} AND status IN ('queued', 'running')
    RETURNING id
  `);

  return claimed.rows.length > 0;
}

async function completeJob(
  db: IndexerTx,
  jobId: string,
  progressDelta = 0,
): Promise<void> {
  await db.execute(sql`
    UPDATE brain_index_jobs
    SET status = 'completed',
        progress = progress + ${progressDelta}
    WHERE id = ${jobId}
  `);
}

async function loadSource(
  db: IndexerTx,
  job: SourceJobRow,
): Promise<SourceRow | null> {
  const rows = await db.execute(sql`
    SELECT s.id, s.project_id, s.kind, s.path, s.source_hash, s.chunker_id,
           s.chunker_version, s.enabled, p.repo_path, p.main_branch
    FROM brain_sources s
    JOIN projects p ON p.id = s.project_id
    WHERE s.id = ${job.source_id} AND s.project_id = ${job.project_id}
  `);

  return (rows.rows[0] as unknown as SourceRow | undefined) ?? null;
}

async function loadExistingChunks(
  db: IndexerTx,
  source: SourceRow,
  client: OpenAiCompatibleClient,
): Promise<Map<string, ExistingChunk>> {
  const rows = await db.execute(sql`
    SELECT c.id, c.stable_id, c.content_hash,
           EXISTS (
             SELECT 1 FROM brain_embeddings e
             WHERE e.chunk_id = c.id
               AND e.embedding_model = ${client.model}
               AND e.embedding_dimensions = ${client.dimensions}
               AND e.chunker_id = ${source.chunker_id}
               AND e.chunker_version = ${source.chunker_version}
           ) AS has_current_embedding
    FROM brain_chunks c
    WHERE c.source_id = ${source.id}
  `);

  return new Map(
    rows.rows.map((row) => [
      String(row.stable_id),
      {
        id: String(row.id),
        stable_id: String(row.stable_id),
        content_hash: String(row.content_hash),
        has_current_embedding: Boolean(row.has_current_embedding),
      },
    ]),
  );
}

async function hasCurrentCoverage(
  db: IndexerTx,
  source: SourceRow,
  client: OpenAiCompatibleClient,
): Promise<boolean> {
  const rows = await db.execute(sql`
    SELECT count(c.id)::int AS chunk_count,
           count(e.id)::int AS embedding_count
    FROM brain_chunks c
    LEFT JOIN brain_embeddings e
      ON e.chunk_id = c.id
     AND e.embedding_model = ${client.model}
     AND e.embedding_dimensions = ${client.dimensions}
     AND e.chunker_id = ${source.chunker_id}
     AND e.chunker_version = ${source.chunker_version}
    WHERE c.source_id = ${source.id}
  `);
  const row = rows.rows[0];
  const chunkCount = Number(row?.chunk_count ?? 0);
  const embeddingCount = Number(row?.embedding_count ?? 0);

  return chunkCount > 0 && chunkCount === embeddingCount;
}

function sourceErrorPayload(error: unknown): Record<string, unknown> {
  if (error instanceof ChunkerError) {
    return {
      code: "CONFIG",
      message: error.message,
      chunkerId: error.chunkerId,
      sourcePath: error.sourcePath,
    };
  }

  if (isMaisterError(error)) {
    return { code: error.code, message: error.message };
  }

  return {
    code: "CRASH",
    message: error instanceof Error ? error.message : String(error),
  };
}

async function recordSourceError(
  db: IndexerTx,
  job: SourceJobRow,
  stage: string,
  error: unknown,
  opts: { retireChunks: boolean },
): Promise<void> {
  const payload = sourceErrorPayload(error);

  if (opts.retireChunks) {
    await db.execute(sql`DELETE FROM brain_chunks WHERE source_id = ${job.source_id}`);
  }

  await db.execute(sql`
    UPDATE brain_sources
    SET last_error = ${JSON.stringify(payload)}::jsonb,
        updated_at = now()
    WHERE id = ${job.source_id} AND project_id = ${job.project_id}
  `);
  await completeJob(db, job.id);

  log.warn(
    {
      projectId: job.project_id,
      sourceId: job.source_id,
      jobId: job.id,
      stage,
      errorCode: payload.code,
    },
    "brain source index failed for one source",
  );
}

async function buildChunkPlans(
  source: SourceRow,
  drafts: BrainChunkDraft[],
  existing: Map<string, ExistingChunk>,
  client: OpenAiCompatibleClient,
): Promise<ChunkPlan[]> {
  const plans: ChunkPlan[] = [];

  for (const draft of drafts) {
    const contentHash = sha256(draft.content);
    const old = existing.get(draft.stableId);
    const shouldEmbed =
      old === undefined ||
      old.content_hash !== contentHash ||
      !old.has_current_embedding;
    const segments = shouldEmbed ? splitForEmbedding(draft.content) : [];
    const vectors = segments.length > 0 ? await client.embed(segments) : [];

    plans.push({
      draft,
      contentHash,
      existing: old,
      shouldEmbed,
      segments,
      vectors,
    });
  }

  return plans;
}

async function persistChunkPlans(
  tx: IndexerTx,
  source: SourceRow,
  sourceHash: string,
  job: SourceJobRow,
  client: OpenAiCompatibleClient,
  plans: ChunkPlan[],
): Promise<number> {
  const stableIds = plans.map((plan) => plan.draft.stableId);

  if (stableIds.length === 0) {
    await tx.execute(sql`DELETE FROM brain_chunks WHERE source_id = ${source.id}`);
  } else {
    await tx.execute(sql`
      DELETE FROM brain_chunks
      WHERE source_id = ${source.id}
        AND stable_id NOT IN (${sql.join(
          stableIds.map((id) => sql`${id}`),
          sql`, `,
        )})
    `);
  }

  let chunksEmbedded = 0;

  for (const plan of plans) {
    const row = await tx.execute(sql`
      INSERT INTO brain_chunks
        (id, source_id, project_id, stable_id, kind, title, path, symbol,
         content, metadata, source_range, content_hash)
      VALUES
        (${randomUUID()}, ${source.id}, ${source.project_id}, ${plan.draft.stableId},
         ${plan.draft.kind}, ${plan.draft.title}, ${plan.draft.path},
         ${plan.draft.symbol ?? null}, ${plan.draft.content},
         ${JSON.stringify(plan.draft.metadata)}::jsonb,
         ${JSON.stringify(plan.draft.sourceRange)}::jsonb, ${plan.contentHash})
      ON CONFLICT (source_id, stable_id)
      DO UPDATE SET
        kind = EXCLUDED.kind,
        title = EXCLUDED.title,
        path = EXCLUDED.path,
        symbol = EXCLUDED.symbol,
        content = EXCLUDED.content,
        metadata = EXCLUDED.metadata,
        source_range = EXCLUDED.source_range,
        content_hash = EXCLUDED.content_hash,
        updated_at = now()
      RETURNING id
    `);
    const chunkId = String(row.rows[0]?.id);

    if (!plan.shouldEmbed) continue;

    if (plan.existing && plan.existing.content_hash !== plan.contentHash) {
      await tx.execute(sql`
        DELETE FROM brain_embeddings WHERE chunk_id = ${chunkId}
      `);
    }

    for (let i = 0; i < plan.segments.length; i++) {
      await tx.execute(sql`
        INSERT INTO brain_embeddings
          (id, chunk_id, split_ordinal, vector, embedding_provider,
           embedding_model, embedding_dimensions, embedding_version,
           source_hash, content_hash, chunker_id, chunker_version)
        VALUES
          (${randomUUID()}, ${chunkId}, ${i},
           ${toVectorLiteral(plan.vectors[i])}::vector, ${client.provider},
           ${client.model}, ${client.dimensions}, ${client.version},
           ${sha256(plan.segments[i])}, ${plan.contentHash},
           ${source.chunker_id}, ${source.chunker_version})
        ON CONFLICT (chunk_id, split_ordinal, embedding_model,
                     embedding_dimensions, chunker_id, chunker_version)
        WHERE chunk_id IS NOT NULL
        DO NOTHING
      `);
    }

    chunksEmbedded += 1;
  }

  await tx.execute(sql`
    UPDATE brain_sources
    SET source_hash = ${sourceHash},
        last_indexed_at = now(),
        last_error = NULL,
        updated_at = now()
    WHERE id = ${source.id}
  `);
  await completeJob(tx, job.id, chunksEmbedded);

  return chunksEmbedded;
}

export async function processSourceIndexJob(
  db: SourceIndexerDb,
  client: OpenAiCompatibleClient,
  job: SourceJobRow,
): Promise<SourceIndexResult> {
  if (!(await claimSourceJob(db, job))) return { chunksEmbedded: 0 };

  const source = await loadSource(db, job);

  if (!source || !source.enabled) {
    await completeJob(db, job.id);

    return { chunksEmbedded: 0 };
  }

  let content: string;
  let sourceHash: string;

  try {
    const read = await readBrainSourceContent({
      repoPath: source.repo_path,
      ref: source.main_branch,
      path: source.path,
    });

    content = read.content;
    sourceHash = read.sourceHash;
  } catch (error) {
    await recordSourceError(db, job, "read", error, { retireChunks: true });

    return { chunksEmbedded: 0 };
  }

  if (
    source.source_hash === sourceHash &&
    (await hasCurrentCoverage(db, source, client))
  ) {
    await db.execute(sql`
      UPDATE brain_sources
      SET last_indexed_at = now(), last_error = NULL, updated_at = now()
      WHERE id = ${source.id}
    `);
    await completeJob(db, job.id);

    return { chunksEmbedded: 0 };
  }

  let drafts: BrainChunkDraft[];

  try {
    const chunked = createBuiltInChunkerRegistry().chunk({
      path: source.path,
      content,
      kind: source.kind as never,
    });

    drafts = chunked.chunks;
  } catch (error) {
    await recordSourceError(db, job, "chunk", error, { retireChunks: false });

    return { chunksEmbedded: 0 };
  }

  const existing = await loadExistingChunks(db, source, client);
  const plans = await buildChunkPlans(source, drafts, existing, client);

  return db.transaction(async (tx) => ({
    chunksEmbedded: await persistChunkPlans(
      tx,
      source,
      sourceHash,
      job,
      client,
      plans,
    ),
  }));
}
