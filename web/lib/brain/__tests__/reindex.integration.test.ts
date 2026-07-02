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

import { embeddingIndexName } from "@/lib/brain/embedding-index";
import { recall } from "@/lib/brain/recall";
import { retain } from "@/lib/brain/retain";
import { resetBrainSchemaProbe } from "@/lib/brain/guard";
import { runBrainReindexSweep } from "@/lib/brain/reindex";

// T5.5 — the reindex worker (real pgvector). A model OR dimension switch drains
// brain_index_jobs by re-embedding active items into the new generation, never
// mutating the old rows. Old generation = model-a@1536 (seeded via retain).

let ctx: BrainTestDb;
let projectId: string;

// Distinct generations. The default vectorFor is a per-text one-hot, so a query
// for an item's own content is an exact match in whatever generation it lives.
const modelA = fakeEmbeddingClient({ model: "model-a", dimensions: 1536 });
const modelB = fakeEmbeddingClient({ model: "model-b", dimensions: 1536 });
const modelA768 = fakeEmbeddingClient({ model: "model-a", dimensions: 768 });

async function seedOldGenItems(contents: string[]): Promise<void> {
  // retain with the model-a client writes the item + its model-a@1536 embedding
  // (the "old" generation). Distinct contents are orthogonal → no dedup.
  for (const content of contents) {
    await retain(
      projectId,
      { kind: "lesson", content },
      {},
      { db: ctx.db, client: modelA },
    );
  }
}

async function enqueueJob(): Promise<string> {
  const id = randomUUID();

  await ctx.db.execute(sql`
    INSERT INTO brain_index_jobs (id, project_id, reason, status)
    VALUES (${id}, ${projectId}, 'model_switch', 'queued')
  `);

  return id;
}

async function embCount(model: string, dims: number): Promise<number> {
  const r = await ctx.db.execute(sql`
    SELECT count(*)::int AS n
    FROM brain_embeddings e JOIN brain_items i ON i.id = e.item_id
    WHERE i.project_id = ${projectId}
      AND e.embedding_model = ${model} AND e.embedding_dimensions = ${dims}
  `);

  return Number(r.rows[0]?.n);
}

async function jobStatus(id: string): Promise<string> {
  const r = await ctx.db.execute(
    sql`SELECT status FROM brain_index_jobs WHERE id = ${id}`,
  );

  return String(r.rows[0]?.status);
}

