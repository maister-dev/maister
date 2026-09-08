import type { LocalPackage, LocalPackageCreationState } from "@/lib/db/schema";

import { createHash, randomUUID } from "node:crypto";
import {
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { eq } from "drizzle-orm";
import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { stringify as stringifyYaml } from "yaml";

import * as schemaModule from "@/lib/db/schema";
import {
  readCreationJournal,
  writeCreationJournal,
} from "@/lib/local-packages/create-flow-operation";
import { gitCommitWorkingDir } from "@/lib/local-packages/git";
import {
  acquireLock,
  assertHoldsLock,
  readLockState,
  releaseLock,
} from "@/lib/local-packages/lock";
import {
  appendManifestFlow,
  parsePackageManifest,
  serializeScaffoldManifest,
} from "@/lib/local-packages/manifest";
import {
  localPackageCreationStagingDir,
  localPackageWorkingDir,
} from "@/lib/local-packages/paths";
import { buildStarterFlowManifest } from "@/lib/local-packages/create-flow-contract";
import {
  assertPackageCuttable,
  addFlowToLocalPackage,
  commitWorkingDir,
  createLocalPackageWithFlow,
  createLocalPackage,
  deleteLocalPackage,
  ensureDefaultLocalPackage,
  getDefaultLocalPackage,
  getLocalPackage,
  listAllLocalPackages,
  listFiles,
  listLocalPackages,
  readFileContent,
  recoverLocalPackageCreation,
  insertLocalPackageRow,
  setLocalPackageStatus,
  writeWorkingDirFile,
} from "@/lib/local-packages/service";
import { cutLocalPackageVersion } from "@/lib/local-packages/versions";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

// FIXME(any): dual drizzle peer-dep variants (matches attach.integration.test.ts).
const schema = schemaModule as unknown as Record<string, any>;

let testDatabase: StartedPostgresTestDb;
let db: NodePgDatabase<typeof schemaModule>;
let homeDir: string | undefined;
let originalHome: string | undefined;
let userId: string;
let otherUserId: string;

const SECOND_FLOW = {
  id: "two",
  metadata: {
    title: "Two",
    summary: "Second.",
    route_when: "Second route.",
  },
};

function textHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function prepareInterruptedAdditionalFlow(name: string): Promise<{
  pkg: LocalPackage;
  state: LocalPackageCreationState;
  originalManifest: string;
  finalManifest: string;
  finalFlow: string;
}> {
  const { package: pkg } = await createLocalPackageWithFlow({
    name,
    createdBy: userId,
    flow: {
      id: "one",
      metadata: {
        title: "One",
        summary: "First.",
        route_when: "First route.",
      },
    },
    db,
  });
  const manifestPath = join(pkg.workingDir, "maister-package.yaml");
  const flowPath = join(pkg.workingDir, "flows", SECOND_FLOW.id, "flow.yaml");
  const originalManifest = await readFile(manifestPath, "utf8");

  await acquireLock(pkg.id, userId, "recovery-session", db);
  await addFlowToLocalPackage({
    packageId: pkg.id,
    sessionId: "recovery-session",
    flow: SECOND_FLOW,
    db,
  });

  const [finalManifest, finalFlow] = await Promise.all([
    readFile(manifestPath, "utf8"),
    readFile(flowPath, "utf8"),
  ]);
  const state: LocalPackageCreationState = {
    operationId: randomUUID(),
    kind: "add_flow",
    phase: "claimed",
    flowId: SECOND_FLOW.id,
    manifestHash: textHash(finalManifest),
    flowHash: textHash(finalFlow),
    originalManifestHash: textHash(originalManifest),
    startedAt: new Date().toISOString(),
  };

  await Promise.all([
    writeFile(manifestPath, originalManifest),
    rm(join(pkg.workingDir, "flows", SECOND_FLOW.id), {
      recursive: true,
      force: true,
    }),
    writeCreationJournal(pkg.workingDir, state.operationId, {
      flow: SECOND_FLOW,
      originalManifest,
    }),
  ]);
  await db
    .update(schema.localPackages)
    .set({ creationState: state })
    .where(eq(schema.localPackages.id, pkg.id));

  return { pkg, state, originalManifest, finalManifest, finalFlow };
}

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "localpkg_test",
  });
  db = testDatabase.db;

  // Working dirs resolve under ~/.maister/local — point HOME at a temp dir.
  homeDir = await mkdtemp(join(tmpdir(), "lp-int-home-"));
  originalHome = process.env.HOME;
  process.env.HOME = homeDir;

  userId = randomUUID();
  otherUserId = randomUUID();
  await db.insert(schema.users).values([
    { id: userId, email: `u-${userId}@x.test`, name: "Local Author" },
    {
      id: otherUserId,
      email: `u-${otherUserId}@x.test`,
      name: "Other Author",
    },
  ]);
}, 180_000);

