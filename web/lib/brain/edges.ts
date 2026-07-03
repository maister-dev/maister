import "server-only";

import { randomUUID } from "node:crypto";

import { sql, type SQL } from "drizzle-orm";
import pino from "pino";

import type { BrainGraphRef, BrainSourceRef } from "./schema";

const log = pino({
  name: "brain:edges",
  level: process.env.LOG_LEVEL ?? "info",
});

type EdgesDb = {
  execute(query: SQL): Promise<{ rows: Array<Record<string, unknown>> }>;
};

interface ChunkRow {
  id: string;
  source_id: string;
  stable_id: string;
  path: string;
  symbol: string | null;
  content_hash: string;
}

interface EdgeRow {
  id: string;
  to_ref: Record<string, unknown>;
  degraded: boolean;
}

export interface ReanchorResult {
  remapped: number;
  degraded: number;
}

function chunkRef(row: ChunkRow): Extract<BrainGraphRef, { type: "chunk" }> {
  return {
    type: "chunk",
    id: row.id,
    sourceId: row.source_id,
    sourcePath: row.path,
    stableId: row.stable_id,
    symbol: row.symbol,
    contentHash: row.content_hash,
  };
}

function sameChunkRef(
  current: Record<string, unknown>,
  next: Extract<BrainGraphRef, { type: "chunk" }>,
): boolean {
  return (
    current.id === next.id &&
    current.sourceId === next.sourceId &&
    current.sourcePath === next.sourcePath &&
    current.stableId === next.stableId &&
    current.symbol === next.symbol &&
    current.contentHash === next.contentHash
  );
}

function matchChunk(
  chunks: ChunkRow[],
  ref: Record<string, unknown>,
): ChunkRow | null {
  const stableId = typeof ref.stableId === "string" ? ref.stableId : null;
  const sourcePath =
    typeof ref.sourcePath === "string" ? ref.sourcePath : null;
  const symbol = typeof ref.symbol === "string" ? ref.symbol : null;
  const contentHash =
    typeof ref.contentHash === "string" ? ref.contentHash : null;

  return (
    chunks.find((chunk) => stableId !== null && chunk.stable_id === stableId) ??
    chunks.find(
      (chunk) =>
        sourcePath !== null &&
        symbol !== null &&
        chunk.path === sourcePath &&
        chunk.symbol === symbol,
    ) ??
    chunks.find(
      (chunk) =>
        sourcePath !== null &&
        contentHash !== null &&
        chunk.path === sourcePath &&
        chunk.content_hash === contentHash,
    ) ??
    null
  );
}

async function findChunkForSourceRef(
  db: EdgesDb,
  projectId: string,
  sourceRef: BrainSourceRef,
): Promise<ChunkRow | null> {
  const rows = await db.execute(sql`
    SELECT id, source_id, stable_id, path, symbol, content_hash
    FROM brain_chunks
    WHERE project_id = ${projectId}
      AND path = ${sourceRef.sourcePath}
      AND (${sourceRef.stableId ?? null}::text IS NULL OR stable_id = ${sourceRef.stableId ?? null})
    ORDER BY updated_at DESC, stable_id ASC
    LIMIT 1
  `);

  return (rows.rows[0] as unknown as ChunkRow | undefined) ?? null;
}

export async function createRetainSourceEdges(
  db: EdgesDb,
  args: {
    projectId: string;
    itemId: string;
    sourceRef: BrainSourceRef | null | undefined;
  },
): Promise<void> {
  if (!args.sourceRef) return;

  const chunk = await findChunkForSourceRef(
    db,
    args.projectId,
    args.sourceRef,
  );

  if (!chunk) return;

  await db.execute(sql`
    INSERT INTO brain_edges
      (id, project_id, from_ref, to_ref, relation, confidence, degraded)
    VALUES
      (${randomUUID()}, ${args.projectId},
       ${JSON.stringify({ type: "item", id: args.itemId })}::jsonb,
       ${JSON.stringify(chunkRef(chunk))}::jsonb,
       'derived_from', 1, false)
  `);
}

export async function reanchorBrainEdgesForSource(
  db: EdgesDb,
  args: { projectId: string; sourceId: string },
): Promise<ReanchorResult> {
  const source = await db.execute(sql`
    SELECT path FROM brain_sources
    WHERE id = ${args.sourceId} AND project_id = ${args.projectId}
  `);
  const sourcePath = source.rows[0]?.path;

  if (typeof sourcePath !== "string") return { remapped: 0, degraded: 0 };

  const chunksRows = await db.execute(sql`
    SELECT id, source_id, stable_id, path, symbol, content_hash
    FROM brain_chunks
    WHERE source_id = ${args.sourceId} AND project_id = ${args.projectId}
    ORDER BY stable_id ASC
  `);
  const chunks = chunksRows.rows as unknown as ChunkRow[];
  const edgeRows = await db.execute(sql`
    SELECT id, to_ref, degraded
    FROM brain_edges
    WHERE project_id = ${args.projectId}
      AND to_ref->>'type' = 'chunk'
      AND (
        to_ref->>'sourceId' = ${args.sourceId}
        OR to_ref->>'sourcePath' = ${sourcePath}
      )
    ORDER BY id ASC
  `);
  const edges = edgeRows.rows as unknown as EdgeRow[];
  let remapped = 0;
  let degraded = 0;

  for (const edge of edges) {
    const match = matchChunk(chunks, edge.to_ref);

    if (match) {
      const nextRef = chunkRef(match);

      if (!sameChunkRef(edge.to_ref, nextRef) || edge.degraded) {
        await db.execute(sql`
          UPDATE brain_edges
          SET to_ref = ${JSON.stringify(nextRef)}::jsonb,
              degraded = false,
              updated_at = now()
          WHERE id = ${edge.id} AND project_id = ${args.projectId}
        `);

        if (edge.to_ref.id !== nextRef.id) remapped += 1;
      }

      continue;
    }

    if (!edge.degraded) {
      await db.execute(sql`
        UPDATE brain_edges
        SET degraded = true,
            updated_at = now()
        WHERE id = ${edge.id} AND project_id = ${args.projectId}
      `);
      degraded += 1;
    }
  }

  log.info(
    {
      projectId: args.projectId,
      sourceId: args.sourceId,
      remapped,
      degraded,
    },
    "brain source edges re-anchored",
  );

  return { remapped, degraded };
}

export async function listBrainItemEdges(
  db: EdgesDb,
  args: { projectId: string; itemId: string },
): Promise<
  Array<{
    id: string;
    toRef: BrainGraphRef;
    relation: string;
    confidence: number;
    degraded: boolean;
  }>
> {
  const rows = await db.execute(sql`
    SELECT id, to_ref, relation, confidence::float8 AS confidence, degraded
    FROM brain_edges
    WHERE project_id = ${args.projectId}
      AND from_ref = ${JSON.stringify({ type: "item", id: args.itemId })}::jsonb
    ORDER BY created_at ASC
  `);

  return rows.rows.map((row) => ({
    id: String(row.id),
    toRef: row.to_ref as BrainGraphRef,
    relation: String(row.relation),
    confidence: Number(row.confidence),
    degraded: Boolean(row.degraded),
  }));
}
