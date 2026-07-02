import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  seedBrainProject,
  seedPlatformSettings,
  startBrainTestDb,
  stopBrainTestDb,
  type BrainTestDb,
} from "./helpers";

import { embeddingIndexName } from "@/lib/brain/embedding-index";
import { getBrainSettings, updateBrainSettings } from "@/lib/brain/settings";
import { isMaisterError } from "@/lib/errors";

// T5.1 — platform embedding config (updateBrainSettings service; the admin route
// is a thin auth wrapper over it).

let ctx: BrainTestDb;

beforeAll(async () => {
  ctx = await startBrainTestDb();
}, 180_000);

afterAll(async () => {
  await stopBrainTestDb(ctx);
});

beforeEach(async () => {
  await seedPlatformSettings(ctx.db);
  await ctx.db.execute(sql`
    UPDATE platform_runtime_settings
    SET embedding_base_url = NULL, embedding_model = NULL, embedding_dimensions = NULL,
        embedding_api_key_ref = NULL, distill_model = NULL
    WHERE id = 'singleton'
  `);
});

// An active item with no embeddings at all — a coverage gap in EVERY generation.
async function seedActiveItem(projectId: string): Promise<void> {
  await ctx.db.execute(sql`
    INSERT INTO brain_items (id, project_id, kind, title, content, status, confidence, content_hash)
    VALUES (gen_random_uuid()::text, ${projectId}, 'lesson', 't', 'content to re-embed', 'active', 0.3, md5(random()::text))
  `);
}

describe("updateBrainSettings (T5.1)", () => {
  it("SET / CLEAR / re-SET round-trips each field", async () => {
    await updateBrainSettings(
      {
        embeddingBaseUrl: "https://api.test/v1",
        embeddingModel: "text-embedding-3-small",
        embeddingDimensions: 1536,
        distillModel: "distiller",
      },
      ctx.db,
    );

    let s = await getBrainSettings(ctx.db);

    expect(s.embeddingBaseUrl).toBe("https://api.test/v1");
    expect(s.distillModel).toBe("distiller");

    // CLEAR distill only (partial patch — other fields untouched)
    await updateBrainSettings({ distillModel: null }, ctx.db);
    s = await getBrainSettings(ctx.db);
    expect(s.distillModel).toBeNull();
    expect(s.embeddingModel).toBe("text-embedding-3-small"); // untouched

    // re-SET
    await updateBrainSettings({ distillModel: "distiller-2" }, ctx.db);
    s = await getBrainSettings(ctx.db);
    expect(s.distillModel).toBe("distiller-2");
  });

  it("stores the API key as its env:NAME reference, never a secret", async () => {
    await updateBrainSettings(
      { embeddingApiKeyRef: "env:EMBEDDING_API_KEY" },
      ctx.db,
    );

    const row = await ctx.db.execute(
      sql`SELECT embedding_api_key_ref FROM platform_runtime_settings WHERE id = 'singleton'`,
    );

    expect(row.rows[0]?.embedding_api_key_ref).toBe("env:EMBEDDING_API_KEY");
  });

  it("rejects a raw (non-env:) API key with CONFIG", async () => {
    let thrown: unknown;

    try {
      await updateBrainSettings(
        { embeddingApiKeyRef: "sk-raw-secret" },
        ctx.db,
      );
    } catch (err) {
      thrown = err;
    }

    expect(isMaisterError(thrown) && thrown.code).toBe("CONFIG");
  });

  it("rejects a non-positive dimension with CONFIG", async () => {
    await expect(
      updateBrainSettings({ embeddingDimensions: 0 }, ctx.db),
    ).rejects.toMatchObject({ code: "CONFIG" });
  });

  it("on a model change: creates the new expression index and enqueues a reindex job per enabled project with a coverage gap", async () => {
    const projectId = await seedBrainProject(ctx.db); // brain_enabled

    // An active item with NO embeddings in the new generation = the coverage
    // gap the reconcile enqueue keys on (a project with nothing to re-embed
    // gets no job).
    await seedActiveItem(projectId);

    // initial model
    await updateBrainSettings(
      {
        embeddingBaseUrl: "https://api.test/v1",
        embeddingModel: "model-a",
        embeddingDimensions: 1536,
        distillModel: "d",
      },
      ctx.db,
    );

    // switch model → new generation
    await updateBrainSettings({ embeddingModel: "model-b" }, ctx.db);

    const idx = await ctx.db.execute(
      sql`SELECT indexname FROM pg_indexes WHERE indexname = ${embeddingIndexName("model-b", 1536)}`,
    );

    expect(idx.rows).toHaveLength(1);

    const jobs = await ctx.db.execute(
      sql`SELECT reason, status FROM brain_index_jobs WHERE project_id = ${projectId} AND reason = 'model_switch'`,
    );

    expect(jobs.rows.length).toBeGreaterThanOrEqual(1);
    expect(jobs.rows[0]?.status).toBe("queued");
  });

  it("does NOT double-enqueue while a job is already queued/running", async () => {
    const projectId = await seedBrainProject(ctx.db);

    await seedActiveItem(projectId);
    await updateBrainSettings(
      {
        embeddingBaseUrl: "https://api.test/v1",
        embeddingModel: "model-q",
        embeddingDimensions: 1536,
        distillModel: "d",
      },
      ctx.db,
    );

    // Re-saving the same settings reconciles but finds a live job → no dup.
    await updateBrainSettings({ distillModel: "d2" }, ctx.db);

    const jobs = await ctx.db.execute(
      sql`SELECT count(*)::int AS n FROM brain_index_jobs WHERE project_id = ${projectId}`,
    );

    expect(Number(jobs.rows[0]?.n)).toBe(1);
  });

  it("a FAILED job is recoverable: the next settings save re-enqueues the project", async () => {
    const projectId = await seedBrainProject(ctx.db);

    await seedActiveItem(projectId);
    await updateBrainSettings(
      {
        embeddingBaseUrl: "https://api.test/v1",
        embeddingModel: "model-f",
        embeddingDimensions: 1536,
        distillModel: "d",
      },
      ctx.db,
    );

    // The reindex worker gave up on a poison item.
    await ctx.db.execute(
      sql`UPDATE brain_index_jobs SET status = 'failed' WHERE project_id = ${projectId}`,
    );

    // Any settings save reconciles: failed ∉ {queued,running} + coverage gap →
    // a fresh job.
    await updateBrainSettings({ distillModel: "d3" }, ctx.db);

    const queued = await ctx.db.execute(
      sql`SELECT count(*)::int AS n FROM brain_index_jobs WHERE project_id = ${projectId} AND status = 'queued'`,
    );

    expect(Number(queued.rows[0]?.n)).toBe(1);
  });

  it("rejects dimensions above the pgvector HNSW cap (2000) with CONFIG", async () => {
    await expect(
      updateBrainSettings({ embeddingDimensions: 3072 }, ctx.db),
    ).rejects.toMatchObject({ code: "CONFIG" });
  });

  it("a dimension change is also a reindex generation (no schema migration)", async () => {
    await seedBrainProject(ctx.db);
    await updateBrainSettings(
      {
        embeddingBaseUrl: "https://api.test/v1",
        embeddingModel: "model-c",
        embeddingDimensions: 1536,
        distillModel: "d",
      },
      ctx.db,
    );

    await updateBrainSettings({ embeddingDimensions: 768 }, ctx.db);

    const idx = await ctx.db.execute(
      sql`SELECT indexname FROM pg_indexes WHERE indexname = ${embeddingIndexName("model-c", 768)}`,
    );

    expect(idx.rows).toHaveLength(1); // new dimension → new expression index
  });
});
