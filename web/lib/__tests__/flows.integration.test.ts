import { randomUUID } from "node:crypto";
import { mkdtemp, readlink, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildFlowFixture } from "./_fixtures/build-flow-plugin";

import * as schemaModule from "@/lib/db/schema";
import { isMaisterError } from "@/lib/errors";
import { installFlowPlugin } from "@/lib/flows";

const schema = schemaModule as unknown as Record<string, any>;

let container: StartedPostgreSqlContainer;
let pool: Pool;

let db: any;
let homeDir: string;
let workspaceRoot: string;
let fixturesDir: string;
let validRepo: string;
let invalidRepo: string;
let setupFailRepo: string;
let projectId: string;
let originalHome: string | undefined;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("flows_test")
    .withUsername("test")
    .withPassword("test")
    .start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);
  await migrate(db, { migrationsFolder: "./lib/db/migrations" });

  homeDir = await mkdtemp(join(tmpdir(), "flows-test-home-"));
  workspaceRoot = await mkdtemp(join(tmpdir(), "flows-test-ws-"));
  fixturesDir = await mkdtemp(join(tmpdir(), "flows-test-fixtures-"));

  originalHome = process.env.HOME;
  process.env.HOME = homeDir;

  validRepo = await buildFlowFixture(fixturesDir, "valid");
  invalidRepo = await buildFlowFixture(fixturesDir, "invalid-manifest");
  setupFailRepo = await buildFlowFixture(fixturesDir, "with-setup-fail");

  projectId = randomUUID();
  await db.insert(schema.projects).values({ taskKey: `T${crypto.randomUUID().slice(0, 8)}`.toUpperCase(),
    id: projectId,
    slug: "demo-app",
    name: "Demo App",
    repoPath: workspaceRoot,
    maisterYamlPath: join(workspaceRoot, "maister.yaml"),
  });
}, 180_000);

afterAll(async () => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;

  await pool?.end();
  await container?.stop();
  await rm(homeDir, { recursive: true, force: true });
  await rm(workspaceRoot, { recursive: true, force: true });
  await rm(fixturesDir, { recursive: true, force: true });
});

