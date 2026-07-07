import "server-only";

import type { BrainChunkDraft } from "./chunkers/types";
import type { OpenAiCompatibleClient } from "./openai-compatible";

import { randomUUID } from "node:crypto";

import { sql, type SQL } from "drizzle-orm";
import pino from "pino";

import {
  ChunkerError,
  createBuiltInChunkerRegistry,
} from "./chunkers/registry";
import { splitForEmbedding } from "./chunk";
import { sha256, toVectorLiteral } from "./codec";
import { reanchorBrainEdgesForSource } from "./edges";
import {
  BRAIN_SOURCE_MAX_GLOB_MATCHES,
  isBrainSourceGlob,
  listBrainSourceMatchedPaths,
  readBrainSourceFiles,
  readBrainSourceContents,
  type SourceContent,
} from "./sources";

import { isMaisterError, MaisterError } from "@/lib/errors";

const log = pino({
  name: "brain:indexer",
  level: process.env.LOG_LEVEL ?? "info",
});

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  const parsed = raw ? Number.parseInt(raw, 10) : fallback;

  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export const BRAIN_SOURCE_MAX_CHUNKS_PER_JOB = envInt(
  "MAISTER_BRAIN_MAX_CHUNKS_PER_JOB",
  1_000,
);
export const BRAIN_SOURCE_MAX_EMBEDDING_SEGMENTS_PER_JOB = envInt(
  "MAISTER_BRAIN_MAX_EMBEDDING_SEGMENTS_PER_JOB",
  2_000,
);
export const BRAIN_SOURCE_MAX_FILES_PER_BATCH = BRAIN_SOURCE_MAX_GLOB_MATCHES;

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

