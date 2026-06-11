import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

// FIXME(any): dual drizzle-orm peer-dep variants (store idiom).
import * as fullSchema from "@/lib/db/schema";
import { materializeProjectBundlesIntoWorktree } from "@/lib/capabilities/materialize-bundle";

const schema = fullSchema as unknown as Record<string, any>;

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;

const createdPaths: string[] = [];

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("maister_test")
    .withUsername("test")
    .withPassword("test")
    .start();

  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);

  await migrate(db, { migrationsFolder: "./lib/db/migrations" });
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

afterEach(async () => {
  for (const p of createdPaths.splice(0)) {
    await rm(p, { recursive: true, force: true });
  }
});

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);

    return true;
  } catch {
    return false;
  }
}

async function seedProject(): Promise<string> {
  const projectId = randomUUID();

  await db.insert(schema.projects).values({
    id: projectId,
    slug: `proj-${projectId.slice(0, 8)}`,
    name: "Test",
    repoPath: `/tmp/proj-${projectId.slice(0, 8)}`,
    maisterYamlPath: "/tmp/m.yaml",
  });

  return projectId;
}

async function seedImport(args: {
  projectId: string;
  installedPath: string;
  packageStatus: "Installed" | "Installing";
}): Promise<void> {
  await db.insert(schema.capabilityImports).values({
    id: randomUUID(),
    projectId: args.projectId,
    capabilityRefId: `ref-${randomUUID().slice(0, 8)}`,
    source: "github.com/x/bundle",
    versionTag: "v1.0.0",
    resolvedRevision: randomUUID().replace(/-/g, "").padEnd(40, "0"),
    manifestDigest: "sha256:test",
    manifest: { schemaVersion: 1 },
    installedPath: args.installedPath,
    packageStatus: args.packageStatus,
  });
}

async function makeBundleDir(skillName: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "maister-bundle-"));

  createdPaths.push(dir);
  await mkdir(join(dir, "skills", skillName), { recursive: true });
  await writeFile(
    join(dir, "skills", skillName, "SKILL.md"),
    `# ${skillName}\n`,
  );

  return dir;
}

describe("materializeProjectBundlesIntoWorktree (ADR-079 §4)", () => {
  it("copies each Installed bundle, skips non-Installed, writes the override once", async () => {
    const projectId = await seedProject();
    const worktree = await mkdtemp(join(tmpdir(), "maister-wt-"));

    createdPaths.push(worktree);

    const installedA = await makeBundleDir("skill-a");
    const installedB = await makeBundleDir("skill-b");
    const installing = await makeBundleDir("skill-half");

    await seedImport({
      projectId,
      installedPath: installedA,
      packageStatus: "Installed",
    });
    await seedImport({
      projectId,
      installedPath: installedB,
      packageStatus: "Installed",
    });
    await seedImport({
      projectId,
      installedPath: installing,
      packageStatus: "Installing",
    });

    const { bundles } = await materializeProjectBundlesIntoWorktree({
      projectId,
      worktreePath: worktree,
      baseBranch: "develop",
      db,
    });

    expect(bundles).toBe(2);
    expect(
      await pathExists(join(worktree, ".claude", "skills", "skill-a")),
    ).toBe(true);
    expect(
      await pathExists(join(worktree, ".claude", "skills", "skill-b")),
    ).toBe(true);
    // Installing bundle is never copied.
    expect(
      await pathExists(join(worktree, ".claude", "skills", "skill-half")),
    ).toBe(false);

    const override = await readFile(
      join(worktree, ".ai-factory", "config.yaml"),
      "utf8",
    );

    expect(override).toContain("create_branches: false");
    expect(override).toContain("base_branch: develop");

    const gitignore = await readFile(join(worktree, ".gitignore"), "utf8");

    expect(gitignore).toContain("/.ai-factory/config.yaml");
  });

  // Forward guard: the WHOLE materialization block is gated on >=1 Installed
  // import — a non-AIF project must never get a stray `.ai-factory/config.yaml`.
  it("is a strict no-op when the project has no Installed imports", async () => {
    const projectId = await seedProject();
    const worktree = await mkdtemp(join(tmpdir(), "maister-wt-"));

    createdPaths.push(worktree);

    const installing = await makeBundleDir("skill-half");

    await seedImport({
      projectId,
      installedPath: installing,
      packageStatus: "Installing",
    });

    const { bundles } = await materializeProjectBundlesIntoWorktree({
      projectId,
      worktreePath: worktree,
      baseBranch: "main",
      db,
    });

    expect(bundles).toBe(0);
    expect(await pathExists(join(worktree, ".claude"))).toBe(false);
    expect(await pathExists(join(worktree, ".ai-factory"))).toBe(false);
    expect(await pathExists(join(worktree, ".gitignore"))).toBe(false);
  });

  it("is idempotent — a re-run after `git clean -fd` restores the bundle artifacts", async () => {
    const projectId = await seedProject();
    const worktree = await mkdtemp(join(tmpdir(), "maister-wt-"));

    createdPaths.push(worktree);

    const installed = await makeBundleDir("skill-a");

    await seedImport({
      projectId,
      installedPath: installed,
      packageStatus: "Installed",
    });

    const first = await materializeProjectBundlesIntoWorktree({
      projectId,
      worktreePath: worktree,
      baseBranch: "main",
      db,
    });

    expect(first.bundles).toBe(1);

    // Simulate the clean: bundle artifacts are untracked → deleted.
    await rm(join(worktree, ".claude"), { recursive: true, force: true });
    await rm(join(worktree, ".ai-factory"), { recursive: true, force: true });

    const second = await materializeProjectBundlesIntoWorktree({
      projectId,
      worktreePath: worktree,
      baseBranch: "main",
      db,
    });

    expect(second.bundles).toBe(1);
    expect(
      await pathExists(join(worktree, ".claude", "skills", "skill-a")),
    ).toBe(true);
    expect(await pathExists(join(worktree, ".ai-factory", "config.yaml"))).toBe(
      true,
    );
  });
});
