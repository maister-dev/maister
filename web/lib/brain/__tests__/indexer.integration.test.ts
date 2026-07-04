import type { OpenAiCompatibleClient } from "@/lib/brain/openai-compatible";

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MaisterError } from "@/lib/errors";
import {
  createBrainSource,
  enqueueBrainSourceReindex,
} from "@/lib/brain/sources";
import { runBrainReindexSweep } from "@/lib/brain/reindex";
import { enqueueSourceReindexForEvents } from "@/lib/brain/index-triggers";
import {
  fakeEmbeddingClient,
  seedBrainProject,
  startBrainTestDb,
  stopBrainTestDb,
  type BrainTestDb,
} from "@/lib/brain/__tests__/helpers";

const execFileAsync = promisify(execFile);

async function git(repo: string, args: string[]): Promise<void> {
  await execFileAsync("git", ["-C", repo, ...args]);
}

async function createIndexerRepo(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), "brain-indexer-"));

  await execFileAsync("git", ["init", "--initial-branch=main", repo]);
  await git(repo, ["config", "user.email", "test@example.com"]);
  await git(repo, ["config", "user.name", "Test User"]);
  await mkdir(join(repo, "docs/api"), { recursive: true });
  await mkdir(join(repo, "docs/guide"), { recursive: true });
  await mkdir(join(repo, "limits"), { recursive: true });
  await writeFile(
    join(repo, "docs/README.md"),
    "# Project Brain\n\nConsultant memory.\n\n## Runbook\n\nUse indexed sources.\n",
  );
  await writeFile(
    join(repo, "docs/decisions.md"),
    "# Decisions\n\nUse indexed recall.\n",
  );
  await writeFile(
    join(repo, "docs/guide/intro.md"),
    "# Intro\n\nGlob coverage.\n",
  );
  await writeFile(
    join(repo, "docs/api/openapi.yaml"),
    "openapi: 3.0.3\npaths: {}\n",
  );
  await writeFile(
    join(repo, "docs/api/broken.openapi.yaml"),
    "openapi: 3.0.3\npaths: [\n",
  );
  await writeFile(
    join(repo, "limits/huge.md"),
    Array.from(
      { length: 1_001 },
      (_, index) => `## Heading ${index}\nBody`,
    ).join("\n\n"),
  );
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-m", "seed"]);

  return repo;
}

async function updateTrackedFile(
  repo: string,
  path: string,
  content: string,
): Promise<void> {
  await writeFile(join(repo, path), content);
  await git(repo, ["add", path]);
  await git(repo, ["commit", "-m", `update ${path}`]);
}

async function deleteTrackedFile(repo: string, path: string): Promise<void> {
  await rm(join(repo, path));
  await git(repo, ["add", path]);
  await git(repo, ["commit", "-m", `delete ${path}`]);
}

function outageEmbeddingClient(): OpenAiCompatibleClient {
  return {
    ...fakeEmbeddingClient(),
    async embed(): Promise<number[][]> {
      throw new MaisterError("EMBEDDING_UNAVAILABLE", "test outage");
    },
  };
}

async function chunkCount(ctx: BrainTestDb, sourceId: string): Promise<number> {
  const r = await ctx.db.execute(sql`
    SELECT count(*)::int AS n FROM brain_chunks WHERE source_id = ${sourceId}
  `);

  return Number(r.rows[0]?.n ?? 0);
}

async function seedIndexerProject(
  ctx: BrainTestDb,
  repoPath: string,
  slugPrefix: string,
): Promise<string> {
  const projectId = await seedBrainProject(ctx.db, {
    slug: `${slugPrefix}-${randomUUID().slice(0, 8)}`,
  });

  await ctx.db.execute(sql`
    UPDATE projects
    SET repo_path = ${repoPath}, main_branch = 'main'
    WHERE id = ${projectId}
  `);

  return projectId;
}

async function embeddingRows(
  ctx: BrainTestDb,
  sourceId: string,
): Promise<Array<{ chunk_id: string; content_hash: string }>> {
  const r = await ctx.db.execute(sql`
    SELECT e.chunk_id, e.content_hash
    FROM brain_embeddings e
    JOIN brain_chunks c ON c.id = e.chunk_id
    WHERE c.source_id = ${sourceId}
    ORDER BY e.chunk_id, e.content_hash
  `);

  return r.rows as Array<{ chunk_id: string; content_hash: string }>;
}