interface SourceJobCursor {
  lastPath?: string;
  processedFiles: number;
  sourceHash: string;
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

async function loadSourceJobCursor(
  db: IndexerTx,
  jobId: string,
): Promise<SourceJobCursor> {
  const rows = await db.execute(sql`
    SELECT resumable_cursor
    FROM brain_index_jobs
    WHERE id = ${jobId}
  `);
  const raw = rows.rows[0]?.resumable_cursor;

  if (raw === null || raw === undefined) {
    return { processedFiles: 0, sourceHash: "" };
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { processedFiles: 0, sourceHash: "" };
  }

  const cursor = raw as Record<string, unknown>;
  const lastPath =
    typeof cursor.lastPath === "string" ? cursor.lastPath : undefined;
  const processedFiles =
    typeof cursor.processedFiles === "number" &&
    Number.isInteger(cursor.processedFiles) &&
    cursor.processedFiles > 0
      ? cursor.processedFiles
      : 0;
  const sourceHash =
    typeof cursor.sourceHash === "string" ? cursor.sourceHash : "";

  return { lastPath, processedFiles, sourceHash };
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

async function loadExactPeerSourcePaths(
  db: IndexerTx,
  source: SourceRow,
): Promise<string[]> {
  if (!isBrainSourceGlob(source.path)) return [];

  const rows = await db.execute(sql`
    SELECT path
    FROM brain_sources
    WHERE project_id = ${source.project_id}
      AND id <> ${source.id}
      AND kind = ${source.kind}
      AND enabled = true
  `);

  return rows.rows
    .map((row) => String(row.path))
    .filter((path) => !isBrainSourceGlob(path));
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

function isTransientEmbeddingError(error: unknown): boolean {
  return isMaisterError(error) && error.code === "EMBEDDING_UNAVAILABLE";
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
    await db.execute(
      sql`DELETE FROM brain_chunks WHERE source_id = ${job.source_id}`,
    );
    await reanchorBrainEdgesForSource(db, {
      projectId: job.project_id,
      sourceId: job.source_id,
    });
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
  let segmentCount = 0;

  for (const draft of drafts) {
    const contentHash = sha256(draft.content);
    const old = existing.get(draft.stableId);
    const shouldEmbed =
      old === undefined ||
      old.content_hash !== contentHash ||
      !old.has_current_embedding;
    const segments = shouldEmbed ? splitForEmbedding(draft.content) : [];

    segmentCount += segments.length;

    if (segmentCount > BRAIN_SOURCE_MAX_EMBEDDING_SEGMENTS_PER_JOB) {
      log.warn(
        {
          projectId: source.project_id,
          sourceId: source.id,
          path: source.path,
          segmentCount,
          maxSegments: BRAIN_SOURCE_MAX_EMBEDDING_SEGMENTS_PER_JOB,
          reason: "embedding_segment_limit",
        },
        "brain source embedding budget exceeded",
      );

      throw new MaisterError(
        "PRECONDITION",
        `Brain source "${source.path}" produced ${segmentCount} embedding segments; limit is ${BRAIN_SOURCE_MAX_EMBEDDING_SEGMENTS_PER_JOB}`,
      );
    }

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

function assertChunkBudget(
  source: SourceRow,
  drafts: readonly BrainChunkDraft[],
): void {
  if (drafts.length <= BRAIN_SOURCE_MAX_CHUNKS_PER_JOB) return;

  log.warn(
    {
      projectId: source.project_id,
      sourceId: source.id,
      path: source.path,
      chunkCount: drafts.length,
      maxChunks: BRAIN_SOURCE_MAX_CHUNKS_PER_JOB,
      reason: "chunk_limit",
    },
    "brain source chunk budget exceeded",
  );

  throw new MaisterError(
    "PRECONDITION",
    `Brain source "${source.path}" produced ${drafts.length} chunks; limit is ${BRAIN_SOURCE_MAX_CHUNKS_PER_JOB}`,
  );
}

async function persistChunkPlans(
  tx: IndexerTx,
  source: SourceRow,
  sourceHash: string,
  job: SourceJobRow,
  client: OpenAiCompatibleClient,
  plans: ChunkPlan[],
): Promise<number> {
  await pruneSourceChunks(tx, source, plans);

  const chunksEmbedded = await upsertChunkPlans(tx, source, client, plans);

  await markSourceIndexed(tx, source, sourceHash);
  await reanchorBrainEdgesForSource(tx, {
    projectId: source.project_id,
    sourceId: source.id,
  });
  await completeJob(tx, job.id, chunksEmbedded);

  return chunksEmbedded;
}

async function pruneSourceChunks(
  tx: IndexerTx,
  source: SourceRow,
  plans: readonly ChunkPlan[],
): Promise<void> {
  const stableIds = plans.map((plan) => plan.draft.stableId);

  if (stableIds.length === 0) {
    await tx.execute(
      sql`DELETE FROM brain_chunks WHERE source_id = ${source.id}`,
    );
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
}

async function pruneChunkPaths(
  tx: IndexerTx,
  source: SourceRow,
  paths: readonly string[],
  plans: readonly ChunkPlan[],
): Promise<void> {
  if (paths.length === 0) return;

  const stableIds = plans.map((plan) => plan.draft.stableId);
  const pathList = sql.join(
    paths.map((path) => sql`${path}`),
    sql`, `,
  );

  if (stableIds.length === 0) {
    await tx.execute(sql`
      DELETE FROM brain_chunks
      WHERE source_id = ${source.id}
        AND path IN (${pathList})
    `);

    return;
  }

  await tx.execute(sql`
    DELETE FROM brain_chunks
    WHERE source_id = ${source.id}
      AND path IN (${pathList})
      AND stable_id NOT IN (${sql.join(
        stableIds.map((id) => sql`${id}`),
        sql`, `,
      )})
  `);
}

async function pruneRemovedGlobPaths(
  tx: IndexerTx,
  source: SourceRow,
  matchedPaths: readonly string[],
): Promise<void> {
  if (matchedPaths.length === 0) {
    await tx.execute(
      sql`DELETE FROM brain_chunks WHERE source_id = ${source.id}`,
    );

    return;
  }

  await tx.execute(sql`
    DELETE FROM brain_chunks
    WHERE source_id = ${source.id}
      AND path NOT IN (${sql.join(
        matchedPaths.map((path) => sql`${path}`),
        sql`, `,
      )})
  `);
}

async function upsertChunkPlans(
  tx: IndexerTx,
  source: SourceRow,
  client: OpenAiCompatibleClient,
  plans: ChunkPlan[],
): Promise<number> {
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

  return chunksEmbedded;
}

async function markSourceIndexed(
  tx: IndexerTx,
  source: SourceRow,
  sourceHash: string,
): Promise<void> {
  await tx.execute(sql`
    UPDATE brain_sources
    SET source_hash = ${sourceHash},
        last_indexed_at = now(),
        last_error = NULL,
        updated_at = now()
    WHERE id = ${source.id}
  `);
}

function hashBatches(
  previousHash: string,
  files: readonly SourceContent[],
): string {
  return sha256(
    [previousHash, ...files.map((file) => `${file.path}\0${file.sourceHash}`)]
      .filter((part) => part.length > 0)
      .join("\0"),
  );
}

function nextBatchStartIndex(
  matchedPaths: readonly string[],
  cursor: SourceJobCursor,
): number {
  if (!cursor.lastPath) return 0;

  const nextIndex = matchedPaths.findIndex((path) => path > cursor.lastPath!);

  return nextIndex === -1 ? matchedPaths.length : nextIndex;
}

function chunkSourceFiles(
  source: SourceRow,
  files: readonly SourceContent[],
): BrainChunkDraft[] {
  const drafts = files.flatMap((file) => {
    const chunked = createBuiltInChunkerRegistry().chunk({
      path: file.path,
      content: file.content,
      kind: source.kind as never,
    });

    return chunked.chunks;
  });

  assertChunkBudget(source, drafts);

  return drafts;
}

async function processGlobSourceIndexJob(
  db: SourceIndexerDb,
  client: OpenAiCompatibleClient,
  job: SourceJobRow,
  source: SourceRow,
): Promise<SourceIndexResult> {
  let matchedPaths: string[];
  let batchPaths: string[];
  let cursor: SourceJobCursor;
  let files: SourceContent[];

  try {
    const excludePaths = await loadExactPeerSourcePaths(db, source);
    const matches = await listBrainSourceMatchedPaths({
      repoPath: source.repo_path,
      ref: source.main_branch,
      path: source.path,
      excludePaths,
    });

    matchedPaths = matches.matchedPaths;
    cursor = await loadSourceJobCursor(db, job.id);

    const startIndex = nextBatchStartIndex(matchedPaths, cursor);

    batchPaths = matchedPaths.slice(
      startIndex,
      startIndex + BRAIN_SOURCE_MAX_FILES_PER_BATCH,
    );

    if (batchPaths.length === 0) {
      const finalHash = cursor.sourceHash || sha256("");

      await db.transaction(async (tx) => {
        await pruneRemovedGlobPaths(tx, source, matchedPaths);
        await markSourceIndexed(tx, source, finalHash);
        await reanchorBrainEdgesForSource(tx, {
          projectId: source.project_id,
          sourceId: source.id,
        });
        await completeJob(tx, job.id);
      });

      return { chunksEmbedded: 0 };
    }

    const read = await readBrainSourceFiles({
      repoPath: source.repo_path,
      ref: source.main_branch,
      paths: batchPaths,
      sourcePath: source.path,
    });

    files = read.files;
  } catch (error) {
    await recordSourceError(db, job, "read", error, { retireChunks: true });

    return { chunksEmbedded: 0 };
  }

  let drafts: BrainChunkDraft[];

  try {
    drafts = chunkSourceFiles(source, files);
  } catch (error) {
    await recordSourceError(db, job, "chunk", error, { retireChunks: false });

    return { chunksEmbedded: 0 };
  }

  const existing = await loadExistingChunks(db, source, client);
  let plans: ChunkPlan[];

  try {
    plans = await buildChunkPlans(source, drafts, existing, client);
  } catch (error) {
    if (isTransientEmbeddingError(error)) throw error;

    await recordSourceError(db, job, "embed", error, { retireChunks: false });

    return { chunksEmbedded: 0 };
  }

  const sourceHash = hashBatches(cursor.sourceHash, files);
  const lastPath = batchPaths[batchPaths.length - 1];
  const processedFiles = cursor.processedFiles + batchPaths.length;
  const completed = processedFiles >= matchedPaths.length;

  return db.transaction(async (tx) => {
    await pruneChunkPaths(tx, source, batchPaths, plans);

    const chunksEmbedded = await upsertChunkPlans(tx, source, client, plans);

    if (completed) {
      await pruneRemovedGlobPaths(tx, source, matchedPaths);
      await markSourceIndexed(tx, source, sourceHash);
      await reanchorBrainEdgesForSource(tx, {
        projectId: source.project_id,
        sourceId: source.id,
      });
      await completeJob(tx, job.id, batchPaths.length);
    } else {
      await tx.execute(sql`
        UPDATE brain_sources
        SET last_error = NULL,
            updated_at = now()
        WHERE id = ${source.id}
      `);
      await reanchorBrainEdgesForSource(tx, {
        projectId: source.project_id,
        sourceId: source.id,
      });
      await tx.execute(sql`
        UPDATE brain_index_jobs
        SET status = 'running',
            progress = progress + ${batchPaths.length},
            resumable_cursor = ${JSON.stringify({
              lastPath,
              processedFiles,
              sourceHash,
            })}::jsonb
        WHERE id = ${job.id}
      `);
    }

    return { chunksEmbedded };
  });
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

  if (isBrainSourceGlob(source.path)) {
    return processGlobSourceIndexJob(db, client, job, source);
  }

  let files: SourceContent[];
  let sourceHash: string;

  try {
    const read = await readBrainSourceContents({
      repoPath: source.repo_path,
      ref: source.main_branch,
      path: source.path,
    });

    files = read.files;
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
    drafts = chunkSourceFiles(source, files);
  } catch (error) {
    await recordSourceError(db, job, "chunk", error, { retireChunks: false });

    return { chunksEmbedded: 0 };
  }

  const existing = await loadExistingChunks(db, source, client);
  let plans: ChunkPlan[];

  try {
    plans = await buildChunkPlans(source, drafts, existing, client);
  } catch (error) {
    if (isTransientEmbeddingError(error)) throw error;

    await recordSourceError(db, job, "embed", error, { retireChunks: false });

    return { chunksEmbedded: 0 };
  }

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
