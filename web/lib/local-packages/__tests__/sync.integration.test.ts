import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
import { computeUpstreamDivergence } from "@/lib/local-packages/divergence";
import { forkPackageToLocal } from "@/lib/local-packages/fork";
import { gitCommitWorkingDir, gitHeadSha } from "@/lib/local-packages/git";
import {
  acquireLock,
  acquireWorkingDirLock,
} from "@/lib/local-packages/lock";
import {
  getLocalPackage,
  writeWorkingDirFile,
} from "@/lib/local-packages/service";
import {
  abortSync,
  resolveSync,
  syncFromUpstream,
} from "@/lib/local-packages/sync";
import { installPackageRevision } from "@/lib/packages/attach";

// ADR-132 §d (T20): the sync operation over REAL PG + git working dirs.
// The upstream is a local directory source (digest-as-version): two installs
// of the SAME name + sourceUrl with different bytes play v1 (lineage base)
// and v2 (sync target).

const schema = schemaModule as unknown as Record<string, any>;

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase<typeof schemaModule>;
let homeDir: string;
let hostDir: string;
let userId: string;
let installV1: { id: string; versionLabel: string };
let installV2: { id: string; versionLabel: string };
let foreignInstallId: string;

const FLOW_A = (body: string): string =>
  [
    "schemaVersion: 1",
    "name: flow-a",
    "compat:",
    "  engine_min: 1.1.0",
    "nodes:",
    "  - id: implement",
    "    type: ai_coding",
    "    action:",
    `      prompt: "${body}"`,
    "    transitions:",
    "      success: done",
    "",
  ].join("\n");

async function writeHost(rel: string, content: string): Promise<void> {
  await mkdir(join(hostDir, rel, ".."), { recursive: true });
  await writeFile(join(hostDir, rel), content);
}

async function freshFork(): Promise<{
  pkg: NonNullable<Awaited<ReturnType<typeof getLocalPackage>>>;
  sessionId: string;
}> {
  const { localPackageId } = await forkPackageToLocal({
    sourceInstallId: installV1.id,
    sourceRef: "syncpkg",
    createdBy: userId,
    forceNew: true,
    db,
  });
  const sessionId = `sess-${randomUUID().slice(0, 8)}`;
  const lock = await acquireLock(localPackageId, userId, sessionId, db);

  expect(lock.heldByMe).toBe(true);
  const pkg = await getLocalPackage(localPackageId, db);

  return { pkg: pkg!, sessionId };
}

async function reload(id: string) {
  return (await getLocalPackage(id, db))!;
}

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("sync_test")
    .withUsername("test")
    .withPassword("test")
    .start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool, { schema: schemaModule });
  await migrate(db, { migrationsFolder: "./lib/db/migrations" });

  homeDir = await mkdtemp(join(tmpdir(), "sync-home-"));
  process.env.HOME = homeDir;
  process.env.DB_URL = container.getConnectionUri();

  userId = randomUUID();
  await db.insert(schema.users).values({
    id: userId,
    email: `u-${userId}@x.test`,
    name: "Sync Author",
  });

  // v1 bytes → lineage base install.
  hostDir = await mkdtemp(join(tmpdir(), "sync-upstream-"));
  await writeHost(
    "maister-package.yaml",
    "schemaVersion: 1\nname: syncpkg\nflows:\n  - { id: flow-a, path: flows/flow-a }\ncapabilities: []\n",
  );
  await writeHost("flows/flow-a/flow.yaml", FLOW_A("v1"));
  await writeHost("docs/README.md", "upstream readme v1\n");
  installV1 = await installPackageRevision({
    source: hostDir,
    version: "local",
    trustStatus: "trusted_by_policy",
    db,
  });

  // v2 bytes → the sync target (flow changed + a new file).
  await writeHost("flows/flow-a/flow.yaml", FLOW_A("v2"));
  await writeHost("docs/CHANGELOG.md", "v2 changes\n");
  installV2 = await installPackageRevision({
    source: hostDir,
    version: "local",
    trustStatus: "trusted_by_policy",
    db,
  });

  // A DIFFERENT package entirely — the wrong-target refusal case.
  const foreignDir = await mkdtemp(join(tmpdir(), "sync-foreign-"));

  await writeFile(
    join(foreignDir, "maister-package.yaml"),
    "schemaVersion: 1\nname: otherpkg\nflows:\n  - { id: flow-o, path: flows/flow-o }\ncapabilities: []\n",
  );
  await mkdir(join(foreignDir, "flows/flow-o"), { recursive: true });
  await writeFile(join(foreignDir, "flows/flow-o/flow.yaml"), FLOW_A("o1"));
  foreignInstallId = (
    await installPackageRevision({
      source: foreignDir,
      version: "local",
      trustStatus: "trusted_by_policy",
      db,
    })
  ).id;
  await rm(foreignDir, { recursive: true, force: true });
}, 240_000);

