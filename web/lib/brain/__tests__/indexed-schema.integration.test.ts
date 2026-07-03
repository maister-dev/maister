import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  seedBrainProject,
  startBrainTestDb,
  stopBrainTestDb,
  TEST_EMBEDDING_DIMENSIONS,
  TEST_EMBEDDING_MODEL,
  type BrainTestDb,
} from "./helpers";

import { assertBrainProvisioned } from "@/lib/brain/guard";

let ctx: BrainTestDb;

function vectorLiteral(seed: number): string {
  const parts = new Array(TEST_EMBEDDING_DIMENSIONS).fill(0);

  parts[seed % TEST_EMBEDDING_DIMENSIONS] = 1;

  return `[${parts.join(",")}]`;
}

async function tableColumns(tableName: string): Promise<Set<string>> {
  const rows = await ctx.db.execute(sql`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = ${tableName}
  `);

  return new Set(rows.rows.map((row) => String(row.column_name)));
}

async function constraintDefinition(name: string): Promise<string> {
  const rows = await ctx.db.execute(sql`
    SELECT pg_get_constraintdef(oid) AS def
    FROM pg_constraint
    WHERE conname = ${name}
  `);

  return String(rows.rows[0]?.def ?? "");
}

async function indexExists(name: string): Promise<boolean> {
  const rows = await ctx.db.execute(
    sql`SELECT 1 FROM pg_indexes WHERE indexname = ${name}`,
  );

  return rows.rows.length === 1;
}

function expectColumns(
  actual: Set<string>,
  expected: readonly string[],
): void {
  for (const column of expected) {
    expect(actual.has(column), `expected column ${column}`).toBe(true);
  }
}

async function countRows(tableName: string, projectId: string): Promise<number> {
  const rows = await ctx.db.execute(
    sql`SELECT count(*)::int AS n FROM ${sql.identifier(tableName)} WHERE project_id = ${projectId}`,
  );

  return Number(rows.rows[0]?.n);
}

async function insertIndexedFixture(projectId: string): Promise<{
  sourceId: string;
  chunkId: string;
  itemId: string;
}> {
  const sourceId = randomUUID();
  const chunkId = randomUUID();
  const itemId = randomUUID();
  const hash = randomUUID();

  await ctx.db.execute(sql`
    INSERT INTO brain_sources
      (id, project_id, kind, path, source_hash, chunker_id, chunker_version)
    VALUES
      (${sourceId}, ${projectId}, 'markdown', 'docs/decisions.md', ${hash},
       'markdown', '1')
  `);
  await ctx.db.execute(sql`
    INSERT INTO brain_chunks
      (id, source_id, project_id, stable_id, kind, title, path, content,
       metadata, source_range, content_hash)
    VALUES
      (${chunkId}, ${sourceId}, ${projectId}, 'docs/decisions.md#adr-127',
       'markdown_section', 'ADR-127', 'docs/decisions.md', 'Indexed content',
       '{}'::jsonb, '{"startLine":1,"endLine":10}'::jsonb, ${hash})
  `);
  await ctx.db.execute(sql`
    INSERT INTO brain_items
      (id, project_id, kind, tier, title, content, status, confidence,
       content_hash, source_ref)
    VALUES
      (${itemId}, ${projectId}, 'decision', 'owned', 'Decision', 'Owned decision',
       'active', 0.3, ${randomUUID()}, '{"sourcePath":"docs/decisions.md"}'::jsonb)
  `);

  return { sourceId, chunkId, itemId };
}

beforeAll(async () => {
  ctx = await startBrainTestDb();
}, 180_000);

afterAll(async () => {
  await stopBrainTestDb(ctx);
});

