import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  BRAIN_SOURCE_MAX_GLOB_MATCHES,
  createBrainSource,
  deleteBrainSource,
  enqueueBrainSourceReindex,
  listBrainSources,
  readBrainSourceContent,
  readBrainSourceContents,
  seedDefaultBrainSources,
  seedDefaultBrainSourcesForFirstSetup,
  updateBrainSource,
} from "@/lib/brain/sources";
import {
  seedBrainProject,
  startBrainTestDb,
  stopBrainTestDb,
  type BrainTestDb,
} from "@/lib/brain/__tests__/helpers";

const execFileAsync = promisify(execFile);

async function git(repo: string, args: string[]): Promise<void> {
  await execFileAsync("git", ["-C", repo, ...args]);
}

async function createFixtureRepo(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), "brain-sources-"));

  await execFileAsync("git", ["init", "--initial-branch=main", repo]);
  await git(repo, ["config", "user.email", "test@example.com"]);
  await git(repo, ["config", "user.name", "Test User"]);
  await mkdir(join(repo, "docs/api"), { recursive: true });
  await mkdir(join(repo, "docs/guide"), { recursive: true });
  await mkdir(join(repo, "many"), { recursive: true });
  await mkdir(join(repo, "src"), { recursive: true });
  await writeFile(join(repo, "docs/README.md"), "# Brain Docs\n");
  await writeFile(join(repo, "docs/decisions.md"), "# Decisions\n");
  await writeFile(join(repo, "docs/guide/intro.md"), "# Intro\n");
  await writeFile(
    join(repo, "docs/api/openapi.yaml"),
    "openapi: 3.0.3\npaths: {}\n",
  );
  for (let index = 0; index <= BRAIN_SOURCE_MAX_GLOB_MATCHES; index++) {
    await writeFile(
      join(repo, "many", `file-${index}.md`),
      `# File ${index}\n`,
    );
  }
  await writeFile(join(repo, "src/index.ts"), "export const answer = 42;\n");
  await writeFile(join(repo, ".gitignore"), "ignored.txt\n");
  await writeFile(join(repo, "ignored.txt"), "ignored\n");
  await writeFile(join(repo, "untracked.md"), "# Untracked\n");
  await git(repo, ["add", "docs", "src", ".gitignore"]);
  await git(repo, ["commit", "-m", "seed"]);

  return repo;
}

