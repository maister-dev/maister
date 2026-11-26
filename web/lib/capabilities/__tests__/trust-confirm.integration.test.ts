/**
 * T2.5 — confirmCapabilityTrust: R-2PC retry-safe trust confirmation (M14).
 *
 * The service behind POST /api/projects/[slug]/capabilities/[refId]/trust.
 *  - untrusted + setup.sh pending → confirm writes trusted, runs setup → done;
 *    a re-confirm after done → CONFLICT (409, nothing to do)
 *  - setup.sh fails → FLOW_INSTALL (502); row stays trusted+failed; a re-confirm
 *    re-runs setup (no spurious 409 — setupStatus is the idempotency marker)
 *  - no setup.sh (not_required) → CONFLICT (nothing to gate)
 *  - unknown ref → PRECONDITION
 */
import { randomUUID } from "node:crypto";
import { execFile as execFileCb } from "node:child_process";
import { chmod, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  confirmCapabilityTrust,
  installCapabilityRevision,
} from "@/lib/capabilities/import";
import * as schemaModule from "@/lib/db/schema";
import { isMaisterError } from "@/lib/errors";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

const schema = schemaModule as unknown as Record<string, any>;
const execFile = promisify(execFileCb);

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

async function buildFixture(
  parentDir: string,
  name: string,
  setup: "ok" | "fail" | "none",
): Promise<string> {
  const repoDir = join(parentDir, name);

  await mkdir(repoDir, { recursive: true });
  await gitRun(repoDir, ["init", "-q"]);
  await gitRun(repoDir, ["checkout", "-q", "-b", "main"]);
  await writeFile(join(repoDir, "README.md"), `# ${name}\n`);

  if (setup !== "none") {
    await writeFile(
      join(repoDir, "setup.sh"),
      `#!/usr/bin/env bash\necho "ran" > ./sentinel.txt\n${setup === "ok" ? "exit 0" : `test -f "${join(parentDir, "service-ready")}"`}\n`,
    );
    await chmod(join(repoDir, "setup.sh"), 0o755);
  }

  await gitRun(repoDir, ["add", "."]);
  await gitRun(repoDir, ["commit", "-q", "-m", "init"]);
  await gitRun(repoDir, ["tag", "v1.0.0"]);

  return repoDir;
}

let testDatabase: StartedPostgresTestDb;
let db: any;
let homeDir: string;
let fixturesDir: string;
let originalHome: string | undefined;
let projectId: string;
let repoOk: string;
let repoFail: string;
let repoNone: string;

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "cap_trust_test",
  });
  db = testDatabase.db;

  homeDir = join(tmpdir(), `cap-trust-home-${randomUUID()}`);
  fixturesDir = join(tmpdir(), `cap-trust-fixtures-${randomUUID()}`);
  await mkdir(homeDir, { recursive: true });
  await mkdir(fixturesDir, { recursive: true });

  originalHome = process.env.HOME;
  process.env.HOME = homeDir;

  repoOk = await buildFixture(fixturesDir, "cap-ok", "ok");
  repoFail = await buildFixture(fixturesDir, "cap-fail", "fail");
  repoNone = await buildFixture(fixturesDir, "cap-none", "none");

  projectId = randomUUID();
  await db.insert(schema.projects).values({
    taskKey: `T${crypto.randomUUID().slice(0, 8)}`.toUpperCase(),
    id: projectId,
    slug: "cap-trust-proj",
    name: "Cap Trust",
    repoPath: fixturesDir,
    maisterYamlPath: join(fixturesDir, "maister.yaml"),
  });
}, 180_000);

afterAll(async () => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;

  await testDatabase?.stop();
  await rm(homeDir, { recursive: true, force: true });
  await rm(fixturesDir, { recursive: true, force: true });
});

// Install then force untrusted+pending to model a third-party source awaiting
// an explicit operator confirmation.
async function installUntrusted(
  source: string,
  refId: string,
): Promise<{ importRowId: string; installedPath: string }> {
  const installed = await installCapabilityRevision({
    source,
    version: "v1.0.0",
    capabilityRefId: refId,
    projectId,
    db,
  });

  if (installed.setupStatus === "pending") {
    await db
      .update(schema.capabilityImports)
      .set({ trustStatus: "untrusted" })
      .where(eq(schema.capabilityImports.id, installed.importRowId));
  }

  return installed;
}