async function indexExists(name: string): Promise<boolean> {
  const r = await ctx.db.execute(
    sql`SELECT 1 FROM pg_indexes WHERE indexname = ${name}`,
  );

  return r.rows.length === 1;
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

describe("reindex worker (T5.5)", () => {
  it("model switch (same N): re-embeds every active item into the new generation, old rows intact (E-2)", async () => {
    await seedOldGenItems(["alpha lesson", "beta lesson", "gamma lesson"]);
    expect(await embCount("model-a", 1536)).toBe(3);

    const jobId = await enqueueJob();
    const summary = await runBrainReindexSweep({ db: ctx.db, client: modelB });

    expect(summary.itemsEmbedded).toBe(3);
    expect(summary.jobsCompleted).toBe(1);
    expect(await jobStatus(jobId)).toBe("completed");

    // New generation fully materialized; the OLD generation is byte-for-byte
    // intact (immutable — a rollback is free).
    expect(await embCount("model-b", 1536)).toBe(3);
    expect(await embCount("model-a", 1536)).toBe(3);
  });

  it("recall then uses only the new generation (vector leg follows active settings)", async () => {
    await seedOldGenItems(["prefer server components", "atomic writes only"]);
    await enqueueJob();
    await runBrainReindexSweep({ db: ctx.db, client: modelB });

    // Recall bound to the NEW generation finds the re-embedded item via the
    // vector leg (model-b@1536 partial index).
    const hits = await recall(projectId, "prefer server components", {
      db: ctx.db,
      client: modelB,
    });

    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits.some((h) => h.content === "prefer server components")).toBe(
      true,
    );
  });

  it("dimension switch (1536 -> 768): new expression index + generation, old rows untouched, recall works", async () => {
    await seedOldGenItems(["dimension change lesson", "second lesson"]);
    await enqueueJob();

    const summary = await runBrainReindexSweep({
      db: ctx.db,
      client: modelA768,
    });

    expect(summary.itemsEmbedded).toBe(2);
    // The worker created the new per-generation expression index (768-dim).
    expect(await indexExists(embeddingIndexName("model-a", 768))).toBe(true);
    // New 768-dim generation written; the old 1536-dim rows are untouched.
    expect(await embCount("model-a", 768)).toBe(2);
    expect(await embCount("model-a", 1536)).toBe(2);

    const hits = await recall(projectId, "dimension change lesson", {
      db: ctx.db,
      client: modelA768,
    });

    expect(hits.some((h) => h.content === "dimension change lesson")).toBe(
      true,
    );
  });

  it("resumes from resumable_cursor after an interrupt (bounded per-tick work)", async () => {
    await seedOldGenItems(["one", "two", "three"]);
    const jobId = await enqueueJob();

    // First tick: cap at one item — the job stays running with a cursor.
    const first = await runBrainReindexSweep({
      db: ctx.db,
      client: modelB,
      maxItemsPerJob: 1,
    });

    expect(first.itemsEmbedded).toBe(1);
    expect(await embCount("model-b", 1536)).toBe(1);
    expect(await jobStatus(jobId)).toBe("running");

    const cursor = await ctx.db.execute(
      sql`SELECT resumable_cursor, progress FROM brain_index_jobs WHERE id = ${jobId}`,
    );

    expect(cursor.rows[0]?.resumable_cursor).toMatchObject({
      lastItemId: expect.any(String),
    });
    expect(Number(cursor.rows[0]?.progress)).toBe(1);

    // Subsequent ticks resume from the worklist until the job completes.
    for (let i = 0; i < 5 && (await jobStatus(jobId)) !== "completed"; i++) {
      await runBrainReindexSweep({
        db: ctx.db,
        client: modelB,
        maxItemsPerJob: 1,
      });
    }

    expect(await jobStatus(jobId)).toBe("completed");
    expect(await embCount("model-b", 1536)).toBe(3);
  });

  it("concurrent double-fire does not create duplicate embeddings (F3)", async () => {
    await seedOldGenItems(["one", "two", "three"]);
    await enqueueJob();

    // Two overlapping sweeps claim the same job (the claim allows 'running') and
    // race the worklist; the (item_id, split_ordinal, embedding_model,
    // embedding_dimensions) UNIQUE + ON CONFLICT DO NOTHING makes the double
    // insert a no-op — never a second row for the same generation.
    await Promise.all([
      runBrainReindexSweep({ db: ctx.db, client: modelB }),
      runBrainReindexSweep({ db: ctx.db, client: modelB }),
    ]);

    expect(await indexExists("brain_embeddings_generation_uq")).toBe(true);
    expect(await embCount("model-b", 1536)).toBe(3); // exactly one per item
  });

  it("no pending jobs → a no-op tick", async () => {
    const summary = await runBrainReindexSweep({ db: ctx.db, client: modelB });

    expect(summary).toMatchObject({
      ran: true,
      jobsProcessed: 0,
      itemsEmbedded: 0,
    });
  });
});

