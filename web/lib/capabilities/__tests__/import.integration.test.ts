import { randomUUID } from "node:crypto";
import { chmod, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { execFile as execFileCb } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  installCapabilityRevision,
  runCapabilityRevisionSetup,
} from "@/lib/capabilities/import";
import * as schemaModule from "@/lib/db/schema";
import { isMaisterError } from "@/lib/errors";
import { systemCapabilityCachePath } from "@/lib/flow-paths";

const schema = schemaModule as unknown as Record<string, any>;

const execFile = promisify(execFileCb);

// ─── fixture builder ────────────────────────────────────────────────────────

async function gitRun(cwd: string, args: string[]): Promise<void> {
  await execFile("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  });
}

// Build a local git-repo capability fixture. The repo carries a sentinel-writing
// setup.sh when withSetup=true so tests can assert it was or wasn't run.
async function buildCapabilityFixture(
  parentDir: string,
  name: string,
  withSetup: boolean,
  setupExitCode: 0 | 1 = 0,
): Promise<string> {
  const repoDir = join(parentDir, name);

  await mkdir(repoDir, { recursive: true });
  await gitRun(repoDir, ["init", "-q"]);
  await gitRun(repoDir, ["checkout", "-q", "-b", "main"]);

  // A minimal README so the commit is non-empty.
  await writeFile(join(repoDir, "README.md"), `# ${name}\n`);

  if (withSetup) {
    // Write sentinel relative to cwd (runSetupSh sets cwd=installedPath) so
    // the path stays valid after the repo is copied to the cache directory.
    await writeFile(
      join(repoDir, "setup.sh"),
      `#!/usr/bin/env bash\necho "ran" > ./sentinel.txt\nexit ${setupExitCode}\n`,
    );
    await chmod(join(repoDir, "setup.sh"), 0o755);
  }

  await gitRun(repoDir, ["add", "."]);
  await gitRun(repoDir, ["commit", "-q", "-m", "init v1.0.0"]);
  await gitRun(repoDir, ["tag", "v1.0.0"]);

  return repoDir;
}

// ─── shared state ───────────────────────────────────────────────────────────

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: any;
let homeDir: string;
let fixturesDir: string;
let projectId: string;
let originalHome: string | undefined;

let repoWithSetupOk: string;
let repoWithSetupFail: string;
let repoNoSetup: string;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("cap_import_test")
    .withUsername("test")
    .withPassword("test")
    .start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);
  await migrate(db, { migrationsFolder: "./lib/db/migrations" });

  homeDir = join(tmpdir(), `cap-import-test-home-${randomUUID()}`);
  fixturesDir = join(tmpdir(), `cap-import-test-fixtures-${randomUUID()}`);
  await mkdir(homeDir, { recursive: true });
  await mkdir(fixturesDir, { recursive: true });

  originalHome = process.env.HOME;
  process.env.HOME = homeDir;

  repoWithSetupOk = await buildCapabilityFixture(
    fixturesDir,
    "cap-with-setup-ok",
    true,
    0,
  );
  repoWithSetupFail = await buildCapabilityFixture(
    fixturesDir,
    "cap-with-setup-fail",
    true,
    1,
  );
  repoNoSetup = await buildCapabilityFixture(
    fixturesDir,
    "cap-no-setup",
    false,
  );

  projectId = randomUUID();
  await db.insert(schema.projects).values({
    id: projectId,
    slug: "cap-import-test-proj",
    name: "Cap Import Test",
    repoPath: fixturesDir,
    maisterYamlPath: join(fixturesDir, "maister.yaml"),
  });
}, 180_000);

afterAll(async () => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;

  await pool?.end();
  await container?.stop();
  await rm(homeDir, { recursive: true, force: true });
  await rm(fixturesDir, { recursive: true, force: true });
});

// ─── T2.2 tests ─────────────────────────────────────────────────────────────