describe("brain indexed-tier schema (ADR-127, migration 0003)", () => {
  it("creates source, chunk, edge, config tables and indexed-tier columns", async () => {
    expectColumns(await tableColumns("brain_sources"), [
      "id",
      "project_id",
      "kind",
      "path",
      "source_hash",
      "chunker_id",
      "chunker_version",
      "enabled",
      "last_indexed_at",
      "last_error",
    ]);
    expectColumns(await tableColumns("brain_chunks"), [
      "id",
      "source_id",
      "project_id",
      "stable_id",
      "kind",
      "title",
      "path",
      "symbol",
      "content",
      "metadata",
      "source_range",
      "content_hash",
      "tsv",
    ]);
    expectColumns(await tableColumns("brain_edges"), [
      "id",
      "project_id",
      "from_ref",
      "to_ref",
      "relation",
      "confidence",
      "degraded",
    ]);
    expectColumns(await tableColumns("brain_project_config"), [
      "project_id",
      "home_resolution",
      "projection_flow_id",
      "autonomy_policy",
    ]);
    expectColumns(await tableColumns("brain_proposal_decision_stats"), [
      "project_id",
      "kind",
      "blast_radius",
      "accepted_count",
      "rejected_count",
      "auto_drafted_count",
    ]);

    const itemKindCheck = await constraintDefinition("brain_items_kind_check");
    const indexReasonCheck = await constraintDefinition(
      "brain_index_jobs_reason_check",
    );

    expect(itemKindCheck).toContain("decision");
    expect(itemKindCheck).toContain("direction");
    expect(indexReasonCheck).toContain("event");
    expect(indexReasonCheck).toContain("chunker_upgrade");

    expectColumns(await tableColumns("brain_items"), ["source_ref"]);
    expectColumns(await tableColumns("brain_embeddings"), [
      "chunk_id",
      "chunker_id",
      "chunker_version",
    ]);
    expectColumns(await tableColumns("brain_index_jobs"), ["source_id"]);
  });

  it("enforces exactly one embedding target and unique chunk generations", async () => {
    const projectId = await seedBrainProject(ctx.db);
    const { chunkId, itemId } = await insertIndexedFixture(projectId);
    const vector = vectorLiteral(11);

    await expect(
      ctx.db.execute(sql`
        INSERT INTO brain_embeddings
          (id, vector, embedding_provider, embedding_model, embedding_dimensions,
           embedding_version, source_hash, content_hash)
        VALUES
          (${randomUUID()}, ${vector}::vector, 'openai_compatible',
           ${TEST_EMBEDDING_MODEL}, ${TEST_EMBEDDING_DIMENSIONS}, 'v1',
           'source', 'content')
      `),
    ).rejects.toMatchObject({ code: "23514" });

    await expect(
      ctx.db.execute(sql`
        INSERT INTO brain_embeddings
          (id, item_id, chunk_id, vector, embedding_provider, embedding_model,
           embedding_dimensions, embedding_version, source_hash, content_hash,
           chunker_id, chunker_version)
        VALUES
          (${randomUUID()}, ${itemId}, ${chunkId}, ${vector}::vector,
           'openai_compatible', ${TEST_EMBEDDING_MODEL},
           ${TEST_EMBEDDING_DIMENSIONS}, 'v1', 'source', 'content',
           'markdown', '1')
      `),
    ).rejects.toMatchObject({ code: "23514" });

    await ctx.db.execute(sql`
      INSERT INTO brain_embeddings
        (id, chunk_id, split_ordinal, vector, embedding_provider, embedding_model,
         embedding_dimensions, embedding_version, source_hash, content_hash,
         chunker_id, chunker_version)
      VALUES
        (${randomUUID()}, ${chunkId}, 0, ${vector}::vector, 'openai_compatible',
         ${TEST_EMBEDDING_MODEL}, ${TEST_EMBEDDING_DIMENSIONS}, 'v1', 'source',
         'content', 'markdown', '1')
    `);

    await expect(
      ctx.db.execute(sql`
        INSERT INTO brain_embeddings
          (id, chunk_id, split_ordinal, vector, embedding_provider,
           embedding_model, embedding_dimensions, embedding_version, source_hash,
           content_hash, chunker_id, chunker_version)
        VALUES
          (${randomUUID()}, ${chunkId}, 0, ${vector}::vector,
           'openai_compatible', ${TEST_EMBEDDING_MODEL},
           ${TEST_EMBEDDING_DIMENSIONS}, 'v1', 'source-2', 'content-2',
           'markdown', '1')
      `),
    ).rejects.toMatchObject({ code: "23505" });

    await expect(indexExists("brain_embeddings_chunk_generation_uq")).resolves.toBe(
      true,
    );
  });

  it("deleting a project cascades indexed-tier rows", async () => {
    const projectId = await seedBrainProject(ctx.db);
    const { chunkId, sourceId } = await insertIndexedFixture(projectId);

    await ctx.db.execute(sql`
      INSERT INTO brain_edges
        (id, project_id, from_ref, to_ref, relation, confidence)
      VALUES
        (${randomUUID()}, ${projectId},
         ${JSON.stringify({ type: "chunk", id: chunkId })}::jsonb,
         ${JSON.stringify({ type: "source", id: sourceId })}::jsonb,
         'references', 0.9)
    `);
    await ctx.db.execute(sql`
      INSERT INTO brain_project_config (project_id, home_resolution)
      VALUES (${projectId}, '{"decision":"indexed"}'::jsonb)
    `);
    await ctx.db.execute(sql`
      INSERT INTO brain_proposal_decision_stats
        (project_id, kind, blast_radius, accepted_count)
      VALUES (${projectId}, 'rule', 'low', 1)
    `);
    await ctx.db.execute(sql`
      INSERT INTO brain_index_jobs (id, project_id, source_id, reason, status)
      VALUES (${randomUUID()}, ${projectId}, ${sourceId}, 'event', 'queued')
    `);

    await ctx.db.execute(sql`DELETE FROM projects WHERE id = ${projectId}`);

    await expect(countRows("brain_sources", projectId)).resolves.toBe(0);
    await expect(countRows("brain_chunks", projectId)).resolves.toBe(0);
    await expect(countRows("brain_edges", projectId)).resolves.toBe(0);
    await expect(countRows("brain_index_jobs", projectId)).resolves.toBe(0);
    await expect(countRows("brain_project_config", projectId)).resolves.toBe(0);
    await expect(
      countRows("brain_proposal_decision_stats", projectId),
    ).resolves.toBe(0);
  });

  it("still fails closed under SQLite before any brain-table access", () => {
    const previous = process.env.DB_URL;

    process.env.DB_URL = "file:./dev.db";
    expect(() => assertBrainProvisioned()).toThrow(/SQLite mode/);

    if (previous === undefined) delete process.env.DB_URL;
    else process.env.DB_URL = previous;
  });
});
