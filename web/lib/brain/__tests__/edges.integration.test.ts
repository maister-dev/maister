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
  it("IT-CBE-01 retains immutable witnesses independently of navigational source anchors", async () => {
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
    const schema = await ctx.pool.query<{ present: boolean }>(
      "SELECT to_regclass('public.brain_evidence_witnesses') IS NOT NULL AS present",
    );

    expect(schema.rows[0]?.present).toBe(true);
    const original = await ctx.pool.query<{
      id: string;
      content_sha256: string;
      selector: string;
    }>(
      "SELECT w.id,w.content_sha256,w.selector FROM brain_evidence_witnesses w JOIN brain_revision_evidence e ON e.witness_id=w.id WHERE e.record_id=$1",
      [retained.itemId],
    );

    expect(original.rows).toHaveLength(1);
    expect(original.rows[0]?.content_sha256).toMatch(/^[a-f0-9]{64}$/);
    const quoted = await retain(
      projectId,
      {
        kind: "observation",
        content: "Another agent quotes the same indexed source",
        sourceRef: { sourcePath, stableId },
      },
      {},
      { db: ctx.db, client },
    );
    const quotations = await ctx.pool.query(
      "SELECT witness_id FROM brain_revision_evidence WHERE record_id IN ($1,$2)",
      [retained.itemId, quoted.itemId],
    );

    expect(quotations.rows).toHaveLength(2);
    expect(
      new Set(quotations.rows.map((row) => String(row.witness_id))).size,
    ).toBe(1);
    expect(
      await ctx.pool.query(
        "SELECT id FROM brain_evidence_observations WHERE project_id=$1",
        [projectId],
      ),
    ).toMatchObject({ rowCount: 1 });
    expect(
      await ctx.pool.query(
        "SELECT id FROM brain_evidence_observations WHERE project_id=$1 AND independence_group_id IS NOT NULL",
        [projectId],
      ),
    ).toMatchObject({ rowCount: 0 });

    await ctx.pool.query(
      "UPDATE brain_chunks SET content='Changed text',content_hash='adr-127-v2' WHERE id=$1",
      [chunkId],
    );
    await reanchorBrainEdgesForSource(ctx.db, { projectId, sourceId });
    expect(
      (
        await ctx.pool.query(
          "SELECT id,content_sha256,selector FROM brain_evidence_witnesses WHERE id=$1",
          [original.rows[0]!.id],
        )
      ).rows,
    ).toEqual(original.rows);
    await ctx.pool.query("DELETE FROM brain_sources WHERE id=$1", [sourceId]);
    expect(
      (
        await ctx.pool.query(
          "SELECT id,content_sha256,selector FROM brain_evidence_witnesses WHERE id=$1",
          [original.rows[0]!.id],
        )
      ).rows,
    ).toEqual(original.rows);
    await expect(
      ctx.pool.query(
        "UPDATE brain_evidence_witnesses SET selector='rewritten' WHERE id=$1",
        [original.rows[0]!.id],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    const companyRecord = await ctx.pool.query<{ id: string }>(
      "INSERT INTO brain_items(id,company_id,kind,title,content,confidence,content_hash) SELECT gen_random_uuid()::text,id,'assertion','Company finding','Company-owned finding',0.3,'company-finding' FROM companies RETURNING id",
    );

    await ctx.pool.query(
      "INSERT INTO brain_revision_evidence(record_id,revision,witness_id,relation,witness_snapshot) SELECT $1,1,witness_id,relation,witness_snapshot FROM brain_revision_evidence WHERE record_id=$2",
      [companyRecord.rows[0]!.id, retained.itemId],
    );
    await ctx.pool.query("DELETE FROM projects WHERE id=$1", [projectId]);
    expect(
      await ctx.pool.query("SELECT id FROM brain_items WHERE id=$1", [
        companyRecord.rows[0]!.id,
      ]),
    ).toMatchObject({ rowCount: 1 });
    expect(
      await ctx.pool.query(
        "SELECT witness_id FROM brain_revision_evidence WHERE record_id=$1",
        [companyRecord.rows[0]!.id],
      ),
    ).toMatchObject({ rowCount: 1 });
    expect(
      await ctx.pool.query(
        "SELECT id FROM brain_evidence_witnesses WHERE id=$1",
        [original.rows[0]!.id],
      ),
    ).toMatchObject({ rowCount: 0 });
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

it("IT-CBE-01 unresolved and foreign source references refuse without partial knowledge writes", async () => {
  const foreignProject = await seedBrainProject(ctx.db);

  await ctx.pool.query(
    "INSERT INTO brain_sources(id,project_id,kind,path,chunker_id,chunker_version) VALUES(gen_random_uuid()::text,$1,'text','private-foreign-source','text','1')",
    [foreignProject],
  );
  for (const sourcePath of ["missing-source", "private-foreign-source"]) {
    await expect(
      retain(
        projectId,
        {
          kind: "lesson",
          content: `Unresolved ${sourcePath}`,
          sourceRef: { sourcePath },
        },
        {},
        { db: ctx.db, client },
      ),
    ).rejects.toMatchObject({
      code: "CONFIG",
      details: { reason: "brain_source_reference_missing" },
    });
  }
  expect(
    await ctx.pool.query("SELECT id FROM brain_items WHERE project_id=$1", [
      projectId,
    ]),
  ).toMatchObject({ rowCount: 0 });
});
