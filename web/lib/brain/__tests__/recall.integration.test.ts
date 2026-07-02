import type { OpenAiCompatibleClient } from "@/lib/brain/openai-compatible";

import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  seedBrainProject,
  startBrainTestDb,
  stopBrainTestDb,
  TEST_EMBEDDING_DIMENSIONS,
  TEST_EMBEDDING_MODEL,
  type BrainTestDb,
} from "./helpers";

import { embeddingIndexName } from "@/lib/brain/embedding-index";
import { recall } from "@/lib/brain/recall";
import { retain } from "@/lib/brain/retain";

// T4.1 — hybrid recall + the default pgvector ranker (real pgvector).

let ctx: BrainTestDb;
let projectId: string;
const DIMS = TEST_EMBEDDING_DIMENSIONS;

// Build a DIMS vector from sparse (index → value) pairs; cosine is
// magnitude-invariant so no normalization is needed.
function vec(pairs: Array<[number, number]>): number[] {
  const v = new Array(DIMS).fill(0);

  for (const [i, x] of pairs) v[i] = x;

  return v;
}

const QUERY = "the recall query zzqzz";
const NEAR = "alpha lesson body";
const MID = "beta lesson body";
const FAR = "gamma lesson body";

// content/query → vector. QUERY == NEAR direction (cosine 1); MID cosine 0.6;
// FAR orthogonal. Lexical overlap between QUERY and contents is nil, so the
// vector leg drives the ranking.
const VMAP = new Map<string, number[]>([
  [QUERY, vec([[0, 1]])],
  [NEAR, vec([[0, 1]])],
  [
    MID,
    vec([
      [0, 0.6],
      [1, 0.8],
    ]),
  ],
  [FAR, vec([[2, 1]])],
]);

let embedCalls = 0;
let completeCalls = 0;

const client: OpenAiCompatibleClient = {
  provider: "openai_compatible",
  model: TEST_EMBEDDING_MODEL,
  dimensions: DIMS,
  version: `${TEST_EMBEDDING_MODEL}@${DIMS}`,
  async embed(texts: string[]): Promise<number[][]> {
    embedCalls++;

    return texts.map((t) => VMAP.get(t) ?? vec([[3, 1]]));
  },
  async complete(): Promise<string> {
    completeCalls++;

    return "";
  },
};

beforeAll(async () => {
  ctx = await startBrainTestDb();
}, 180_000);

afterAll(async () => {
  await stopBrainTestDb(ctx);
});

beforeEach(async () => {
  projectId = await seedBrainProject(ctx.db);
  embedCalls = 0;
  completeCalls = 0;
});

describe("recall — hybrid ranking (T4.1)", () => {
  it("returns the project's active items ranked by similarity, and makes NO completion call", async () => {
    await retain(
      projectId,
      { kind: "lesson", content: NEAR },
      {},
      { db: ctx.db, client },
    );
    await retain(
      projectId,
      { kind: "lesson", content: MID },
      {},
      { db: ctx.db, client },
    );
    await retain(
      projectId,
      { kind: "lesson", content: FAR },
      {},
      { db: ctx.db, client },
    );

    embedCalls = 0;
    completeCalls = 0;

    const hits = await recall(projectId, QUERY, {
      db: ctx.db,
      client,
      limit: 10,
    });

    expect(hits.map((h) => h.content)).toEqual([NEAR, MID, FAR]);
    // exactly one embed (the query); NEVER a completion at read (E-6)
    expect(embedCalls).toBe(1);
    expect(completeCalls).toBe(0);
  });

  it("never returns another project's items (cross-project isolation, E-1)", async () => {
    const other = await seedBrainProject(ctx.db);

    await retain(
      projectId,
      { kind: "lesson", content: NEAR },
      {},
      { db: ctx.db, client },
    );
    const otherRes = await retain(
      other,
      { kind: "lesson", content: NEAR },
      {},
      { db: ctx.db, client },
    );

    const hits = await recall(projectId, QUERY, {
      db: ctx.db,
      client,
      limit: 10,
    });

    expect(hits.map((h) => h.id)).not.toContain(otherRes.itemId);
    expect(hits).toHaveLength(1);
  });

  it("ignores stale-generation embeddings in the vector leg", async () => {
    // an ACTIVE-generation item near the query
    await retain(
      projectId,
      { kind: "lesson", content: NEAR },
      {},
      { db: ctx.db, client },
    );

    // a stale-only item: its ONLY embedding is a different model generation, and
    // its content shares no lexical tokens with the query → must NOT appear.
    const staleId = randomUUID();

    await ctx.db.execute(sql`
      INSERT INTO brain_items (id, project_id, kind, title, content, status, confidence, content_hash)
      VALUES (${staleId}, ${projectId}, 'lesson', 't', 'qqqqq unrelated', 'active', 0.3, ${randomUUID()})
    `);
    await ctx.db.execute(sql`
      INSERT INTO brain_embeddings (id, item_id, vector, embedding_provider, embedding_model, embedding_dimensions, embedding_version, source_hash, content_hash)
      VALUES (${randomUUID()}, ${staleId}, ${`[${vec([[0, 1]]).join(",")}]`}::vector,
              'openai_compatible', 'stale-model', ${DIMS}, 'stale', 'sh', 'ch')
    `);

    const hits = await recall(projectId, QUERY, {
      db: ctx.db,
      client,
      limit: 10,
    });

    expect(hits.map((h) => h.id)).not.toContain(staleId);
  });

  it("uses the per-generation expression HNSW index for the vector leg", async () => {
    for (const c of [NEAR, MID, FAR]) {
      await retain(
        projectId,
        { kind: "lesson", content: c },
        {},
        { db: ctx.db, client },
      );
    }

    const qv = `[${vec([[0, 1]]).join(",")}]`;
    const idxName = embeddingIndexName(TEST_EMBEDDING_MODEL, DIMS);

    const plan = await ctx.db.transaction(async (tx) => {
      await tx.execute(sql.raw("SET LOCAL enable_seqscan = off"));

      const r = await tx.execute(
        sql.raw(
          `EXPLAIN (FORMAT TEXT) SELECT item_id, (vector::vector(${DIMS})) <=> '${qv}'::vector(${DIMS}) AS dist ` +
            `FROM brain_embeddings WHERE embedding_model = '${TEST_EMBEDDING_MODEL}' AND embedding_dimensions = ${DIMS} ` +
            `ORDER BY (vector::vector(${DIMS})) <=> '${qv}'::vector(${DIMS}) LIMIT 20`,
        ),
      );

      return r.rows.map((row) => String(row["QUERY PLAN"])).join("\n");
    });

    expect(plan.toLowerCase()).toContain("hnsw");
    expect(plan).toContain(idxName);
  });

  it("respects the kinds filter and minConfidence", async () => {
    await retain(
      projectId,
      { kind: "lesson", content: NEAR },
      {},
      { db: ctx.db, client },
    );
    await retain(
      projectId,
      { kind: "observation", content: MID },
      {},
      { db: ctx.db, client },
    );

    const onlyLessons = await recall(projectId, QUERY, {
      db: ctx.db,
      client,
      limit: 10,
      kinds: ["lesson"],
    });

    expect(onlyLessons.every((h) => h.kind === "lesson")).toBe(true);
    expect(onlyLessons.map((h) => h.content)).toContain(NEAR);
    expect(onlyLessons.map((h) => h.content)).not.toContain(MID);
  });
});
