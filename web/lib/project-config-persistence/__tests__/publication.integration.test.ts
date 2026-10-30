import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { git } from "../git";
import { currentConfigStatus, inspectRepository } from "../status";
import { readExportSnapshot, assertExportablePackages } from "../projection";
import { patchProjectManifest } from "../manifest";
import { writeConfigReviewFiles } from "../review-files";

import { projects, users } from "@/lib/db/schema";
import { localDirectoryContentDigest } from "@/lib/flows";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

let database: StartedPostgresTestDb;
let root: string;
const directories: string[] = [];

beforeAll(async () => {
  database = await startMainPostgresTestDb({
    databaseName: "config_publication",
  });
  root = await mkdtemp(join(tmpdir(), "maister-config-publication-"));
}, 180_000);

afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

afterAll(async () => {
  await database?.stop();
  await rm(root, { recursive: true, force: true });
});

async function seedProject(): Promise<{
  projectId: string;
  actorUserId: string;
  repo: string;
}> {
  const projectId = randomUUID();
  const actorUserId = randomUUID();
  const repo = join(root, projectId);

  directories.push(repo);
  await mkdir(repo);
  await git(repo, ["init", "-b", "main"]);
  await git(repo, ["config", "user.name", "Config Test"]);
  await git(repo, ["config", "user.email", "config@example.invalid"]);
  await database.db
    .insert(users)
    .values({ id: actorUserId, email: `${actorUserId}@example.invalid` });
  await database.db.insert(projects).values({
    id: projectId,
    slug: `p-${projectId}`,
    repoPath: repo,
    name: "Runtime",
    taskKey: `PC${projectId.slice(0, 8).toUpperCase()}`,
  });

  return { projectId, actorUserId, repo };
}

it("IT-CPC-03: status compares committed configuration independently of path presence without refreshing the index", async () => {
  const { projectId, repo } = await seedProject();

  expect(await currentConfigStatus(database.db, projectId)).toMatchObject({
    exportState: "missing",
    repositoryState: "ready",
  });
  const snapshot = await readExportSnapshot(database.db, projectId);
  const source = patchProjectManifest(null, snapshot.projection);

  await writeFile(join(repo, "maister.yaml"), source);
  expect(await currentConfigStatus(database.db, projectId)).toMatchObject({
    exportState: "missing",
    repositoryState: "dirty",
  });
  await git(repo, ["add", "maister.yaml"]);
  await git(repo, ["commit", "-m", "source"]);
  const indexBefore = await readFile(join(repo, ".git", "index"));

  expect(await currentConfigStatus(database.db, projectId)).toMatchObject({
    exportState: "in_sync",
    repositoryState: "ready",
  });
  expect(await readFile(join(repo, ".git", "index"))).toEqual(indexBefore);
  await database.db
    .update(projects)
    .set({ name: "Changed" })
    .where(eq(projects.id, projectId));
  expect(await currentConfigStatus(database.db, projectId)).toMatchObject({
    exportState: "pending",
    repositoryState: "ready",
    exportRevision: "1",
  });
  await database.db
    .update(projects)
    .set({ maisterYamlPath: join(repo, "maister.yaml"), brainEnabled: true })
    .where(eq(projects.id, projectId));
  expect(await currentConfigStatus(database.db, projectId)).toMatchObject({
    exportState: "pending",
    exportRevision: "1",
  });
  await writeFile(join(repo, "maister.yaml"), `${source}# user edit\n`);
  expect(await currentConfigStatus(database.db, projectId)).toMatchObject({
    exportState: "pending",
    repositoryState: "dirty",
  });
});

it("IT-CPC-07: deleted local sources and changed directory revisions refuse export while DB runtime remains unchanged", async () => {
  const { projectId, repo } = await seedProject();
  const directory = join(root, randomUUID());

  directories.push(directory);
  await mkdir(directory);
  await writeFile(
    join(directory, "maister-package.yaml"),
    "schemaVersion: 1\nname: source\n",
  );
  const revision = (await localDirectoryContentDigest(directory)).slice(0, 40);
  const snapshot = await readExportSnapshot(database.db, projectId);
  const projection = {
    ...snapshot.projection,
    packages: [
      {
        id: "source",
        source: directory,
        version: `local-${revision.slice(0, 12)}`,
        resolvedRevision: revision,
      },
    ],
  };

  await expect(assertExportablePackages(projection)).resolves.toBeUndefined();
  await writeFile(join(directory, "content.txt"), "changed");
  await expect(assertExportablePackages(projection)).rejects.toMatchObject({
    details: { reason: "package_revision_mismatch" },
  });
  await rm(directory, { recursive: true });
  await expect(assertExportablePackages(projection)).rejects.toMatchObject({
    details: { reason: "package_source_unexportable" },
  });
  expect((await readExportSnapshot(database.db, projectId)).projection).toEqual(
    snapshot.projection,
  );
  expect((await inspectRepository(snapshot.project)).repository.status).toBe(
    "",
  );
  expect(await git(repo, ["ls-files", "-z"])).toBe("");
});

