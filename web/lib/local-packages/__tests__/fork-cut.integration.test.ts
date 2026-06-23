import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closeDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { isMaisterError } from "@/lib/errors";
import {
  forkElementToDefault,
  forkElementToNewLocal,
  forkPackageToLocal,
} from "@/lib/local-packages/fork";
import {
  exportWorkingDir,
  getDefaultLocalPackage,
  getLocalPackage,
  listFiles,
  stampLastCutInstall,
  writeWorkingDirFile,
} from "@/lib/local-packages/service";
import { installPackageRevision } from "@/lib/packages/attach";
import { getAccessibleProjects } from "@/lib/queries/platform-flows";

// FIXME(any): dual drizzle peer-dep variants (matches service.integration.test.ts).
const schema = schemaModule as unknown as Record<string, any>;

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase<typeof schemaModule>;
let homeDir: string;
let originalHome: string | undefined;
let originalDbUrl: string | undefined;
let userId: string;
let sourceInstallId: string;
let sourcePkgDir: string;

const FLOW_YAML = (name: string): string =>
  `schemaVersion: 1\nname: ${name}\nsteps:\n  - id: s1\n    type: cli\n    command: echo hi\n`;

// A fixture package on disk: two flows, a skill bundle, an agent .md, a rule.
async function buildSourcePackage(root: string): Promise<void> {
  for (const f of ["flow-a", "flow-b"]) {
    await mkdir(join(root, `flows/${f}`), { recursive: true });
    await writeFile(join(root, `flows/${f}/flow.yaml`), FLOW_YAML(f));
  }
  await mkdir(join(root, "skills/skill-one"), { recursive: true });
  await writeFile(join(root, "skills/skill-one/SKILL.md"), "skill body\n");
  await mkdir(join(root, "agents"), { recursive: true });
  await writeFile(join(root, "agents/agent-one.md"), "agent body\n");
  await mkdir(join(root, "rules"), { recursive: true });
  await writeFile(join(root, "rules/rule-one.md"), "rule body\n");
  await writeFile(
    join(root, "maister-package.yaml"),
    `schemaVersion: 1
name: srcpkg
flows:
  - { id: flow-a, path: flows/flow-a }
  - { id: flow-b, path: flows/flow-b }
capabilities: []
`,
  );
}

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("forkcut_test")
    .withUsername("test")
    .withPassword("test")
    .start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool, { schema: schemaModule });
  await migrate(db, { migrationsFolder: "./lib/db/migrations" });

  // Working dirs + the package cache resolve under ~/.maister — point HOME at a
  // temp dir. getAccessibleProjects uses the global getDb() → point DB_URL at
  // the same container (closeDb() in afterAll before stopping it).
  homeDir = await mkdtemp(join(tmpdir(), "forkcut-int-home-"));
  originalHome = process.env.HOME;
  process.env.HOME = homeDir;
  originalDbUrl = process.env.DB_URL;
  process.env.DB_URL = container.getConnectionUri();

  userId = randomUUID();
  await db
    .insert(schema.users)
    .values({ id: userId, email: `u-${userId}@x.test`, name: "Fork Author" });

  sourcePkgDir = await mkdtemp(join(tmpdir(), "forkcut-int-src-"));
  await buildSourcePackage(sourcePkgDir);
  const installed = await installPackageRevision({
    source: sourcePkgDir,
    version: "srcpkg/v1.0.0",
    trustStatus: "trusted_by_policy",
    db,
  });

  sourceInstallId = installed.id;
}, 180_000);

afterAll(async () => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalDbUrl === undefined) delete process.env.DB_URL;
  else process.env.DB_URL = originalDbUrl;
  await closeDb();
  await pool?.end();
  await container?.stop();
  await rm(homeDir, { recursive: true, force: true });
  await rm(sourcePkgDir, { recursive: true, force: true });
});