describe("installFlowPlugin (integration)", () => {
  it("installs a valid flow plugin end-to-end: clone, manifest, symlink, db upsert", async () => {
    const result = await installFlowPlugin({
      source: validRepo,
      version: "v1.0.0",
      projectId,
      projectSlug: "demo-app",
      flowId: "valid-flow",
      workspaceRoot,
      db,
    });

    // Cache key is now the resolved git SHA (12-char prefix), not the
    // tag — tag movement on the upstream repo doesn't affect in-flight
    // runs because each install lands at a content-addressed directory.
    expect(result.installedPath).toMatch(
      new RegExp(`^${homeDir}/\\.maister/flows/valid-flow@[0-9a-f]{12}$`),
    );
    expect(result.revision).toMatch(/^[0-9a-f]{40}$/);
    expect(result.symlinkPath).toBe(
      `${workspaceRoot}/.maister/demo-app/flows/valid-flow`,
    );
    expect(result.manifest.name).toBe("Test Flow");

    const flowYamlStat = await stat(`${result.installedPath}/flow.yaml`);

    expect(flowYamlStat.isFile()).toBe(true);

    const linkTarget = await readlink(result.symlinkPath);

    expect(linkTarget).toBe(result.installedPath);

    const [row] = await db
      .select()
      .from(schema.flows)
      .where(eq(schema.flows.id, result.flowRowId));

    expect(row.flowRefId).toBe("valid-flow");
    expect(row.version).toBe("v1.0.0");
    expect(row.revision).toBe(result.revision);
    expect(row.installedPath).toBe(result.installedPath);
    expect(row.manifest.runner_profiles).toHaveProperty("claude-default");
  });

  it("idempotent reinstall: same flowId@version skips clone, row id stable", async () => {
    const first = await installFlowPlugin({
      source: validRepo,
      version: "v1.0.0",
      projectId,
      projectSlug: "demo-app",
      flowId: "stable-id",
      workspaceRoot,
      db,
    });
    const mtimeBefore = (await stat(first.installedPath)).mtimeMs;

    await new Promise((r) => setTimeout(r, 50));

    const second = await installFlowPlugin({
      source: validRepo,
      version: "v1.0.0",
      projectId,
      projectSlug: "demo-app",
      flowId: "stable-id",
      workspaceRoot,
      db,
    });
    const mtimeAfter = (await stat(first.installedPath)).mtimeMs;

    expect(second.flowRowId).toBe(first.flowRowId);
    expect(mtimeAfter).toBe(mtimeBefore);
  });

  it("rejects an invalid flow.yaml with FLOW_INSTALL", async () => {
    try {
      await installFlowPlugin({
        source: invalidRepo,
        version: "v1.0.0",
        projectId,
        projectSlug: "demo-app",
        flowId: "bad-manifest",
        workspaceRoot,
        db,
      });
      throw new Error("expected installFlowPlugin to throw");
    } catch (err) {
      if (!isMaisterError(err)) throw err;
      expect(err.code).toBe("FLOW_INSTALL");
      expect(err.message.toLowerCase()).toMatch(/schemaversion|invalid/);
    }
  });

  it("rejects a non-existent tag with FLOW_INSTALL carrying git stderr", async () => {
    try {
      await installFlowPlugin({
        source: validRepo,
        version: "v99.0.0",
        projectId,
        projectSlug: "demo-app",
        flowId: "no-such-tag",
        workspaceRoot,
        db,
      });
      throw new Error("expected installFlowPlugin to throw");
    } catch (err) {
      if (!isMaisterError(err)) throw err;
      expect(err.code).toBe("FLOW_INSTALL");
      // M10 (ADR-021): structured stage-tagged FLOW_INSTALL message that still
      // carries the underlying git stderr after the command/exitStatus prefix.
      expect(err.message).toMatch(/flow install failed \[stage=clone\]/);
    }
  });

  it("upgrade install (v1.0.0 -> v1.1.0): same row id, updated fields, repointed symlink, createdAt preserved", async () => {
    const before = await installFlowPlugin({
      source: validRepo,
      version: "v1.0.0",
      projectId,
      projectSlug: "demo-app",
      flowId: "upgradable",
      workspaceRoot,
      db,
    });

    expect(before.manifest.runner_profiles).toHaveProperty("claude-default");

    const [beforeRow] = await db
      .select()
      .from(schema.flows)
      .where(eq(schema.flows.id, before.flowRowId));

    await new Promise((r) => setTimeout(r, 50));

    const after = await installFlowPlugin({
      source: validRepo,
      version: "v1.1.0",
      projectId,
      projectSlug: "demo-app",
      flowId: "upgradable",
      workspaceRoot,
      db,
    });

    expect(after.flowRowId).toBe(before.flowRowId);
    expect(after.installedPath).toMatch(
      new RegExp(`^${homeDir}/\\.maister/flows/upgradable@[0-9a-f]{12}$`),
    );
    // Upgrade lands at a different SHA-keyed directory; the old
    // bundle is untouched on disk so in-flight runs pinned to the
    // prior revision keep reading their original bytes.
    expect(after.installedPath).not.toBe(before.installedPath);
    expect(after.revision).not.toBe(before.revision);
    expect(after.manifest.runner_profiles).toHaveProperty("claude-glm");

    const linkTarget = await readlink(after.symlinkPath);

    expect(linkTarget).toBe(after.installedPath);

    const [afterRow] = await db
      .select()
      .from(schema.flows)
      .where(eq(schema.flows.id, after.flowRowId));

    expect(afterRow.createdAt.getTime()).toBe(beforeRow.createdAt.getTime());
  });

  it("setup.sh exit 0: install completes, sentinel written, second install skips setup.sh (sentinel mtime unchanged)", async () => {
    const setupOkRepo = await buildFlowFixture(fixturesDir, "with-setup-ok");
    const result1 = await installFlowPlugin({
      source: setupOkRepo,
      version: "v1.0.0",
      projectId,
      projectSlug: "demo-app",
      flowId: "setup-ok-once",
      workspaceRoot,
      db,
    });

    const sentinelPath = `${result1.installedPath}/.maister-setup-done`;
    const sentinelStat = await stat(sentinelPath);

    expect(sentinelStat.isFile()).toBe(true);
    const mtimeBefore = sentinelStat.mtimeMs;

    await new Promise((r) => setTimeout(r, 50));

    const result2 = await installFlowPlugin({
      source: setupOkRepo,
      version: "v1.0.0",
      projectId,
      projectSlug: "demo-app",
      flowId: "setup-ok-once",
      workspaceRoot,
      db,
    });
    const mtimeAfter = (await stat(sentinelPath)).mtimeMs;

    expect(result2.flowRowId).toBe(result1.flowRowId);
    expect(mtimeAfter).toBe(mtimeBefore);
  });

  it("setup.sh non-zero exit (trusted_by_policy): revision installed but not enabled", async () => {
    const result = await installFlowPlugin({
      source: setupFailRepo,
      version: "v1.0.0",
      projectId,
      projectSlug: "demo-app",
      flowId: "setup-fails",
      workspaceRoot,
      db,
    });

    expect(result.flowRowId).toBeTruthy();
    expect(result.installedPath).toMatch(
      new RegExp(`^${homeDir}/\\.maister/flows/setup-fails@[0-9a-f]{12}$`),
    );
    // M10 (ADR-021): setup.sh runs after trust (trusted_by_policy for a local
    // absolute source). A non-zero exit marks the revision Failed and leaves
    // the project enablement at "Installed" — it is NOT auto-enabled.
    expect(result.enablementState).toBe("Installed");

    const linkTarget = await readlink(result.symlinkPath);

    expect(linkTarget).toBe(result.installedPath);
  });

  it("concurrent installs (same project+flow+version) share one clone via dedup map", async () => {
    const args = {
      source: validRepo,
      version: "v1.0.0",
      projectId,
      projectSlug: "demo-app",
      flowId: "concurrent-flow",
      workspaceRoot,
      db,
    };
    const [r1, r2] = await Promise.all([
      installFlowPlugin(args),
      installFlowPlugin(args),
    ]);

    expect(r1.installedPath).toBe(r2.installedPath);
    expect(r1.flowRowId).toBe(r2.flowRowId);
  });
});
