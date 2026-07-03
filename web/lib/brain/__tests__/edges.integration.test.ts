import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  fakeEmbeddingClient,
  seedBrainProject,
  startBrainTestDb,
  stopBrainTestDb,
  type BrainTestDb,
} from "./helpers";

import { reanchorBrainEdgesForSource } from "@/lib/brain/edges";
import { retain } from "@/lib/brain/retain";

let ctx: BrainTestDb;
let projectId: string;

const client = fakeEmbeddingClient();

async function seedSource(path: string): Promise<string> {
  const sourceId = randomUUID();

  await ctx.db.execute(sql`
    INSERT INTO brain_sources
      (id, project_id, kind, path, chunker_id, chunker_version, enabled)
    VALUES
      (${sourceId}, ${projectId}, 'markdown', ${path}, 'markdown', '1', true)
  `);

  return sourceId;
}

async function seedChunk(args: {
  sourceId: string;
  stableId: string;
  path: string;
  symbol: string;
  contentHash?: string;
}): Promise<string> {
  const chunkId = randomUUID();
  const contentHash = args.contentHash ?? randomUUID();

  await ctx.db.execute(sql`
    INSERT INTO brain_chunks
      (id, source_id, project_id, stable_id, kind, title, path, symbol,
       content, metadata, source_range, content_hash)
    VALUES
      (${chunkId}, ${args.sourceId}, ${projectId}, ${args.stableId},
       'markdown_section', ${args.symbol}, ${args.path}, ${args.symbol},
       ${`# ${args.symbol}`}, '{}'::jsonb,
       '{"startLine":1,"endLine":5}'::jsonb, ${contentHash})
  `);

  return chunkId;
}

async function insertEdge(args: {
  chunkId: string;
  sourceId: string;
  sourcePath: string;
  stableId: string;
  symbol: string;
  contentHash: string;
}): Promise<string> {
  const edgeId = randomUUID();

  await ctx.db.execute(sql`
    INSERT INTO brain_edges
      (id, project_id, from_ref, to_ref, relation, confidence)
    VALUES
      (${edgeId}, ${projectId},
       ${JSON.stringify({ type: "item", id: randomUUID() })}::jsonb,
       ${JSON.stringify({
         type: "chunk",
         id: args.chunkId,
         sourceId: args.sourceId,
         sourcePath: args.sourcePath,
         stableId: args.stableId,
         symbol: args.symbol,
         contentHash: args.contentHash,
       })}::jsonb,
       'references', 0.9)
  `);

  return edgeId;
}

async function edgeRows(): Promise<
  Array<{ id: string; to_ref: Record<string, unknown>; degraded: boolean }>
> {
  const rows = await ctx.db.execute(sql`
    SELECT id, to_ref, degraded
    FROM brain_edges
    WHERE project_id = ${projectId}
    ORDER BY id
  `);

  return rows.rows as Array<{
    id: string;
    to_ref: Record<string, unknown>;
    degraded: boolean;
  }>;
}

beforeAll(async () => {
  ctx = await startBrainTestDb();
}, 180_000);

afterAll(async () => {
  await stopBrainTestDb(ctx);
});

beforeEach(async () => {
  projectId = await seedBrainProject(ctx.db);
});

describe("brain edges and source re-anchor (T7.1)", () => {
  it("creates a derived_from edge when retain provenance points at a source chunk", async () => {
    const sourcePath = "docs/decisions.md";
    const sourceId = await seedSource(sourcePath);
    const stableId = `${sourcePath}#adr-127`;
    const chunkId = await seedChunk({
      sourceId,
      stableId,
      path: sourcePath,
      symbol: "ADR-127",
      contentHash: "adr-127-v1",
    });

    const retained = await retain(
      projectId,
      {
        kind: "lesson",
        content: "The Brain consultant tier must cite source chunks",
        sourceRef: { sourcePath, stableId },
      },
      {},
      { db: ctx.db, client },
    );

    const item = await ctx.db.execute(sql`
      SELECT source_ref FROM brain_items WHERE id = ${retained.itemId}
    `);
    const edges = await edgeRows();

    expect(item.rows[0]?.source_ref).toEqual({ sourcePath, stableId });
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ degraded: false });
    expect(edges[0]?.to_ref).toMatchObject({
      type: "chunk",
      id: chunkId,
      sourceId,
      sourcePath,
      stableId,
      symbol: "ADR-127",
      contentHash: "adr-127-v1",
    });
  });

  it("remaps chunk edges by symbol/path and degrades removed chunk targets without dropping edges", async () => {
    const sourcePath = "docs/decisions.md";
    const sourceId = await seedSource(sourcePath);
    const oldChunk = await seedChunk({
      sourceId,
      stableId: `${sourcePath}#old-adr-127`,
      path: sourcePath,
      symbol: "ADR-127",
      contentHash: "adr-127-v1",
    });
    const removedChunk = await seedChunk({
      sourceId,
      stableId: `${sourcePath}#old-removed`,
      path: sourcePath,
      symbol: "ADR-REMOVED",
      contentHash: "removed-v1",
    });
    const remapEdgeId = await insertEdge({
      chunkId: oldChunk,
      sourceId,
      sourcePath,
      stableId: `${sourcePath}#old-adr-127`,
      symbol: "ADR-127",
      contentHash: "adr-127-v1",
    });
    const degradeEdgeId = await insertEdge({
      chunkId: removedChunk,
      sourceId,
      sourcePath,
      stableId: `${sourcePath}#old-removed`,
      symbol: "ADR-REMOVED",
      contentHash: "removed-v1",
    });

    await ctx.db.execute(sql`
      DELETE FROM brain_chunks
      WHERE id IN (${oldChunk}, ${removedChunk})
    `);

    const newChunk = await seedChunk({
      sourceId,
      stableId: `${sourcePath}#new-adr-127`,
      path: sourcePath,
      symbol: "ADR-127",
      contentHash: "adr-127-v2",
    });

    const summary = await reanchorBrainEdgesForSource(ctx.db, {
      projectId,
      sourceId,
    });
    const rows = await edgeRows();
    const byId = new Map(rows.map((row) => [row.id, row]));

    expect(summary).toEqual({ remapped: 1, degraded: 1 });
    expect(rows).toHaveLength(2);
    expect(byId.get(remapEdgeId)).toMatchObject({ degraded: false });
    expect(byId.get(remapEdgeId)?.to_ref).toMatchObject({
      id: newChunk,
      stableId: `${sourcePath}#new-adr-127`,
      symbol: "ADR-127",
    });
    expect(byId.get(degradeEdgeId)).toMatchObject({ degraded: true });
    expect(byId.get(degradeEdgeId)?.to_ref).toMatchObject({
      id: removedChunk,
      stableId: `${sourcePath}#old-removed`,
      symbol: "ADR-REMOVED",
    });
  });
});