describe("fork to local (integration)", () => {
  it("package-level fork copies ALL source elements, records lineage, executes nothing", async () => {
    const { localPackageId } = await forkPackageToLocal({
      sourceInstallId,
      sourceRef: "srcpkg",
      createdBy: userId,
      // Fork dedup (A3): this test needs an isolated fork to edit/cut, so it
      // bypasses dedup — otherwise the second+ fork of one install returns the
      // shared existing fork.
      forceNew: true,
      db,
    });

    const pkg = await getLocalPackage(localPackageId, db);

    expect(pkg).not.toBeNull();
    expect(pkg!.name).toBe("srcpkg-local");
    expect(pkg!.sourceInstallId).toBe(sourceInstallId);
    expect(pkg!.sourceRef).toBe("srcpkg");
    expect(pkg!.isDefault).toBe(false);
    expect(pkg!.projectId).toBeNull();

    const files = await listFiles(pkg!);
    const paths = files.map((f) => f.path);

    // ALL source elements present.
    expect(paths).toContain("maister-package.yaml");
    expect(paths).toContain("flows/flow-a/flow.yaml");
    expect(paths).toContain("flows/flow-b/flow.yaml");
    expect(paths).toContain("skills/skill-one/SKILL.md");
    expect(paths).toContain("agents/agent-one.md");
    expect(paths).toContain("rules/rule-one.md");

    // Fresh git history (re-init'd), source `.git` not copied.
    expect((await stat(join(pkg!.workingDir, ".git"))).isDirectory()).toBe(
      true,
    );
    await expect(
      stat(join(pkg!.workingDir, "skills/skill-one/.git")),
    ).rejects.toBeTruthy();
  });

  it("dedups a second whole-package fork of one install (alreadyExists, same id); forceNew makes a fresh copy", async () => {
    // Test 1 already forked srcpkg (forceNew), so a PLAIN re-fork must return
    // an existing active fork — never a duplicate.
    const a = await forkPackageToLocal({
      sourceInstallId,
      sourceRef: "srcpkg",
      createdBy: userId,
      db,
    });

    expect(a.alreadyExists).toBe(true);

    const b = await forkPackageToLocal({
      sourceInstallId,
      sourceRef: "srcpkg",
      createdBy: userId,
      db,
    });

    expect(b.alreadyExists).toBe(true);
    expect(b.localPackageId).toBe(a.localPackageId);

    // forceNew bypasses dedup → a fresh, distinct local package.
    const fresh = await forkPackageToLocal({
      sourceInstallId,
      sourceRef: "srcpkg",
      createdBy: userId,
      forceNew: true,
      db,
    });

    expect(fresh.alreadyExists).toBe(false);
    expect(fresh.localPackageId).not.toBe(a.localPackageId);
  });

  it("a named (customize) fork uses the override name", async () => {
    const custom = await forkPackageToLocal({
      sourceInstallId,
      sourceRef: "srcpkg",
      createdBy: userId,
      forceNew: true,
      name: "srcpkg (custom)",
      db,
    });
    const pkg = await getLocalPackage(custom.localPackageId, db);

    expect(pkg).not.toBeNull();
    expect(pkg!.name).toBe("srcpkg (custom)");
    expect(pkg!.sourceInstallId).toBe(sourceInstallId);
  });

  it("element fork to a NEW local package copies just that element, no source lineage", async () => {
    const result = await forkElementToNewLocal({
      sourceInstallId,
      elementPath: "flows/flow-a",
      elementName: "flow-a",
      createdBy: userId,
      db,
    });
    const pkg = await getLocalPackage(result.localPackageId, db);

    expect(pkg).not.toBeNull();
    expect(pkg!.name).toBe("flow-a (local)");
    // A partial copy → NO whole-package lineage (fork dedup never conflates it).
    expect(pkg!.sourceInstallId).toBeNull();

    const paths = (await listFiles(pkg!)).map((f) => f.path);

    expect(paths).toContain("flows/flow-a/flow.yaml");
    expect(paths).not.toContain("flows/flow-b/flow.yaml");
    expect(paths).not.toContain("skills/skill-one/SKILL.md");
    expect(paths).not.toContain("agents/agent-one.md");
  });

  it("element fork rejects an escaping element path, no package created", async () => {
    await expect(
      forkElementToNewLocal({
        sourceInstallId,
        elementPath: "../escape",
        elementName: "evil",
        createdBy: userId,
        db,
      }),
    ).rejects.toMatchObject({ code: "PRECONDITION" });
  });

  it("element-level fork copies EXACTLY one element into the project default (created on first use)", async () => {
    const projectId = randomUUID();

    await db.insert(schema.projects).values({
      taskKey: `T${randomUUID().slice(0, 8)}`.toUpperCase(),
      id: projectId,
      slug: `fork-el-${projectId.slice(0, 8)}`,
      name: "Fork Element Proj",
      repoPath: join(homeDir, `repo-${projectId.slice(0, 8)}`),
    });

    // No default package exists yet.
    expect(await getDefaultLocalPackage(projectId, db)).toBeNull();

    const { localPackageId } = await forkElementToDefault({
      projectId,
      projectName: "Fork Element Proj",
      sourceInstallId,
      elementPath: "flows/flow-a",
      createdBy: userId,
      db,
    });

    const def = await getDefaultLocalPackage(projectId, db);

    expect(def).not.toBeNull();
    expect(def!.id).toBe(localPackageId);
    expect(def!.isDefault).toBe(true);
    expect(def!.projectId).toBe(projectId);

    const paths1 = (await listFiles(def!)).map((f) => f.path);

    // EXACTLY the one element (plus the scaffold), NOT flow-b/skills/agents.
    expect(paths1).toContain("flows/flow-a/flow.yaml");
    expect(paths1).not.toContain("flows/flow-b/flow.yaml");
    expect(paths1).not.toContain("skills/skill-one/SKILL.md");
    expect(paths1).not.toContain("agents/agent-one.md");

    // A second element-fork REUSES the same default (race-safe ensure).
    const second = await forkElementToDefault({
      projectId,
      projectName: "Fork Element Proj",
      sourceInstallId,
      elementPath: "agents/agent-one.md",
      createdBy: userId,
      db,
    });

    expect(second.localPackageId).toBe(localPackageId);
    const paths2 = (await listFiles(def!)).map((f) => f.path);

    expect(paths2).toContain("flows/flow-a/flow.yaml");
    expect(paths2).toContain("agents/agent-one.md");
    // still no unrelated source content
    expect(paths2).not.toContain("flows/flow-b/flow.yaml");
  });

  it("element-fork rejects a path that escapes the source bundle, no write", async () => {
    const projectId = randomUUID();

    await db.insert(schema.projects).values({
      taskKey: `T${randomUUID().slice(0, 8)}`.toUpperCase(),
      id: projectId,
      slug: `fork-esc-${projectId.slice(0, 8)}`,
      name: "Fork Escape Proj",
      repoPath: join(homeDir, `repo-esc-${projectId.slice(0, 8)}`),
    });

    await expect(
      forkElementToDefault({
        projectId,
        projectName: "Fork Escape Proj",
        sourceInstallId,
        elementPath: "../../etc/passwd",
        createdBy: userId,
        db,
      }),
    ).rejects.toSatisfy(
      (e: unknown) => isMaisterError(e) && e.code === "PRECONDITION",
    );

    // No default package created — the guard fired before ensureDefault.
    expect(await getDefaultLocalPackage(projectId, db)).toBeNull();
  });

  it("project validation (route guard): a non-member's getAccessibleProjects excludes the project — no write", async () => {
    const projectId = randomUUID();

    await db.insert(schema.projects).values({
      taskKey: `T${randomUUID().slice(0, 8)}`.toUpperCase(),
      id: projectId,
      slug: `fork-priv-${projectId.slice(0, 8)}`,
      name: "Private Proj",
      repoPath: join(homeDir, `repo-priv-${projectId.slice(0, 8)}`),
    });

    const outsiderId = randomUUID();

    await db.insert(schema.users).values({
      id: outsiderId,
      email: `out-${outsiderId}@x.test`,
      name: "Outsider",
    });

    // The exact guard the route applies: the body projectId is not in the
    // caller's accessible set → the route returns 404 before forkElementToDefault.
    const accessible = await getAccessibleProjects(outsiderId, "member");

    expect(accessible.some((p) => p.id === projectId)).toBe(false);

    // Because the route never invokes the fork for an inaccessible project, no
    // default local package is ever created for it.
    expect(await getDefaultLocalPackage(projectId, db)).toBeNull();
  });
});