it("IT-CPC-03: invalid committed YAML blocks export while repository evidence failure remains an explicit unavailable error", async () => {
  const { projectId, repo } = await seedProject();

  await writeFile(join(repo, "maister.yaml"), "project: [invalid\n");
  await git(repo, ["add", "maister.yaml"]);
  await git(repo, ["commit", "-m", "invalid source fixture"]);
  expect(await currentConfigStatus(database.db, projectId)).toMatchObject({
    exportState: "blocked",
    repositoryState: "ready",
    reason: "manifest_invalid",
  });
  await rm(join(repo, ".git"), { recursive: true });
  await expect(
    currentConfigStatus(database.db, projectId),
  ).rejects.toMatchObject({
    code: "EXECUTOR_UNAVAILABLE",
    details: { reason: "repository_unavailable" },
  });
});

it("IT-CPC-04: complete creation and update diffs use only maister.yaml paths and leave the checkout untouched", async () => {
  const { projectId, repo } = await seedProject();
  const snapshot = await readExportSnapshot(database.db, projectId);
  const proposed = patchProjectManifest(null, snapshot.projection);
  const created = await writeConfigReviewFiles({
    operationId: randomUUID(),
    repoPath: repo,
    source: null,
    proposed,
    manifestMode: null,
  });

  expect(created.diff).toContain(
    "diff --git a/maister.yaml b/maister.yaml\nnew file mode 100644",
  );
  expect(created.diff).toContain("--- /dev/null\n+++ b/maister.yaml");
  expect(await readFile(join(created.contentDirectory, "after"), "utf8")).toBe(
    proposed,
  );
  expect((await stat(created.contentDirectory)).mode & 0o077).toBe(0);
  expect(
    (await stat(join(created.contentDirectory, "after"))).mode & 0o077,
  ).toBe(0);
  await writeFile(join(repo, "maister.yaml"), proposed, { mode: 0o755 });
  await git(repo, ["add", "maister.yaml"]);
  await git(repo, ["commit", "-m", "baseline"]);
  const beforeIndex = await readFile(join(repo, ".git", "index"));
  const beforeHead = await git(repo, ["rev-parse", "HEAD"]);
  const changed = patchProjectManifest(proposed, {
    ...snapshot.projection,
    name: "Reviewed change",
  });
  const updated = await writeConfigReviewFiles({
    operationId: randomUUID(),
    repoPath: repo,
    source: proposed,
    proposed: changed,
    manifestMode: "100755",
  });

  expect(updated.diff).toContain("--- a/maister.yaml\n+++ b/maister.yaml");
  expect(updated.diff).toContain("+  name: Reviewed change");
  expect(updated.diff).toContain("100755\n");
  expect(updated.diff).not.toContain(updated.contentDirectory);
  expect(await readFile(join(repo, "maister.yaml"), "utf8")).toBe(proposed);
  expect(await readFile(join(repo, ".git", "index"))).toEqual(beforeIndex);
  expect(await git(repo, ["rev-parse", "HEAD"])).toBe(beforeHead);
});