describe("Project Brain source indexer (ADR-127)", () => {
  let ctx: BrainTestDb;
  let projectId: string;
  let repoPath: string;

  beforeAll(async () => {
    ctx = await startBrainTestDb();
    repoPath = await createIndexerRepo();
    projectId = await seedIndexerProject(ctx, repoPath, "brain-indexer");
  });

  afterAll(async () => {
    await stopBrainTestDb(ctx);
  });

  it("indexes tracked sources into chunks and chunk embeddings, then skips unchanged source_hash", async () => {
    const source = await createBrainSource(ctx.db, {
      projectId,
      repoPath,
      mainBranch: "main",
      input: { path: "docs/README.md" },
    });

    await enqueueBrainSourceReindex(ctx.db, {
      projectId,
      sourceId: source.id,
      reason: "manual",
    });

    const first = await runBrainReindexSweep({
      db: ctx.db as any,
      client: fakeEmbeddingClient(),
      maxItemsPerJob: 10,
    });

    expect(first.jobsCompleted).toBe(1);
    expect(await chunkCount(ctx, source.id)).toBeGreaterThanOrEqual(2);
    expect(await embeddingRows(ctx, source.id)).toHaveLength(
      await chunkCount(ctx, source.id),
    );

    const afterFirst = await ctx.db.execute(sql`
      SELECT source_hash, last_indexed_at, last_error
      FROM brain_sources
      WHERE id = ${source.id}
    `);

    expect(afterFirst.rows[0]?.source_hash).toHaveLength(64);
    expect(afterFirst.rows[0]?.last_indexed_at).toBeTruthy();
    expect(afterFirst.rows[0]?.last_error).toBeNull();

    const embeddingsAfterFirst = await embeddingRows(ctx, source.id);

    await enqueueBrainSourceReindex(ctx.db, {
      projectId,
      sourceId: source.id,
      reason: "manual",
    });

    const second = await runBrainReindexSweep({
      db: ctx.db as any,
      client: fakeEmbeddingClient(),
      maxItemsPerJob: 10,
    });

    expect(second.itemsEmbedded).toBe(0);
    expect(await embeddingRows(ctx, source.id)).toEqual(embeddingsAfterFirst);
  });

  it("re-embeds changed chunks for the same source generation", async () => {
    const source = await createBrainSource(ctx.db, {
      projectId,
      repoPath,
      mainBranch: "main",
      input: { path: "docs/api/openapi.yaml" },
    });

    await enqueueBrainSourceReindex(ctx.db, {
      projectId,
      sourceId: source.id,
      reason: "manual",
    });
    await runBrainReindexSweep({
      db: ctx.db as any,
      client: fakeEmbeddingClient(),
      maxItemsPerJob: 10,
    });

    const before = await embeddingRows(ctx, source.id);

    await updateTrackedFile(
      repoPath,
      "docs/api/openapi.yaml",
      "openapi: 3.0.3\npaths:\n  /brain:\n    get:\n      operationId: getBrain\n",
    );
    await enqueueBrainSourceReindex(ctx.db, {
      projectId,
      sourceId: source.id,
      reason: "event",
    });

    const changed = await runBrainReindexSweep({
      db: ctx.db as any,
      client: fakeEmbeddingClient(),
      maxItemsPerJob: 10,
    });
    const after = await embeddingRows(ctx, source.id);

    expect(changed.itemsEmbedded).toBeGreaterThan(0);
    expect(after.map((row) => row.content_hash)).not.toEqual(
      before.map((row) => row.content_hash),
    );
  });

  it("indexes glob sources as separate tracked-file chunks", async () => {
    const globRepoPath = await createIndexerRepo();
    const globProjectId = await seedIndexerProject(
      ctx,
      globRepoPath,
      "brain-indexer-glob",
    );
    const source = await createBrainSource(ctx.db, {
      projectId: globProjectId,
      repoPath: globRepoPath,
      mainBranch: "main",
      input: { path: "docs/**/*.md", kind: "markdown" },
    });

    await enqueueBrainSourceReindex(ctx.db, {
      projectId: globProjectId,
      sourceId: source.id,
      reason: "manual",
    });

    const summary = await runBrainReindexSweep({
      db: ctx.db as any,
      client: fakeEmbeddingClient(),
      maxItemsPerJob: 10,
    });
    const paths = await ctx.db.execute(sql`
      SELECT DISTINCT path
      FROM brain_chunks
      WHERE source_id = ${source.id}
      ORDER BY path ASC
    `);

    expect(summary.jobsCompleted).toBe(1);
    expect(new Set(paths.rows.map((row) => row.path))).toEqual(
      new Set(["docs/README.md", "docs/decisions.md", "docs/guide/intro.md"]),
    );
  });

  it("excludes exact peer sources from glob chunks for the same project and kind", async () => {
    const overlapRepoPath = await createIndexerRepo();
    const overlapProjectId = await seedIndexerProject(
      ctx,
      overlapRepoPath,
      "brain-indexer-overlap",
    );
    const exact = await createBrainSource(ctx.db, {
      projectId: overlapProjectId,
      repoPath: overlapRepoPath,
      mainBranch: "main",
      input: { path: "docs/decisions.md", kind: "markdown" },
    });
    const glob = await createBrainSource(ctx.db, {
      projectId: overlapProjectId,
      repoPath: overlapRepoPath,
      mainBranch: "main",
      input: { path: "docs/**/*.md", kind: "markdown" },
    });

    await enqueueBrainSourceReindex(ctx.db, {
      projectId: overlapProjectId,
      sourceId: exact.id,
      reason: "manual",
    });
    await enqueueBrainSourceReindex(ctx.db, {
      projectId: overlapProjectId,
      sourceId: glob.id,
      reason: "manual",
    });
    await runBrainReindexSweep({
      db: ctx.db as any,
      client: fakeEmbeddingClient(),
      maxItemsPerJob: 10,
    });

    const exactPaths = await ctx.db.execute(sql`
      SELECT DISTINCT path
      FROM brain_chunks
      WHERE source_id = ${exact.id}
      ORDER BY path ASC
    `);
    const globPaths = await ctx.db.execute(sql`
      SELECT DISTINCT path
      FROM brain_chunks
      WHERE source_id = ${glob.id}
      ORDER BY path ASC
    `);

    expect(new Set(exactPaths.rows.map((row) => row.path))).toEqual(
      new Set(["docs/decisions.md"]),
    );
    expect(new Set(globPaths.rows.map((row) => row.path))).toEqual(
      new Set(["docs/README.md", "docs/guide/intro.md"]),
    );
  });

  it("records a bounded source error when chunk production exceeds the job budget", async () => {
    const source = await createBrainSource(ctx.db, {
      projectId,
      repoPath,
      mainBranch: "main",
      input: { path: "limits/huge.md", kind: "markdown" },
    });

    await enqueueBrainSourceReindex(ctx.db, {
      projectId,
      sourceId: source.id,
      reason: "manual",
    });

    const summary = await runBrainReindexSweep({
      db: ctx.db as any,
      client: fakeEmbeddingClient(),
      maxItemsPerJob: 10,
    });
    const row = await ctx.db.execute(sql`
      SELECT last_error
      FROM brain_sources
      WHERE id = ${source.id}
    `);

    expect(summary.jobsCompleted).toBe(1);
    expect(await chunkCount(ctx, source.id)).toBe(0);
    expect(row.rows[0]?.last_error).toMatchObject({ code: "PRECONDITION" });
  });

  it("records parser errors per source and continues other source jobs", async () => {
    const bad = await createBrainSource(ctx.db, {
      projectId,
      repoPath,
      mainBranch: "main",
      input: { path: "docs/api/broken.openapi.yaml", kind: "openapi" },
    });
    const good = await createBrainSource(ctx.db, {
      projectId,
      repoPath,
      mainBranch: "main",
      input: { path: "docs/README.md", kind: "markdown" },
    });

    await enqueueBrainSourceReindex(ctx.db, {
      projectId,
      sourceId: bad.id,
      reason: "manual",
    });
    await enqueueBrainSourceReindex(ctx.db, {
      projectId,
      sourceId: good.id,
      reason: "manual",
    });

    const summary = await runBrainReindexSweep({
      db: ctx.db as any,
      client: fakeEmbeddingClient(),
      maxItemsPerJob: 10,
    });

    expect(summary.jobsCompleted).toBe(2);
    expect(await chunkCount(ctx, good.id)).toBeGreaterThan(0);
    expect(await chunkCount(ctx, bad.id)).toBe(0);

    const badRow = await ctx.db.execute(sql`
      SELECT last_error FROM brain_sources WHERE id = ${bad.id}
    `);

    expect(badRow.rows[0]?.last_error).toMatchObject({
      code: "CONFIG",
      chunkerId: "openapi",
    });
  });

  it("records vanished tracked files and retires old chunks", async () => {
    const source = await createBrainSource(ctx.db, {
      projectId,
      repoPath,
      mainBranch: "main",
      input: { path: "docs/README.md" },
    });

    await enqueueBrainSourceReindex(ctx.db, {
      projectId,
      sourceId: source.id,
      reason: "manual",
    });
    await runBrainReindexSweep({
      db: ctx.db as any,
      client: fakeEmbeddingClient(),
      maxItemsPerJob: 10,
    });
    expect(await chunkCount(ctx, source.id)).toBeGreaterThan(0);

    await deleteTrackedFile(repoPath, "docs/README.md");
    await enqueueBrainSourceReindex(ctx.db, {
      projectId,
      sourceId: source.id,
      reason: "event",
    });
    await runBrainReindexSweep({
      db: ctx.db as any,
      client: fakeEmbeddingClient(),
      maxItemsPerJob: 10,
    });

    expect(await chunkCount(ctx, source.id)).toBe(0);

    const row = await ctx.db.execute(sql`
      SELECT last_error FROM brain_sources WHERE id = ${source.id}
    `);

    expect(row.rows[0]?.last_error).toMatchObject({ code: "PRECONDITION" });
  });

  it("leaves source jobs retryable when the embedding provider is unavailable", async () => {
    await updateTrackedFile(
      repoPath,
      "docs/api/outage.openapi.yaml",
      "openapi: 3.0.3\npaths:\n  /outage:\n    get:\n      operationId: getOutage\n",
    );
    const source = await createBrainSource(ctx.db, {
      projectId,
      repoPath,
      mainBranch: "main",
      input: { path: "docs/api/outage.openapi.yaml", kind: "openapi" },
    });

    await enqueueBrainSourceReindex(ctx.db, {
      projectId,
      sourceId: source.id,
      reason: "manual",
    });

    const summary = await runBrainReindexSweep({
      db: ctx.db as any,
      client: outageEmbeddingClient(),
      maxItemsPerJob: 10,
    });
    const job = await ctx.db.execute(sql`
      SELECT status FROM brain_index_jobs WHERE source_id = ${source.id}
    `);

    expect(summary.errors.join("\n")).toContain("test outage");
    expect(job.rows[0]?.status).toBe("running");
    expect(await chunkCount(ctx, source.id)).toBe(0);
  });

  it("enqueues source jobs idempotently from run-terminal domain events", async () => {
    await updateTrackedFile(
      repoPath,
      "docs/api/trigger.openapi.yaml",
      "openapi: 3.0.3\npaths:\n  /trigger:\n    get:\n      operationId: getTrigger\n",
    );
    const source = await createBrainSource(ctx.db, {
      projectId,
      repoPath,
      mainBranch: "main",
      input: { path: "docs/api/trigger.openapi.yaml", kind: "openapi" },
    });
    const event = {
      id: 987654,
      kind: "run.done",
      projectId,
      runId: "run-trigger",
      taskId: null,
      payload: {},
    } as any;

    const first = await enqueueSourceReindexForEvents([event], {
      db: ctx.db as any,
    });
    const second = await enqueueSourceReindexForEvents([event], {
      db: ctx.db as any,
    });

    expect(first).toBeGreaterThanOrEqual(1);
    expect(second).toBe(0);

    const jobs = await ctx.db.execute(sql`
      SELECT reason, status, resumable_cursor
      FROM brain_index_jobs
      WHERE source_id = ${source.id}
        AND resumable_cursor->>'domainEventId' = ${String(event.id)}
    `);

    expect(jobs.rows).toHaveLength(1);
    expect(jobs.rows[0]).toMatchObject({
      reason: "event",
      status: "queued",
    });
  });
});