describe("cut version (integration)", () => {
  it("produces an immutable local-<digest> install; a later edit does NOT change it", async () => {
    // A named local package forked from the source (carries flows → installable).
    const { localPackageId } = await forkPackageToLocal({
      sourceInstallId,
      sourceRef: "srcpkg",
      createdBy: userId,
      // Fork dedup (A3): this test needs an isolated fork to edit/cut, so it
      // bypasses dedup — otherwise the second+ fork of one install returns the
      // shared existing fork.
      forceNew: true,
      db,
    });
    const pkg = await getLocalPackage(localPackageId, db);

    expect(pkg).not.toBeNull();

    // First cut.
    const exportDir1 = await exportWorkingDir(pkg!);
    let install1;

    try {
      install1 = await installPackageRevision({
        source: exportDir1,
        version: "local",
        trustStatus: "trusted_by_policy",
        db,
      });
    } finally {
      await rm(exportDir1, { recursive: true, force: true });
    }

    await stampLastCutInstall(pkg!.id, install1.id, db);

    expect(install1.versionLabel).toMatch(/^local-[0-9a-f]{12}$/);
    const [stamped] = await db
      .select()
      .from(schema.localPackages)
      .where(eq(schema.localPackages.id, pkg!.id));

    expect(stamped.lastCutInstallId).toBe(install1.id);

    const [row1] = await db
      .select()
      .from(schema.packageInstalls)
      .where(eq(schema.packageInstalls.id, install1.id));

    expect(row1.packageStatus).toBe("Installed");
    const cutInstalledPath = row1.installedPath as string;
    const flowABefore = await stat(
      join(cutInstalledPath, "flows/flow-a/flow.yaml"),
    );

    expect(flowABefore.isFile()).toBe(true);

    // Edit the working dir AFTER the cut.
    await writeWorkingDirFile(
      pkg!,
      "flows/flow-a/flow.yaml",
      FLOW_YAML("edited"),
    );

    // The first cut install is content-addressed — unchanged on disk.
    const flowAAfter = await stat(
      join(cutInstalledPath, "flows/flow-a/flow.yaml"),
    );

    expect(flowAAfter.mtimeMs).toBe(flowABefore.mtimeMs);

    // A fresh cut of the edited working dir yields a DIFFERENT install.
    const exportDir2 = await exportWorkingDir(pkg!);
    let install2;

    try {
      install2 = await installPackageRevision({
        source: exportDir2,
        version: "local",
        trustStatus: "trusted_by_policy",
        db,
      });
    } finally {
      await rm(exportDir2, { recursive: true, force: true });
    }

    expect(install2.id).not.toBe(install1.id);
    expect(install2.versionLabel).not.toBe(install1.versionLabel);
  });

  it("optional attach wires the cut install into a project", async () => {
    const { localPackageId } = await forkPackageToLocal({
      sourceInstallId,
      sourceRef: "srcpkg",
      createdBy: userId,
      // Fork dedup (A3): this test needs an isolated fork to edit/cut, so it
      // bypasses dedup — otherwise the second+ fork of one install returns the
      // shared existing fork.
      forceNew: true,
      db,
    });
    const pkg = await getLocalPackage(localPackageId, db);
    const exportDir = await exportWorkingDir(pkg!);
    let install;

    try {
      install = await installPackageRevision({
        source: exportDir,
        version: "local",
        trustStatus: "trusted_by_policy",
        db,
      });
    } finally {
      await rm(exportDir, { recursive: true, force: true });
    }

    const projectId = randomUUID();
    const slug = `cut-attach-${projectId.slice(0, 8)}`;

    await db.insert(schema.projects).values({
      taskKey: `T${randomUUID().slice(0, 8)}`.toUpperCase(),
      id: projectId,
      slug,
      name: "Cut Attach Proj",
      repoPath: join(homeDir, `repo-cut-${projectId.slice(0, 8)}`),
    });

    const { attachPackage } = await import("@/lib/packages/attach");
    const attached = await attachPackage({
      projectId,
      projectSlug: slug,
      packageInstallId: install.id,
      workspaceRoot: join(homeDir, `repo-cut-${projectId.slice(0, 8)}`),
      db,
    });

    expect(attached).not.toBeNull();

    const flowRows = await db
      .select()
      .from(schema.flows)
      .where(eq(schema.flows.projectId, projectId));

    expect(flowRows.map((f: any) => f.flowRefId).sort()).toEqual([
      "flow-a",
      "flow-b",
    ]);
    for (const f of flowRows) expect(f.packageInstallId).toBe(install.id);
  });
});