describe("confirmCapabilityTrust", () => {
  it("untrusted+pending → confirm writes trusted, runs setup → done; re-confirm → CONFLICT", async () => {
    const installed = await installUntrusted(repoOk, "trust-ok");

    const result = await confirmCapabilityTrust({
      projectId,
      capabilityRefId: "trust-ok",
      db,
    });

    expect(result).toMatchObject({
      trustStatus: "trusted",
      setupStatus: "done",
    });

    const sentinel = join(installed.installedPath, "sentinel.txt");

    expect((await stat(sentinel)).isFile()).toBe(true);

    const rows = await db
      .select({
        trustStatus: schema.capabilityImports.trustStatus,
        setupStatus: schema.capabilityImports.setupStatus,
      })
      .from(schema.capabilityImports)
      .where(eq(schema.capabilityImports.id, installed.importRowId));

    expect(rows[0]).toMatchObject({
      trustStatus: "trusted",
      setupStatus: "done",
    });

    // Re-confirm after done → nothing to do → CONFLICT (409).
    let caught: unknown;

    try {
      await confirmCapabilityTrust({
        projectId,
        capabilityRefId: "trust-ok",
        db,
      });
    } catch (e) {
      caught = e;
    }

    expect(isMaisterError(caught)).toBe(true);
    expect((caught as { code: string }).code).toBe("CONFLICT");
  });

  it("setup.sh failure → FLOW_INSTALL, row stays trusted+failed, re-confirm re-runs (no spurious 409)", async () => {
    const installed = await installUntrusted(repoFail, "trust-fail");

    let first: unknown;

    try {
      await confirmCapabilityTrust({
        projectId,
        capabilityRefId: "trust-fail",
        db,
      });
    } catch (e) {
      first = e;
    }

    expect(isMaisterError(first)).toBe(true);
    expect((first as { code: string }).code).toBe("FLOW_INSTALL");

    const rows = await db
      .select({
        trustStatus: schema.capabilityImports.trustStatus,
        setupStatus: schema.capabilityImports.setupStatus,
      })
      .from(schema.capabilityImports)
      .where(eq(schema.capabilityImports.id, installed.importRowId));

    expect(rows[0]).toMatchObject({
      trustStatus: "trusted",
      setupStatus: "failed",
    });

    // The operator fixes the failed setup. A successful retry restores both
    // the native installation and the selection used by launch admission.
    await writeFile(join(fixturesDir, "service-ready"), "ready");
    await expect(
      confirmCapabilityTrust({ projectId, capabilityRefId: "trust-fail", db }),
    ).resolves.toMatchObject({ setupStatus: "done" });
    expect(
      (
        await db
          .select()
          .from(schema.capabilityImports)
          .where(eq(schema.capabilityImports.id, installed.importRowId))
      )[0],
    ).toMatchObject({ packageStatus: "Installed", setupStatus: "done" });
    expect(
      (
        await testDatabase.pool.query(
          "SELECT selectable,disabled_at FROM capability_records WHERE project_id=$1 AND capability_ref_id='trust-fail'",
          [projectId],
        )
      ).rows,
    ).toEqual([{ selectable: true, disabled_at: null }]);
  });

  it("no setup.sh (not_required) → CONFLICT (nothing to gate)", async () => {
    await installCapabilityRevision({
      source: repoNone,
      version: "v1.0.0",
      capabilityRefId: "trust-none",
      projectId,
      db,
    });

    let caught: unknown;

    try {
      await confirmCapabilityTrust({
        projectId,
        capabilityRefId: "trust-none",
        db,
      });
    } catch (e) {
      caught = e;
    }

    expect(isMaisterError(caught)).toBe(true);
    expect((caught as { code: string }).code).toBe("CONFLICT");
  });

  it("grants explicit trust to a bundle without setup before making it selectable", async () => {
    const installed = await installCapabilityRevision({
      source: repoNone,
      version: "v1.0.0",
      capabilityRefId: "explicit-none",
      projectId,
      db,
      trustStatusOverride: "untrusted",
    });
    expect(installed.trustStatus).toBe("untrusted");
    await expect(
      confirmCapabilityTrust({
        projectId,
        capabilityRefId: "explicit-none",
        db,
      }),
    ).resolves.toMatchObject({
      trustStatus: "trusted",
      setupStatus: "not_required",
    });
  });

  it("keeps a package member behind the original package trust decision", async () => {
    const row = await installUntrusted(repoOk, "untrusted-package-member");
    await db.insert(schema.packageInstalls).values({
      id: "untrusted-package",
      sourceUrl: "https://example.invalid/remote.git",
      name: "origin",
      versionLabel: "v1",
      resolvedRevision: "revision",
      manifest: {},
      manifestDigest: "digest",
      installedPath: fixturesDir,
      packageStatus: "Installed",
      trustStatus: "untrusted",
    });
    await db
      .update(schema.capabilityImports)
      .set({ packageInstallId: "untrusted-package" })
      .where(eq(schema.capabilityImports.id, row.importRowId));
    await expect(
      confirmCapabilityTrust({
        projectId,
        capabilityRefId: "untrusted-package-member",
        db,
      }),
    ).rejects.toMatchObject({
      code: "PRECONDITION",
      details: { reason: "package_trust_required" },
    });
    expect(
      (
        await db
          .select()
          .from(schema.capabilityImports)
          .where(eq(schema.capabilityImports.id, row.importRowId))
      )[0],
    ).toMatchObject({ trustStatus: "untrusted", setupStatus: "pending" });
  });

  it("confirms the effective standalone revision when newer material exists", async () => {
    const ref = "current-import";
    const first = await installCapabilityRevision({
      source: repoNone,
      version: "v1.0.0",
      capabilityRefId: ref,
      projectId,
      db,
      trustStatusOverride: "untrusted",
    });
    await db
      .insert(schema.projectDependencyDeclarations)
      .values({
        projectId,
        kind: "capability_import",
        logicalId: ref,
        ordinal: 0,
        desired: { source: repoNone, version: "v1.0.0" },
        effectiveGeneration: 1,
        effectiveRevision: first.resolvedRevision,
      });
    const newer = await installUntrusted(repoOk, ref);
    await expect(
      confirmCapabilityTrust({ projectId, capabilityRefId: ref, db }),
    ).resolves.toMatchObject({ setupStatus: "not_required" });
    expect(
      (
        await db
          .select()
          .from(schema.capabilityImports)
          .where(eq(schema.capabilityImports.id, newer.importRowId))
      )[0],
    ).toMatchObject({ trustStatus: "untrusted", setupStatus: "pending" });
  });

  it("unknown ref → PRECONDITION", async () => {
    let caught: unknown;

    try {
      await confirmCapabilityTrust({
        projectId,
        capabilityRefId: "does-not-exist",
        db,
      });
    } catch (e) {
      caught = e;
    }

    expect(isMaisterError(caught)).toBe(true);
    expect((caught as { code: string }).code).toBe("PRECONDITION");
  });
});