describe("reindex — review-fix hardening (poison item, kill switch)", () => {
  it("is a QUIET no-op on Postgres without the brain lineage applied", async () => {
    resetBrainSchemaProbe();
    const unmigrated = {
      execute: async () => ({ rows: [{ t: null }] }),
      transaction: async () => {
        throw new Error("must not reach a transaction");
      },
    };

    const summary = await runBrainReindexSweep({
      db: unmigrated as never,
      client: modelB,
    });

    expect(summary).toEqual({
      ran: false,
      jobsProcessed: 0,
      jobsCompleted: 0,
      itemsEmbedded: 0,
      errors: [],
    });
    resetBrainSchemaProbe();
  });

  it("a deterministic CONFIG rejection marks the job FAILED with the item recorded — no permanent stall", async () => {
    await seedOldGenItems(["poison content", "healthy content"]);
    const jobId = await enqueueJob();

    // A provider that deterministically rejects (bad model / oversize input →
    // 4xx → CONFIG). Pre-fix the job stayed `running` and re-hit the same item
    // on every tick forever, one paid call per tick.
    const rejecting = fakeEmbeddingClient({
      model: "model-b",
      dimensions: 1536,
    });
    const origEmbed = rejecting.embed.bind(rejecting);

    rejecting.embed = async () => {
      const { MaisterError } = await import("@/lib/errors");

      throw new MaisterError(
        "CONFIG",
        "embedding provider rejected embed (status 400)",
      );
    };
    void origEmbed;

    const summary = await runBrainReindexSweep({
      db: ctx.db as never,
      client: rejecting,
    });

    expect(summary.errors.length).toBe(0); // failed ≠ sweep error; it is a job verdict

    const job = await ctx.db.execute(
      sql`SELECT status, resumable_cursor FROM brain_index_jobs WHERE id = ${jobId}`,
    );

    expect(job.rows[0]?.status).toBe("failed");
    const cursor = job.rows[0]?.resumable_cursor as {
      lastItemId?: string;
      error?: string;
    };

    expect(cursor?.error).toContain("status 400");
    expect(cursor?.lastItemId).toBeTruthy();

    // The next tick does NOT pick the failed job back up.
    const again = await runBrainReindexSweep({
      db: ctx.db as never,
      client: rejecting,
    });

    expect(again.jobsProcessed).toBe(0);
  });

  it("a transient failure leaves the job RUNNING for retry (unchanged contract)", async () => {
    await seedOldGenItems(["transient content"]);
    const jobId = await enqueueJob();

    const flaky = fakeEmbeddingClient({ model: "model-b", dimensions: 1536 });

    flaky.embed = async () => {
      const { MaisterError } = await import("@/lib/errors");

      throw new MaisterError("EMBEDDING_UNAVAILABLE", "outage");
    };

    const summary = await runBrainReindexSweep({
      db: ctx.db as never,
      client: flaky,
    });

    expect(summary.errors.length).toBe(1);

    const job = await ctx.db.execute(
      sql`SELECT status FROM brain_index_jobs WHERE id = ${jobId}`,
    );

    expect(job.rows[0]?.status).toBe("running");
  });

  it("skips jobs of brain-DISABLED projects (kill switch on the write side)", async () => {
    // Isolate from jobs deliberately left running/failed by the prior cases —
    // this test asserts sweep-level counters.
    await ctx.db.execute(sql`DELETE FROM brain_index_jobs`);

    await seedOldGenItems(["disabled project content"]);
    const jobId = await enqueueJob();

    await ctx.db.execute(
      sql`UPDATE projects SET brain_enabled = false WHERE id = ${projectId}`,
    );

    const summary = await runBrainReindexSweep({
      db: ctx.db as never,
      client: modelB,
    });

    expect(summary.jobsProcessed).toBe(0);

    const job = await ctx.db.execute(
      sql`SELECT status FROM brain_index_jobs WHERE id = ${jobId}`,
    );

    // The job survives (stays queued) and resumes when re-enabled.
    expect(job.rows[0]?.status).toBe("queued");

    await ctx.db.execute(
      sql`UPDATE projects SET brain_enabled = true WHERE id = ${projectId}`,
    );

    const resumed = await runBrainReindexSweep({
      db: ctx.db as never,
      client: modelB,
    });

    expect(resumed.jobsCompleted).toBe(1);
  });
});