describe("installCapabilityRevision", () => {
  it("installs local source with setup.sh: sentinel ABSENT after install (setup deferred), SHA recorded, setupStatus=pending", async () => {
    const result = await installCapabilityRevision({
      source: repoWithSetupOk,
      version: "v1.0.0",
      capabilityRefId: "my-skill",
      projectId,
      db,
    });

    // 40-hex SHA recorded.
    expect(result.resolvedRevision).toMatch(/^[0-9a-f]{40}$/);

    // Sentinel MUST NOT exist — setup.sh was deferred, not executed.
    const sentinelPath = join(result.installedPath, "sentinel.txt");

    await expect(stat(sentinelPath)).rejects.toMatchObject({ code: "ENOENT" });

    // setupStatus correctly reflects deferred setup.
    expect(result.setupStatus).toBe("pending");

    // DB row exists with Installed package status.
    const rows = await db
      .select()
      .from(schema.capabilityImports)
      .where(eq(schema.capabilityImports.id, result.importRowId));

    expect(rows).toHaveLength(1);
    expect(rows[0].packageStatus).toBe("Installed");
    expect(rows[0].setupStatus).toBe("pending");
    expect(rows[0].resolvedRevision).toBe(result.resolvedRevision);
  });

  it("re-install of same (projectId, capabilityRefId, resolvedRevision) is idempotent: returns same importRowId", async () => {
    const first = await installCapabilityRevision({
      source: repoNoSetup,
      version: "v1.0.0",
      capabilityRefId: "idempotent-cap",
      projectId,
      db,
    });

    await new Promise((r) => setTimeout(r, 50));

    const second = await installCapabilityRevision({
      source: repoNoSetup,
      version: "v1.0.0",
      capabilityRefId: "idempotent-cap",
      projectId,
      db,
    });

    expect(second.importRowId).toBe(first.importRowId);
    expect(second.resolvedRevision).toBe(first.resolvedRevision);
    expect(second.installedPath).toBe(first.installedPath);
  });

  it("no-setup source: setupStatus=not_required, sentinel trivially absent", async () => {
    const result = await installCapabilityRevision({
      source: repoNoSetup,
      version: "v1.0.0",
      capabilityRefId: "no-setup-cap",
      projectId,
      db,
    });

    expect(result.setupStatus).toBe("not_required");
  });

  it("traversal capabilityRefId '../evil' passed to systemCapabilityCachePath throws FLOW_INSTALL, nothing written outside cache", async () => {
    // Directly test the path builder.
    let threw = false;

    try {
      systemCapabilityCachePath("../evil", "a".repeat(40));
    } catch (err) {
      threw = true;
      expect(isMaisterError(err)).toBe(true);
      if (isMaisterError(err)) {
        expect(err.code).toBe("FLOW_INSTALL");
      }
    }

    expect(threw).toBe(true);

    // installCapabilityRevision must also refuse the traversal refId.
    let installThrew = false;

    try {
      await installCapabilityRevision({
        source: repoNoSetup,
        version: "v1.0.0",
        capabilityRefId: "../evil",
        projectId,
        db,
      });
    } catch (err) {
      installThrew = true;
      expect(isMaisterError(err)).toBe(true);
      if (isMaisterError(err)) {
        expect(err.code).toBe("FLOW_INSTALL");
      }
    }

    expect(installThrew).toBe(true);
  });
});

// ─── T2.3 tests ─────────────────────────────────────────────────────────────

