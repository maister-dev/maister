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

import {
  ensureEmbeddingIndex,
  embeddingIndexName,
} from "@/lib/brain/embedding-index";

// T1.3: brain lineage 0001 (hand-authored) + ensureEmbeddingIndex, on a real
// pgvector image with BOTH lineages migrated (folds the T1.2 0088 column
// assertions into the same container — no trivial-test duplication).

let ctx: BrainTestDb;

function vectorLiteral(seed: number): string {
  // A deterministic 1536-dim vector — one hot dimension so cosine distance is
  // meaningful without floating-point noise.
  const parts = new Array(TEST_EMBEDDING_DIMENSIONS).fill(0);

  parts[seed % TEST_EMBEDDING_DIMENSIONS] = 1;

  return `[${parts.join(",")}]`;
}

async function insertItemWithEmbedding(
  projectId: string,
  seed: number,
): Promise<string> {
  const itemId = randomUUID();
  const embId = randomUUID();
  const contentHash = randomUUID();

  await ctx.db.execute(
    sql`INSERT INTO brain_items (id, project_id, kind, title, content, status, confidence, content_hash)
        VALUES (${itemId}, ${projectId}, 'lesson', 'title', 'content body', 'active', 0.3, ${contentHash})`,
  );
  await ctx.db.execute(
    sql`INSERT INTO brain_embeddings (id, item_id, vector, embedding_provider, embedding_model, embedding_dimensions, embedding_version, source_hash, content_hash)
        VALUES (${embId}, ${itemId}, ${vectorLiteral(seed)}::vector, 'openai_compatible', ${TEST_EMBEDDING_MODEL}, ${TEST_EMBEDDING_DIMENSIONS}, 'v1', ${contentHash}, ${contentHash})`,
  );

  return itemId;
}

beforeAll(async () => {
  ctx = await startBrainTestDb();
}, 180_000);

afterAll(async () => {
  await stopBrainTestDb(ctx);
});

describe("brain foundation — two lineages + pgvector (T1.3)", () => {
  it("0088 shared-table columns exist with the right defaults/nullability", async () => {
    const cols = await ctx.db.execute(
      sql`SELECT table_name, column_name, column_default, is_nullable
          FROM information_schema.columns
          WHERE (table_name = 'projects' AND column_name = 'brain_enabled')
             OR (table_name = 'runs' AND column_name = 'brain_context')
             OR (table_name = 'agent_project_links' AND column_name IN ('can_read_brain','can_write_brain'))
             OR (table_name = 'platform_runtime_settings' AND column_name IN ('embedding_base_url','embedding_model','embedding_dimensions','embedding_api_key_ref','distill_model'))`,
    );
    const byKey = new Map(
      cols.rows.map((r) => [`${r.table_name}.${r.column_name}`, r]),
    );

    // projects.brain_enabled: NOT NULL default false
    expect(byKey.get("projects.brain_enabled")?.is_nullable).toBe("NO");
    expect(
      String(byKey.get("projects.brain_enabled")?.column_default),
    ).toContain("false");
    // agent_project_links write/read axes: NOT NULL default false
    expect(byKey.get("agent_project_links.can_read_brain")?.is_nullable).toBe(
      "NO",
    );
    expect(byKey.get("agent_project_links.can_write_brain")?.is_nullable).toBe(
      "NO",
    );
    // runs.brain_context: nullable (null = inherit)
    expect(byKey.get("runs.brain_context")?.is_nullable).toBe("YES");
    // platform embedding config: all five present + nullable
    for (const c of [
      "embedding_base_url",
      "embedding_model",
      "embedding_dimensions",
      "embedding_api_key_ref",
      "distill_model",
    ]) {
      expect(byKey.get(`platform_runtime_settings.${c}`)?.is_nullable).toBe(
        "YES",
      );
    }
  });

  it("creates the static indexes + the per-generation expression HNSW index", async () => {
    const idx = await ctx.db.execute(
      sql`SELECT indexname, indexdef FROM pg_indexes
          WHERE tablename IN ('brain_items','brain_embeddings')`,
    );
    const names = new Set(idx.rows.map((r) => String(r.indexname)));

    expect(names.has("brain_items_tsv_gin")).toBe(true);
    expect(names.has("brain_items_recall_idx")).toBe(true);
    expect(names.has("brain_items_event_uq")).toBe(true);
    expect(names.has("brain_items_active_hash_uq")).toBe(true);

    const hnsw = embeddingIndexName(
      TEST_EMBEDDING_MODEL,
      TEST_EMBEDDING_DIMENSIONS,
    );

    expect(names.has(hnsw)).toBe(true);
    const def = idx.rows.find((r) => r.indexname === hnsw)?.indexdef ?? "";

    expect(String(def)).toContain("USING hnsw");
    expect(String(def)).toContain("vector_cosine_ops");
  });

  it("a second ensureEmbeddingIndex call is idempotent (IF NOT EXISTS)", async () => {
    const name = await ensureEmbeddingIndex(
      ctx.db,
      TEST_EMBEDDING_MODEL,
      TEST_EMBEDDING_DIMENSIONS,
    );
    const rows = await ctx.db.execute(
      sql`SELECT count(*)::int AS n FROM pg_indexes WHERE indexname = ${name}`,
    );

    expect(Number(rows.rows[0]?.n)).toBe(1);
  });

  it("inserts an item + embedding and answers a cosine query through the cast", async () => {
    const projectId = await seedBrainProject(ctx.db);
    const itemId = await insertItemWithEmbedding(projectId, 3);

    const q = vectorLiteral(3);
    const hits = await ctx.db.execute(
      sql`SELECT e.item_id, (e.vector::vector(${sql.raw(String(TEST_EMBEDDING_DIMENSIONS))})) <=> ${q}::vector(${sql.raw(String(TEST_EMBEDDING_DIMENSIONS))}) AS dist
          FROM brain_embeddings e
          WHERE e.embedding_model = ${TEST_EMBEDDING_MODEL}
            AND e.embedding_dimensions = ${TEST_EMBEDDING_DIMENSIONS}
          ORDER BY dist ASC
          LIMIT 5`,
    );

    expect(hits.rows.length).toBeGreaterThanOrEqual(1);
    // the exact-match vector is the nearest (distance ~0)
    expect(hits.rows[0]?.item_id).toBe(itemId);
    expect(Number(hits.rows[0]?.dist)).toBeLessThan(1e-6);
  });

  it("deleting a projects row cascades brain_items + brain_embeddings", async () => {
    const projectId = await seedBrainProject(ctx.db);
    const itemId = await insertItemWithEmbedding(projectId, 7);

    await ctx.db.execute(sql`DELETE FROM projects WHERE id = ${projectId}`);

    const items = await ctx.db.execute(
      sql`SELECT count(*)::int AS n FROM brain_items WHERE project_id = ${projectId}`,
    );
    const embs = await ctx.db.execute(
      sql`SELECT count(*)::int AS n FROM brain_embeddings WHERE item_id = ${itemId}`,
    );

    expect(Number(items.rows[0]?.n)).toBe(0);
    expect(Number(embs.rows[0]?.n)).toBe(0);
  });
});