describe("Project Brain sources (ADR-127)", () => {
  let ctx: BrainTestDb;
  let projectId: string;
  let repoPath: string;

  beforeAll(async () => {
    ctx = await startBrainTestDb();
    repoPath = await createFixtureRepo();
    projectId = await seedBrainProject(ctx.db, {
      slug: `brain-sources-${randomUUID().slice(0, 8)}`,
    });
    await ctx.db.execute(sql`
      UPDATE projects
      SET repo_path = ${repoPath}, main_branch = 'main'
      WHERE id = ${projectId}
    `);
  });

  afterAll(async () => {
    await stopBrainTestDb(ctx);
  });

  it("seeds suggested defaults once as metadata-only source rows", async () => {
    const first = await seedDefaultBrainSources(ctx.db, projectId);
    const second = await seedDefaultBrainSources(ctx.db, projectId);

    expect(first.map((source) => source.path)).toEqual(
      expect.arrayContaining([
        "docs/**/*.md",
        "docs/decisions.md",
        ".ai-factory/ROADMAP.md",
        "docs/api/*.yaml",
        "maister.yaml",
      ]),
    );
    expect(second).toHaveLength(0);

    const listed = await listBrainSources(ctx.db, projectId);

    expect(listed.some((source) => source.path === "docs/**/*.md")).toBe(true);
  });

  it("skips suggested defaults after the project already has curated sources", async () => {
    const curatedRepoPath = await createFixtureRepo();
    const curatedProjectId = await seedBrainProject(ctx.db, {
      slug: `brain-sources-curated-${randomUUID().slice(0, 8)}`,
    });

    await ctx.db.execute(sql`
      UPDATE projects
      SET repo_path = ${curatedRepoPath}, main_branch = 'main'
      WHERE id = ${curatedProjectId}
    `);
    await createBrainSource(ctx.db, {
      projectId: curatedProjectId,
      repoPath: curatedRepoPath,
      mainBranch: "main",
      input: { path: "src/index.ts" },
    });

    const seeded = await seedDefaultBrainSourcesForFirstSetup(
      ctx.db,
      curatedProjectId,
    );
    const listed = await listBrainSources(ctx.db, curatedProjectId);

    expect(seeded).toHaveLength(0);
    expect(listed.map((source) => source.path)).toEqual(["src/index.ts"]);
  });

  it("registers an exact tracked source with autodetected kind and chunker metadata", async () => {
    const source = await createBrainSource(ctx.db, {
      projectId,
      repoPath,
      mainBranch: "main",
      input: { path: "docs/api/openapi.yaml" },
    });

    expect(source).toMatchObject({
      kind: "openapi",
      path: "docs/api/openapi.yaml",
      chunkerId: "openapi",
      chunkerVersion: "1",
      enabled: true,
      chunkCount: 0,
    });

    const content = await readBrainSourceContent({
      repoPath,
      ref: "main",
      path: source.path,
    });

    expect(content).toMatchObject({
      content: "openapi: 3.0.3\npaths: {}\n",
    });
    expect(content.sourceHash).toHaveLength(64);
  });

  it("expands glob sources only to tracked matching files", async () => {
    const content = await readBrainSourceContents({
      repoPath,
      ref: "main",
      path: "docs/**/*.md",
    });

    expect(content.sourceHash).toHaveLength(64);
    expect(content.files.map((file) => file.path)).toEqual([
      "docs/README.md",
      "docs/decisions.md",
      "docs/guide/intro.md",
    ]);
  });

  it("rejects overly broad glob sources before registration", async () => {
    await expect(
      readBrainSourceContents({
        repoPath,
        ref: "main",
        path: "many/**/*.md",
      }),
    ).rejects.toMatchObject({ code: "PRECONDITION" });

    await expect(
      createBrainSource(ctx.db, {
        projectId,
        repoPath,
        mainBranch: "main",
        input: { path: "many/**/*.md", kind: "markdown" },
      }),
    ).rejects.toMatchObject({ code: "PRECONDITION" });
  });

  it("fails closed for traversal, .git, ignored, and untracked source paths", async () => {
    await expect(
      createBrainSource(ctx.db, {
        projectId,
        repoPath,
        mainBranch: "main",
        input: { path: "../outside.md" },
      }),
    ).rejects.toMatchObject({ code: "CONFIG" });

    for (const path of [".git/config", "ignored.txt", "untracked.md"]) {
      await expect(
        createBrainSource(ctx.db, {
          projectId,
          repoPath,
          mainBranch: "main",
          input: { path },
        }),
      ).rejects.toMatchObject({ code: "PRECONDITION" });
    }
  });

  it("updates, deletes, and enqueues source-scoped manual reindex jobs", async () => {
    const created = await createBrainSource(ctx.db, {
      projectId,
      repoPath,
      mainBranch: "main",
      input: { path: "src/index.ts" },
    });

    const updated = await updateBrainSource(ctx.db, {
      projectId,
      repoPath,
      mainBranch: "main",
      sourceId: created.id,
      input: { enabled: false },
    });

    expect(updated.enabled).toBe(false);

    const jobId = await enqueueBrainSourceReindex(ctx.db, {
      projectId,
      sourceId: created.id,
      reason: "manual",
    });
    const jobs = await ctx.db.execute(sql`
      SELECT source_id, reason, status
      FROM brain_index_jobs
      WHERE id = ${jobId}
    `);

    expect(jobs.rows[0]).toMatchObject({
      source_id: created.id,
      reason: "manual",
      status: "queued",
    });

    await deleteBrainSource(ctx.db, { projectId, sourceId: created.id });

    const afterDelete = await listBrainSources(ctx.db, projectId);

    expect(afterDelete.some((source) => source.id === created.id)).toBe(false);
  });
});