describe("runCapabilityRevisionSetup", () => {
  it("untrusted row: refuses to run setup.sh, setupStatus unchanged, sentinel absent", async () => {
    const installed = await installCapabilityRevision({
      source: repoWithSetupOk,
      version: "v1.0.0",
      capabilityRefId: "untrusted-cap",
      projectId,
      db,
    });

    // Local sources resolve to trusted_by_policy. Force untrusted via DB.
    await db
      .update(schema.capabilityImports)
      .set({ trustStatus: "untrusted" })
      .where(eq(schema.capabilityImports.id, installed.importRowId));

    const result = await runCapabilityRevisionSetup({
      importRowId: installed.importRowId,
      db,
    });

    // Status unchanged (still pending).
    expect(result.setupStatus).toBe("pending");

    // Sentinel must not exist.
    const sentinelPath = join(installed.installedPath, "sentinel.txt");

    await expect(stat(sentinelPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("trusted+pending: runs setup.sh, sentinel present, setupStatus=done", async () => {
    const installed = await installCapabilityRevision({
      source: repoWithSetupOk,
      version: "v1.0.0",
      capabilityRefId: "trusted-cap-ok",
      projectId,
      db,
    });

    // Ensure trusted_by_policy (local source → already trusted_by_policy after install).
    const result = await runCapabilityRevisionSetup({
      importRowId: installed.importRowId,
      db,
    });

    expect(result.setupStatus).toBe("done");

    // Sentinel written by setup.sh.
    const sentinelPath = join(installed.installedPath, "sentinel.txt");
    const st = await stat(sentinelPath);

    expect(st.isFile()).toBe(true);

    // DB row reflects done.
    const rows = await db
      .select({ setupStatus: schema.capabilityImports.setupStatus })
      .from(schema.capabilityImports)
      .where(eq(schema.capabilityImports.id, installed.importRowId));

    expect(rows[0]?.setupStatus).toBe("done");
  });

  it("trusted+failed: re-runs setup.sh (retry path), sentinel present, setupStatus=done", async () => {
    const installed = await installCapabilityRevision({
      source: repoWithSetupOk,
      version: "v1.0.0",
      capabilityRefId: "trusted-retry-cap",
      projectId,
      db,
    });

    // Force setupStatus=failed to simulate a prior failed attempt.
    await db
      .update(schema.capabilityImports)
      .set({ setupStatus: "failed" })
      .where(eq(schema.capabilityImports.id, installed.importRowId));

    const result = await runCapabilityRevisionSetup({
      importRowId: installed.importRowId,
      db,
    });

    // Re-ran and succeeded.
    expect(result.setupStatus).toBe("done");

    const sentinelPath = join(installed.installedPath, "sentinel.txt");
    const st = await stat(sentinelPath);

    expect(st.isFile()).toBe(true);
  });

  it("trusted+done: no-op (idempotent), sentinel not rewritten", async () => {
    const installed = await installCapabilityRevision({
      source: repoWithSetupOk,
      version: "v1.0.0",
      capabilityRefId: "trusted-idempotent-cap",
      projectId,
      db,
    });

    // Run once.
    await runCapabilityRevisionSetup({
      importRowId: installed.importRowId,
      db,
    });

    const sentinelPath = join(installed.installedPath, "sentinel.txt");
    const mtimeBefore = (await stat(sentinelPath)).mtimeMs;

    await new Promise((r) => setTimeout(r, 50));

    // Run again — should be a no-op.
    const result = await runCapabilityRevisionSetup({
      importRowId: installed.importRowId,
      db,
    });

    expect(result.setupStatus).toBe("done");

    const mtimeAfter = (await stat(sentinelPath)).mtimeMs;

    // mtime unchanged — sentinel not rewritten.
    expect(mtimeAfter).toBe(mtimeBefore);
  });

  it("trusted+pending with non-zero setup.sh: setupStatus=failed, packageStatus=Failed", async () => {
    const installed = await installCapabilityRevision({
      source: repoWithSetupFail,
      version: "v1.0.0",
      capabilityRefId: "trusted-cap-fail-setup",
      projectId,
      db,
    });

    expect(installed.setupStatus).toBe("pending");

    const result = await runCapabilityRevisionSetup({
      importRowId: installed.importRowId,
      db,
    });

    expect(result.setupStatus).toBe("failed");

    const rows = await db
      .select({
        setupStatus: schema.capabilityImports.setupStatus,
        packageStatus: schema.capabilityImports.packageStatus,
      })
      .from(schema.capabilityImports)
      .where(eq(schema.capabilityImports.id, installed.importRowId));

    expect(rows[0]?.setupStatus).toBe("failed");
    expect(rows[0]?.packageStatus).toBe("Failed");
  });
});