afterAll(async () => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  await testDatabase?.stop();
  if (homeDir !== undefined) {
    await rm(homeDir, { recursive: true, force: true });
  }
});

describe("local-packages substrate (integration)", () => {
  let pkgId: string;
  let workingDir: string;

  it("creates a local package: row + git-backed scaffold", async () => {
    const pkg = await createLocalPackage({
      name: "My Flow Pack",
      createdBy: userId,
      db,
    });

    pkgId = pkg.id;
    workingDir = pkg.workingDir;
    expect(pkg.slug).toBe("my-flow-pack");
    expect(pkg.status).toBe("active");
    expect(pkg.branchName).toBe("main");
    expect(pkg.workingDir).toContain(join(".maister", "local"));

    const files = await listFiles(pkg);

    expect(files.some((f) => f.path === "maister-package.yaml")).toBe(true);
    expect((await stat(join(pkg.workingDir, ".git"))).isDirectory()).toBe(true);
  });

  it("creates a package and its first valid Flow in one git-backed operation", async () => {
    const { package: pkg } = await createLocalPackageWithFlow({
      name: "Canonical package",
      createdBy: userId,
      flow: {
        id: "first-flow",
        metadata: {
          title: "First Flow",
          summary: "A launchable initial Flow.",
          route_when: "A user wants to start a real Flow.",
          labels: ["starter"],
        },
      },
      db,
    });

    const manifest = await readFile(
      join(pkg.workingDir, "maister-package.yaml"),
      "utf8",
    );
    const flow = await readFile(
      join(pkg.workingDir, "flows", "first-flow", "flow.yaml"),
      "utf8",
    );

    expect(manifest).toContain("id: first-flow");
    expect(manifest).toContain("path: flows/first-flow");
    expect(flow).toContain("name: first-flow");
    expect(flow).toContain("title: First Flow");
    expect((await stat(join(pkg.workingDir, ".git"))).isDirectory()).toBe(true);
  });

  it("compensates a crash after the initial DB claim but before the private journal without touching a final package directory", async () => {
    const name = "Unjournaled initial creation";
    const slug = "unjournaled-initial-creation";
    const flow = {
      id: "first-flow",
      metadata: {
        title: "First Flow",
        summary: "Recover only from durable Flow data.",
        route_when: "A process died before the journal write.",
      },
    };
    const seedManifest = serializeScaffoldManifest(slug, name);
    const parsedManifest = parsePackageManifest(seedManifest);

    if (!parsedManifest.ok) throw new Error("test seed manifest must parse");

    const finalManifest = appendManifestFlow(parsedManifest.raw, {
      id: flow.id,
      path: `flows/${flow.id}`,
    });
    const finalFlow = stringifyYaml(buildStarterFlowManifest(flow));
    const state: LocalPackageCreationState = {
      operationId: randomUUID(),
      kind: "create_package_with_flow",
      phase: "claimed",
      flowId: flow.id,
      manifestHash: textHash(finalManifest),
      flowHash: textHash(finalFlow),
      startedAt: new Date().toISOString(),
    };
    const workingDir = localPackageWorkingDir(slug);
    const stagingDir = localPackageCreationStagingDir(
      workingDir,
      state.operationId,
    );
    const pkg = await insertLocalPackageRow(
      {
        name,
        slug,
        workingDir,
        status: "active",
        branchName: "main",
        createdBy: userId,
        creationState: state,
      },
      db,
    );

    const recovered = await recoverLocalPackageCreation(pkg.id, db);

    expect(recovered).toEqual({
      package: null,
      flowPath: null,
      recoveryStatus: "rolled_back",
    });
    await expect(stat(workingDir)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(stagingDir)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(getLocalPackage(pkg.id, db)).resolves.toBeNull();
  });

  it("preserves a pre-existing working-dir path when initial Flow creation fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "lp-create-failure-"));
    const name = "Filesystem Failure Package";
    const slug = "filesystem-failure-package";
    const blocker = join(root, slug);
    const previousRoot = process.env.MAISTER_LOCAL_PACKAGES_ROOT;

    // A file occupies the exact future working-dir path. Creation must fail and
    // remove its claimed row, but it must never remove a path it did not create.
    await writeFile(blocker, "block create");
    process.env.MAISTER_LOCAL_PACKAGES_ROOT = root;
    try {
      await expect(
        createLocalPackageWithFlow({
          name,
          createdBy: userId,
          flow: {
            id: "fails-cleanly",
            metadata: {
              title: "Fails cleanly",
              summary: "Exercise filesystem compensation.",
              route_when: "A filesystem write fails.",
            },
          },
          db,
        }),
      ).rejects.toBeTruthy();
    } finally {
      if (previousRoot === undefined)
        delete process.env.MAISTER_LOCAL_PACKAGES_ROOT;
      else process.env.MAISTER_LOCAL_PACKAGES_ROOT = previousRoot;
    }

    await expect(readFile(blocker, "utf8")).resolves.toBe("block create");
    expect(
      (await listAllLocalPackages(db)).some((pkg) => pkg.name === name),
    ).toBe(false);
    await rm(root, { recursive: true, force: true });
  });

  it("refuses an uncommitted cut inside the shared version service", async () => {
    const { package: pkg } = await createLocalPackageWithFlow({
      name: "Cut service gate",
      createdBy: userId,
      flow: {
        id: "cut-gate",
        metadata: {
          title: "Cut gate",
          summary: "A valid Flow before the dirty-tree cut check.",
          route_when: "A caller tries to cut uncommitted changes.",
        },
      },
      db,
    });

    await writeWorkingDirFile(pkg, "rules/draft.md", "uncommitted");

    await expect(cutLocalPackageVersion(pkg, { db })).rejects.toMatchObject({
      code: "PRECONDITION",
    });
  });

  it("adds another Flow to an editable package without replacing existing membership", async () => {
    const { package: pkg } = await createLocalPackageWithFlow({
      name: "Many flows",
      createdBy: userId,
      flow: {
        id: "one",
        metadata: {
          title: "One",
          summary: "First.",
          route_when: "First route.",
        },
      },
      db,
    });

    await acquireLock(pkg.id, userId, "add-flow-session", db);
    await addFlowToLocalPackage({
      packageId: pkg.id,
      sessionId: "add-flow-session",
      flow: {
        id: "two",
        metadata: {
          title: "Two",
          summary: "Second.",
          route_when: "Second route.",
        },
      },
      db,
    });

    const manifest = await readFile(
      join(pkg.workingDir, "maister-package.yaml"),
      "utf8",
    );

    expect(manifest).toContain("id: one");
    expect(manifest).toContain("id: two");
    await expect(
      readFile(join(pkg.workingDir, "flows", "two", "flow.yaml"), "utf8"),
    ).resolves.toContain("name: two");

    const beforeDuplicate = await readFile(
      join(pkg.workingDir, "maister-package.yaml"),
      "utf8",
    );

    await expect(
      addFlowToLocalPackage({
        packageId: pkg.id,
        sessionId: "add-flow-session",
        flow: {
          id: "two",
          metadata: {
            title: "Duplicate",
            summary: "Must not write.",
            route_when: "Never.",
          },
        },
        db,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(
      readFile(join(pkg.workingDir, "maister-package.yaml"), "utf8"),
    ).resolves.toBe(beforeDuplicate);
  });

  it("rejects adding a Flow without the package editor lock before touching files", async () => {
    const { package: pkg } = await createLocalPackageWithFlow({
      name: "Flow lock guard",
      createdBy: userId,
      flow: {
        id: "one",
        metadata: {
          title: "One",
          summary: "First.",
          route_when: "First route.",
        },
      },
      db,
    });
    const manifestPath = join(pkg.workingDir, "maister-package.yaml");
    const before = await readFile(manifestPath, "utf8");

    await expect(
      addFlowToLocalPackage({
        packageId: pkg.id,
        sessionId: "missing-editor-lock",
        flow: SECOND_FLOW,
        db,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    await expect(readFile(manifestPath, "utf8")).resolves.toBe(before);
    await expect(
      readFile(
        join(pkg.workingDir, "flows", SECOND_FLOW.id, "flow.yaml"),
        "utf8",
      ),
    ).rejects.toBeTruthy();
  });

  it("recovers an interrupted additional Flow only from its journaled baseline and hashes", async () => {
    const { pkg, state, finalManifest, finalFlow } =
      await prepareInterruptedAdditionalFlow("Recover additional Flow");

    const recovered = await recoverLocalPackageCreation(pkg.id, db);

    expect(recovered).toMatchObject({
      flowPath: "flows/two/flow.yaml",
      recoveryStatus: "ready",
    });
    await expect(
      readFile(join(pkg.workingDir, "maister-package.yaml"), "utf8"),
    ).resolves.toBe(finalManifest);
    await expect(
      readFile(
        join(pkg.workingDir, "flows", SECOND_FLOW.id, "flow.yaml"),
        "utf8",
      ),
    ).resolves.toBe(finalFlow);
    expect((await getLocalPackage(pkg.id, db))?.creationState).toBeNull();
    await expect(
      readCreationJournal(pkg.workingDir, state.operationId),
    ).resolves.toBeNull();
  });

  it("marks a diverged interrupted additional Flow for recovery without overwriting it", async () => {
    const { pkg } = await prepareInterruptedAdditionalFlow(
      "Diverged additional Flow",
    );
    const manifestPath = join(pkg.workingDir, "maister-package.yaml");
    const divergentManifest = "schemaVersion: 1\nname: divergent\nflows: []\n";

    await writeFile(manifestPath, divergentManifest);

    await expect(recoverLocalPackageCreation(pkg.id, db)).rejects.toMatchObject(
      {
        code: "CONFLICT",
      },
    );
    await expect(readFile(manifestPath, "utf8")).resolves.toBe(
      divergentManifest,
    );
    expect((await getLocalPackage(pkg.id, db))?.creationState?.phase).toBe(
      "recovery_required",
    );
  });

  it("reads the scaffolded manifest with a content hash", async () => {
    const pkg = await getLocalPackage(pkgId, db);

    expect(pkg).not.toBeNull();
    const f = await readFileContent(pkg!, "maister-package.yaml");

    expect(f.kind).toBe("manifest");
    // F2.a: the manifest `name` is the slug-safe id; the display name lives in
    // metadata.title (a display name with spaces would violate capabilityRefIdSchema).
    expect(f.content).toContain("name: my-flow-pack");
    expect(f.content).toContain("title: My Flow Pack");
    expect(f.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("allocates a unique slug on name collision", async () => {
    const dup = await createLocalPackage({
      name: "My Flow Pack",
      createdBy: userId,
      db,
    });

    expect(dup.slug).toBe("my-flow-pack-2");
    await deleteLocalPackage(dup.id, db);
  });

  it("session lock: acquire, hold, same-user takeover, read-only for other users, lazy stale-takeover", async () => {
    const s1 = await acquireLock(pkgId, userId, "session-1", db);

    expect(s1.heldByMe).toBe(true);
    await expect(
      assertHoldsLock(pkgId, "session-1", db),
    ).resolves.toBeUndefined();

    // The same user can reopen the editor and reclaim their own stale tab lock.
    const s2 = await acquireLock(pkgId, userId, "session-2", db);

    expect(s2.held).toBe(true);
    expect(s2.heldByMe).toBe(true);
    await expect(assertHoldsLock(pkgId, "session-1", db)).rejects.toMatchObject(
      { code: "CONFLICT" },
    );
    await expect(
      assertHoldsLock(pkgId, "session-2", db),
    ).resolves.toBeUndefined();

    // Another user still cannot acquire a live lock.
    const other = await acquireLock(pkgId, otherUserId, "session-3", db);

    expect(other.held).toBe(true);
    expect(other.heldByMe).toBe(false);
    await expect(assertHoldsLock(pkgId, "session-3", db)).rejects.toMatchObject(
      { code: "CONFLICT" },
    );

    // expire session-2's lock, then another user takes over (lazy stale-takeover)
    await db
      .update(schema.localPackages)
      .set({ lockExpiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.localPackages.id, pkgId));
    expect(
      (await acquireLock(pkgId, otherUserId, "session-3", db)).heldByMe,
    ).toBe(true);

    await releaseLock(pkgId, "session-3", db);
    expect((await readLockState(pkgId, "session-1", db)).held).toBe(false);
  });

  it("archive hides the package from the active list but not the management list", async () => {
    await setLocalPackageStatus(pkgId, "archived", db);
    const active = await listLocalPackages(db);
    const all = await listAllLocalPackages(db);

    // Active-only readers (API list, attach) drop it; the /studio/local
    // management list (listAllLocalPackages) still shows it behind the toggle.
    expect(active.some((p) => p.id === pkgId)).toBe(false);
    expect(all.some((p) => p.id === pkgId)).toBe(true);
  });

  it("delete removes the row and the working dir", async () => {
    const pkg = await createLocalPackage({
      name: "Throwaway Pack",
      createdBy: userId,
      db,
    });

    await deleteLocalPackage(pkg.id, db);
    expect(await getLocalPackage(pkg.id, db)).toBeNull();
    await expect(stat(pkg.workingDir)).rejects.toBeTruthy();
    // the archived package's working dir is untouched by the active-list query
    expect((await stat(workingDir)).isDirectory()).toBe(true);
  });

  it("delete refuses a local package attached to a project", async () => {
    const projectId = randomUUID();

    await db.insert(schema.projects).values({
      taskKey: `D${randomUUID().slice(0, 8)}`.toUpperCase(),
      id: projectId,
      slug: `delete-guard-${projectId.slice(0, 8)}`,
      name: "Delete Guard",
      repoPath: join(homeDir!, `repo-delete-guard-${projectId.slice(0, 8)}`),
    });

    const attached = await ensureDefaultLocalPackage({
      projectId,
      projectName: "Delete Guard",
      createdBy: userId,
      db,
    });

    await expect(deleteLocalPackage(attached.id, db)).rejects.toMatchObject({
      code: "PRECONDITION",
    });
    expect(await getLocalPackage(attached.id, db)).not.toBeNull();
    expect((await stat(attached.workingDir)).isDirectory()).toBe(true);
  });

  it("delete refuses a local package with a live edit lock", async () => {
    const locked = await createLocalPackage({
      name: "Locked Pack",
      createdBy: userId,
      db,
    });

    await acquireLock(locked.id, userId, "delete-guard-session", db);

    await expect(deleteLocalPackage(locked.id, db)).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect(await getLocalPackage(locked.id, db)).not.toBeNull();
    expect((await stat(locked.workingDir)).isDirectory()).toBe(true);

    await releaseLock(locked.id, "delete-guard-session", db);
    await deleteLocalPackage(locked.id, db);
  });

  it("refuses archive and delete while a local-package assistant is still recoverable", async () => {
    const pkg = await createLocalPackage({
      name: "Assistant Guard Pack",
      createdBy: userId,
      db,
    });
    const runId = randomUUID();

    await db.insert(schema.runs).values({
      id: runId,
      runKind: "scratch",
      taskId: null,
      projectId: null,
      localPackageId: pkg.id,
      flowId: null,
      status: "Crashed",
      currentStepId: null,
      flowVersion: "scratch",
      flowRevision: "manual",
      flowRevisionId: null,
      createdByUserId: userId,
      startedAt: new Date(),
    });

    await expect(
      setLocalPackageStatus(pkg.id, "archived", db),
    ).rejects.toMatchObject({
      code: "CONFLICT",
    });
    await expect(deleteLocalPackage(pkg.id, db)).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect((await getLocalPackage(pkg.id, db))?.status).toBe("active");
    expect((await stat(pkg.workingDir)).isDirectory()).toBe(true);
  });

  it("two concurrent default creations keep the winner's repo (no shared-dir delete)", async () => {
    const projectId = randomUUID();

    await db.insert(schema.projects).values({
      taskKey: `T${randomUUID().slice(0, 8)}`.toUpperCase(),
      id: projectId,
      slug: `race-${projectId.slice(0, 8)}`,
      name: "Race Proj",
      repoPath: join(homeDir!, `repo-race-${projectId.slice(0, 8)}`),
    });

    expect(await getDefaultLocalPackage(projectId, db)).toBeNull();

    // Both racers create the project default concurrently. The fix: each derives
    // its OWN unique working dir, so the insert loser rolls back only its own
    // orphan — never the winner's adopted repo (the critical data-loss bug).
    const [a, b] = await Promise.all([
      ensureDefaultLocalPackage({
        projectId,
        projectName: "Race Proj",
        createdBy: userId,
        db,
      }),
      ensureDefaultLocalPackage({
        projectId,
        projectName: "Race Proj",
        createdBy: userId,
        db,
      }),
    ]);

    // Both resolve to the same winning row, and it is the project's sole default.
    expect(a.id).toBe(b.id);
    expect(a.isDefault).toBe(true);
    const rows = await db
      .select()
      .from(schema.localPackages)
      .where(eq(schema.localPackages.projectId, projectId));

    expect(rows.filter((r) => r.isDefault)).toHaveLength(1);

    // The surviving row's repo EXISTS — the loser did not delete a shared dir.
    expect((await stat(a.workingDir)).isDirectory()).toBe(true);
    expect((await stat(join(a.workingDir, ".git"))).isDirectory()).toBe(true);
  });

  it("two concurrent same-name creates never delete a winner's repo (F1, insert-first)", async () => {
    // Insert-first claims the unique slug in the DB BEFORE any fs work, so the
    // race loser fails at the constraint having touched nothing — it can never
    // delete the winner's working dir (the critical data-loss bug).
    const settled = await Promise.allSettled([
      createLocalPackage({ name: "Race Create Pack", createdBy: userId, db }),
      createLocalPackage({ name: "Race Create Pack", createdBy: userId, db }),
    ]);

    const created = settled
      .filter(
        (s): s is PromiseFulfilledResult<LocalPackage> =>
          s.status === "fulfilled",
      )
      .map((s) => s.value);

    // At least one wins; whether the other wins a distinct slug or loses the
    // unique-constraint race, NO created package's repo is ever deleted.
    expect(created.length).toBeGreaterThanOrEqual(1);
    for (const pkg of created) {
      expect((await stat(pkg.workingDir)).isDirectory()).toBe(true);
      expect((await stat(join(pkg.workingDir, ".git"))).isDirectory()).toBe(
        true,
      );
      const files = await listFiles(pkg);

      expect(files.some((f) => f.path === "maister-package.yaml")).toBe(true);
    }

    // Any loser failed cleanly with CONFLICT — never a raw 23505 → 500.
    for (const s of settled) {
      if (s.status === "rejected") {
        expect(s.reason).toMatchObject({ code: "CONFLICT" });
      }
    }
  });

  it("cut gate (F3): clean+valid is cuttable; dirty WIP and invalid committed baseline are not", async () => {
    const pkg = await createLocalPackage({
      name: "Cut Gate Pack",
      createdBy: userId,
      db,
    });

    // Fresh scaffold = clean + valid (empty flows OK, slug-safe name) → cuttable.
    await expect(assertPackageCuttable(pkg)).resolves.toBeUndefined();

    // An uncommitted edit makes the tree dirty → NOT cuttable.
    await writeWorkingDirFile(
      pkg,
      "skills/demo/SKILL.md",
      "---\nname: demo\ndescription: a demo skill\n---\nbody\n",
    );
    await expect(assertPackageCuttable(pkg)).rejects.toMatchObject({
      code: "PRECONDITION",
    });

    // Commit it (valid) → clean again → cuttable.
    await commitWorkingDir(pkg, "add demo skill");
    await expect(assertPackageCuttable(pkg)).resolves.toBeUndefined();

    // Force an invalid manifest committed via the RAW git path (bypasses the
    // commit gate, simulating a legacy invalid baseline): clean tree, but full
    // validation rejects the unsafe name → NOT cuttable.
    await writeWorkingDirFile(
      pkg,
      "maister-package.yaml",
      "schemaVersion: 1\nname: Bad Name!\nflows: []\n",
    );
    await gitCommitWorkingDir(pkg.workingDir, "force invalid baseline");
    await expect(assertPackageCuttable(pkg)).rejects.toMatchObject({
      code: "PRECONDITION",
    });
  });

  it("commit gate rejects renaming away a schema still referenced by an unchanged flow", async () => {
    const pkg = await createLocalPackage({
      name: "Schema Rename Guard Pack",
      createdBy: userId,
      db,
    });
    const flowPath = "flows/review/flow.yaml";
    const schemaPath = "schemas/review.json";

    await writeWorkingDirFile(
      pkg,
      flowPath,
      "schemaVersion: 1\nname: review\nnodes:\n  - id: collect\n    type: form\n    settings:\n      form_schema: schemas/review.json\n",
    );
    await writeWorkingDirFile(
      pkg,
      schemaPath,
      '{"schemaVersion":1,"fields":[{"name":"approved","type":"boolean","label":"Approved"}]}\n',
    );
    await gitCommitWorkingDir(pkg.workingDir, "add review schema");

    await rename(
      join(pkg.workingDir, schemaPath),
      join(pkg.workingDir, "schemas/moved.json"),
    );

    await expect(commitWorkingDir(pkg, "rename schema")).rejects.toMatchObject({
      code: "PRECONDITION",
      details: {
        invalidArtifacts: expect.arrayContaining([
          expect.objectContaining({ path: schemaPath }),
        ]),
      },
    });
  });
});