afterAll(async () => {
  await closeDb();
  await pool?.end();
  await container?.stop();
  for (const dir of [homeDir, hostDir]) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe("upstream sync (integration)", () => {
  it("clean merge: ONE commit, lineage advanced, sync_state null, divergence-vs-new-base empty", async () => {
    const { pkg, sessionId } = await freshFork();
    const headBefore = await gitHeadSha(pkg.workingDir);

    const result = await syncFromUpstream({
      localPackageId: pkg.id,
      targetInstallId: installV2.id,
      sessionId,
      db,
    });

    expect(result.outcome).toBe("clean");
    expect(result.targetRef).toBe(installV2.versionLabel);

    const after = await reload(pkg.id);

    expect(after.sourceInstallId).toBe(installV2.id);
    expect(after.sourceRef).toBe(installV2.versionLabel);
    expect(after.syncState).toBeNull();

    // Exactly one commit; merged bytes landed.
    const headAfter = await gitHeadSha(pkg.workingDir);

    expect(headAfter).not.toBe(headBefore);
    expect(
      await readFile(join(pkg.workingDir, "flows/flow-a/flow.yaml"), "utf8"),
    ).toBe(FLOW_A("v2"));
    expect(
      await readFile(join(pkg.workingDir, "docs/CHANGELOG.md"), "utf8"),
    ).toBe("v2 changes\n");

    // T17 joins: divergence now compares against the NEW base — empty.
    const divergence = await computeUpstreamDivergence({
      localPackageId: pkg.id,
      db,
    });

    expect(divergence.base.installId).toBe(installV2.id);
    expect(divergence.changedCount).toBe(0);

    // Re-sync idempotency: same target again → clean no-op, NO second commit.
    const again = await syncFromUpstream({
      localPackageId: pkg.id,
      targetInstallId: installV2.id,
      sessionId,
      db,
    });

    expect(again.outcome).toBe("clean");
    expect(await gitHeadSha(pkg.workingDir)).toBe(headAfter);
  });

  it("conflict: files stamped + markers written; resolve commits + advances in one step", async () => {
    const { pkg, sessionId } = await freshFork();

    // Fork edits flow-a (committed) — v2 also changed it → conflict.
    await writeWorkingDirFile(pkg, "flows/flow-a/flow.yaml", FLOW_A("fork"));
    await gitCommitWorkingDir(pkg.workingDir, "fork edit");

    const result = await syncFromUpstream({
      localPackageId: pkg.id,
      targetInstallId: installV2.id,
      sessionId,
      db,
    });

    expect(result.outcome).toBe("conflicted");
    expect(result.conflictedFiles).toEqual(["flows/flow-a/flow.yaml"]);

    const pendingPkg = await reload(pkg.id);

    expect(pendingPkg.syncState).toMatchObject({
      targetInstallId: installV2.id,
      conflictedFiles: ["flows/flow-a/flow.yaml"],
    });
    const conflicted = await readFile(
      join(pkg.workingDir, "flows/flow-a/flow.yaml"),
      "utf8",
    );

    expect(conflicted).toContain("<<<<<<<");
    expect(conflicted).toContain(`>>>>>>> upstream ${installV2.versionLabel}`);
    // Lineage NOT advanced while conflicted.
    expect(pendingPkg.sourceInstallId).toBe(installV1.id);

    // A resolve while markers remain refuses, naming the file.
    await expect(
      resolveSync({ localPackageId: pkg.id, sessionId, db }),
    ).rejects.toSatisfy(
      (err: unknown) =>
        isMaisterError(err) &&
        err.code === "PRECONDITION" &&
        err.message.includes("flows/flow-a/flow.yaml"),
    );

    // Hand-resolve, then complete with a commit message.
    await writeWorkingDirFile(
      pkg,
      "flows/flow-a/flow.yaml",
      FLOW_A("fork+v2 merged"),
    );
    const resolved = await resolveSync({
      localPackageId: pkg.id,
      sessionId,
      commitMessage: "merge upstream v2 into fork",
      db,
    });

    expect(resolved.outcome).toBe("completed");

    const after = await reload(pkg.id);

    expect(after.sourceInstallId).toBe(installV2.id);
    expect(after.syncState).toBeNull();
    // Tree committed clean.
    expect(
      (
        await syncFromUpstream({
          localPackageId: pkg.id,
          targetInstallId: installV2.id,
          sessionId,
          db,
        })
      ).outcome,
    ).toBe("clean");

    // Idempotent resolve retry after completion → no-op completed.
    const retry = await resolveSync({ localPackageId: pkg.id, sessionId, db });

    expect(retry.outcome).toBe("completed");
    expect(retry.targetInstallId).toBe(installV2.id);
  });

  it("abort: tree restored byte-identical to pre-sync HEAD, state cleared, lineage unchanged", async () => {
    const { pkg, sessionId } = await freshFork();

    await writeWorkingDirFile(pkg, "flows/flow-a/flow.yaml", FLOW_A("fork"));
    await gitCommitWorkingDir(pkg.workingDir, "fork edit");
    const headBefore = await gitHeadSha(pkg.workingDir);

    const result = await syncFromUpstream({
      localPackageId: pkg.id,
      targetInstallId: installV2.id,
      sessionId,
      db,
    });

    expect(result.outcome).toBe("conflicted");

    await abortSync({ localPackageId: pkg.id, sessionId, db });

    const after = await reload(pkg.id);

    expect(after.syncState).toBeNull();
    expect(after.sourceInstallId).toBe(installV1.id);
    expect(await gitHeadSha(pkg.workingDir)).toBe(headBefore);
    expect(
      await readFile(join(pkg.workingDir, "flows/flow-a/flow.yaml"), "utf8"),
    ).toBe(FLOW_A("fork"));
    // The v2-added file the merge brought in is gone again.
    await expect(
      readFile(join(pkg.workingDir, "docs/CHANGELOG.md"), "utf8"),
    ).rejects.toThrow();

    // ADR-132: a second abort has nothing pending → idempotent no-op success
    // (mirrors resolveSync's no-pending branch), NOT a 409.
    await expect(
      abortSync({ localPackageId: pkg.id, sessionId, db }),
    ).resolves.toBeUndefined();

    const afterSecond = await getLocalPackage(pkg.id, db);

    expect(afterSecond!.syncState).toBeNull();
  });

  it("C3: sync refuses while another working-dir op holds the per-package mutex", async () => {
    const { pkg, sessionId } = await freshFork();

    // Simulate an in-flight publish/sync/abort holding the working-dir mutex.
    // The editor lock the fork already holds is NOT a mutex (same session
    // passes twice), so without this the two ops would run concurrent merges.
    await acquireWorkingDirLock(pkg.id, db);

    await expect(
      syncFromUpstream({
        localPackageId: pkg.id,
        targetInstallId: installV2.id,
        sessionId,
        db,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    // The refused sync must not have stamped intent or touched the tree.
    const after = await getLocalPackage(pkg.id, db);

    expect(after!.syncState).toBeNull();
  });

  it("precondition matrix: dirty tree · wrong target · foreign pending target · no lock", async () => {
    const { pkg, sessionId } = await freshFork();

    // Dirty tree refusal (uncommitted edit).
    await writeWorkingDirFile(pkg, "docs/README.md", "dirty\n");
    await expect(
      syncFromUpstream({
        localPackageId: pkg.id,
        targetInstallId: installV2.id,
        sessionId,
        db,
      }),
    ).rejects.toSatisfy(
      (err: unknown) => isMaisterError(err) && err.code === "PRECONDITION",
    );
    await gitCommitWorkingDir(pkg.workingDir, "make clean");

    // Wrong target: a different package's install.
    await expect(
      syncFromUpstream({
        localPackageId: pkg.id,
        targetInstallId: foreignInstallId,
        sessionId,
        db,
      }),
    ).rejects.toSatisfy(
      (err: unknown) => isMaisterError(err) && err.code === "CONFLICT",
    );

    // Pending sync towards X refuses a DIFFERENT-target sync.
    await db
      .update(schemaModule.localPackages)
      .set({
        syncState: {
          targetInstallId: installV2.id,
          targetRef: installV2.versionLabel,
          conflictedFiles: [],
          startedAt: new Date().toISOString(),
        },
      })
      .where(eq(schemaModule.localPackages.id, pkg.id));
    await expect(
      syncFromUpstream({
        localPackageId: pkg.id,
        targetInstallId: installV1.id,
        sessionId,
        db,
      }),
    ).rejects.toSatisfy(
      (err: unknown) =>
        isMaisterError(err) &&
        err.code === "CONFLICT" &&
        err.message.includes("sync in progress"),
    );

    // No lock → refusal (another session).
    await expect(
      syncFromUpstream({
        localPackageId: pkg.id,
        targetInstallId: installV2.id,
        sessionId: "not-the-holder",
        db,
      }),
    ).rejects.toSatisfy((err: unknown) => isMaisterError(err));
  });

  it("crash windows: window-1 Resume completes; window-2 same-target sync refuses but resolve completes", async () => {
    // Window 1: durable intent, merge never ran (clean tree).
    const w1 = await freshFork();

    await db
      .update(schemaModule.localPackages)
      .set({
        syncState: {
          targetInstallId: installV2.id,
          targetRef: installV2.versionLabel,
          conflictedFiles: [],
          startedAt: new Date().toISOString(),
        },
      })
      .where(eq(schemaModule.localPackages.id, w1.pkg.id));

    // Resolve on window-1 state: nothing to resolve → PRECONDITION "resume".
    await expect(
      resolveSync({ localPackageId: w1.pkg.id, sessionId: w1.sessionId, db }),
    ).rejects.toSatisfy(
      (err: unknown) =>
        isMaisterError(err) &&
        err.code === "PRECONDITION" &&
        err.message.includes("resume"),
    );

    // Resume: the same-target re-POST completes the sync.
    const resumed = await syncFromUpstream({
      localPackageId: w1.pkg.id,
      targetInstallId: installV2.id,
      sessionId: w1.sessionId,
      db,
    });

    expect(resumed.outcome).toBe("clean");
    expect((await reload(w1.pkg.id)).sourceInstallId).toBe(installV2.id);

    // Window 2: intent + merged-but-uncommitted content on disk.
    const w2 = await freshFork();

    await db
      .update(schemaModule.localPackages)
      .set({
        syncState: {
          targetInstallId: installV2.id,
          targetRef: installV2.versionLabel,
          conflictedFiles: [],
          startedAt: new Date().toISOString(),
        },
      })
      .where(eq(schemaModule.localPackages.id, w2.pkg.id));
    await writeWorkingDirFile(w2.pkg, "flows/flow-a/flow.yaml", FLOW_A("v2"));
    await writeWorkingDirFile(w2.pkg, "docs/CHANGELOG.md", "v2 changes\n");

    // Same-target /sync in window 2 must NOT re-merge over dirty content.
    await expect(
      syncFromUpstream({
        localPackageId: w2.pkg.id,
        targetInstallId: installV2.id,
        sessionId: w2.sessionId,
        db,
      }),
    ).rejects.toSatisfy(
      (err: unknown) =>
        isMaisterError(err) &&
        err.code === "CONFLICT" &&
        err.message.includes("resolve or abort"),
    );

    // Resolve completes window 2: commits the merged tree + advances.
    const resolved = await resolveSync({
      localPackageId: w2.pkg.id,
      sessionId: w2.sessionId,
      db,
    });

    expect(resolved.outcome).toBe("completed");
    const after = await reload(w2.pkg.id);

    expect(after.sourceInstallId).toBe(installV2.id);
    expect(after.syncState).toBeNull();
  });
});