it("IT-CPC-04: complete diffs enforce the exact byte limit without truncation or checkout changes", async () => {
  const { projectId, repo } = await seedProject();
  const snapshot = await readExportSnapshot(database.db, projectId);
  const base = patchProjectManifest(null, snapshot.projection);
  const pilot = await writeConfigReviewFiles({
    operationId: randomUUID(),
    repoPath: repo,
    source: `${base}# aaa\n`,
    proposed: `${base}# bbb\n`,
    manifestMode: "100644",
  });
  const limit = 2 * 1024 * 1024;
  const padding = limit - Buffer.byteLength(pilot.diff);
  const original = "a".repeat(3 + Math.floor(padding / 2));
  const replacement = "b".repeat(3 + Math.ceil(padding / 2));
  const source = `${base}# ${original}\n`;
  const proposed = `${base}# ${replacement}\n`;
  const below = await writeConfigReviewFiles({
    operationId: randomUUID(),
    repoPath: repo,
    source,
    proposed: `${base}# ${replacement.slice(1)}\n`,
    manifestMode: "100644",
  });
  const atLimit = await writeConfigReviewFiles({
    operationId: randomUUID(),
    repoPath: repo,
    source,
    proposed,
    manifestMode: "100644",
  });

  expect(Buffer.byteLength(below.diff)).toBe(limit - 1);
  expect(Buffer.byteLength(atLimit.diff)).toBe(limit);
  expect(atLimit.diff).toContain(`-# ${original}\n`);
  expect(atLimit.diff).toContain(`+# ${replacement}\n`);
  await expect(
    writeConfigReviewFiles({
      operationId: randomUUID(),
      repoPath: repo,
      source,
      proposed: `${base}# ${replacement}x\n`,
      manifestMode: "100644",
    }),
  ).rejects.toMatchObject({
    code: "CONFIG",
    details: { reason: "diff_too_large" },
  });
  expect((await inspectRepository(snapshot.project)).repository.status).toBe(
    "",
  );
  expect(await git(repo, ["ls-files", "-z"])).toBe("");
});

it.each(["private-staging", "..private-staging"])(
  "IT-CPC-08: staging root %s inside the project is rejected before creating files",
  async (directoryName) => {
    const { repo } = await seedProject();
    const previousRoot = process.env.MAISTER_WORKTREES_ROOT;
    const before = await readdir(repo);

    process.env.MAISTER_WORKTREES_ROOT = join(repo, directoryName);
    try {
      await expect(
        writeConfigReviewFiles({
          operationId: randomUUID(),
          repoPath: repo,
          source: null,
          proposed: "review",
          manifestMode: null,
        }),
      ).rejects.toMatchObject({
        code: "PRECONDITION",
        details: { reason: "unsupported_checkout" },
      });
      expect(await readdir(repo)).toEqual(before);
    } finally {
      if (previousRoot === undefined) delete process.env.MAISTER_WORKTREES_ROOT;
      else process.env.MAISTER_WORKTREES_ROOT = previousRoot;
    }
  },
);

it("IT-CPC-07: authentication-bearing package coordinates refuse export without file or network effects", async () => {
  const { projectId, repo } = await seedProject();
  const snapshot = await readExportSnapshot(database.db, projectId);

  for (const source of [
    "https://token@example.invalid/package",
    "https://example.invalid/package?token=fixture",
    "https://example.invalid/package#fixture",
    "file://user@example.invalid/package",
  ]) {
    await expect(
      assertExportablePackages({
        ...snapshot.projection,
        packages: [
          {
            id: "private-source",
            source,
            version: "v1",
            resolvedRevision: "a".repeat(40),
          },
        ],
      }),
    ).rejects.toMatchObject({
      code: "CONFIG",
      details: { reason: "package_source_unexportable" },
    });
  }
  expect(await git(repo, ["status", "--porcelain=v1"])).toBe("");
});

it("IT-CPC-04: global binary attributes cannot hide the proposed text diff", async () => {
  const { repo } = await seedProject();
  const attributes = join(root, `${randomUUID()}-attributes`);
  const configuration = join(root, `${randomUUID()}-gitconfig`);

  await writeFile(attributes, "* -diff\n");
  await writeFile(
    configuration,
    `[core]\nattributesFile = ${JSON.stringify(attributes)}\n`,
  );
  const prior = process.env.GIT_CONFIG_GLOBAL;

  process.env.GIT_CONFIG_GLOBAL = configuration;
  try {
    const review = await writeConfigReviewFiles({
      operationId: randomUUID(),
      repoPath: repo,
      source: null,
      proposed: "schemaVersion: 2\nproject:\n  name: Reviewed\n",
      manifestMode: null,
    });

    expect(review.diff).toContain("+schemaVersion: 2");
    expect(review.diff).toContain("+  name: Reviewed");
    expect(review.diff).not.toContain("Binary files");
    expect(await git(repo, ["status", "--porcelain=v1"])).toBe("");
  } finally {
    if (prior === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = prior;
  }
});
