import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
import { forkPackageToLocal } from "@/lib/local-packages/fork";
import { gitCommitWorkingDir, gitHeadSha } from "@/lib/local-packages/git";
import {
  getLocalPackage,
  writeWorkingDirFile,
} from "@/lib/local-packages/service";
import {
  applyPackageVersionChoices,
  cutLocalPackageVersion,
  detectAvailablePackageVersions,
  resolvePackageProvenanceByRevision,
  revertPackageVersionChoices,
} from "@/lib/local-packages/versions";
import { attachPackage } from "@/lib/packages/attach";

// FIXME(any): dual drizzle peer-dep variants (matches fork-cut.integration.test.ts).
const schema = schemaModule as unknown as Record<string, any>;

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase<typeof schemaModule>;
let homeDir: string;
let originalHome: string | undefined;
let originalDbUrl: string | undefined;
let userId: string;
// manifest name → its installed source package id (forked from to make locals).
const sourceInstall: Record<string, string> = {};

const FLOW_YAML = (name: string): string =>
  `schemaVersion: 1\nname: ${name}\nsteps:\n  - id: s1\n    type: cli\n    command: echo hi\n`;

const MANIFEST = (name: string, flowId: string): string =>
  `schemaVersion: 1\nname: ${name}\nflows:\n  - { id: ${flowId}, path: flows/${flowId} }\ncapabilities: []\n`;

// Each source package owns a DISTINCT manifest flow id so two of them can attach
// to one project (a project rejects two flows with the same flow_ref_id).
async function buildSourcePackage(
  root: string,
  name: string,
  flowId: string,
): Promise<void> {
  await mkdir(join(root, `flows/${flowId}`), { recursive: true });
  await writeFile(join(root, `flows/${flowId}/flow.yaml`), FLOW_YAML(flowId));
  await writeFile(join(root, "maister-package.yaml"), MANIFEST(name, flowId));
}

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("versionadopt_test")
    .withUsername("test")
    .withPassword("test")
    .start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool, { schema: schemaModule });
  await migrate(db, { migrationsFolder: "./lib/db/migrations" });

  homeDir = await mkdtemp(join(tmpdir(), "versionadopt-int-home-"));
  originalHome = process.env.HOME;
  process.env.HOME = homeDir;
  originalDbUrl = process.env.DB_URL;
  process.env.DB_URL = container.getConnectionUri();

  userId = randomUUID();
  await db
    .insert(schema.users)
    .values({ id: userId, email: `u-${userId}@x.test`, name: "VA Author" });

  // Two distinct-named source packages (distinct flow ids too) so two
  // centralized packages can attach to one project: (project_id, package_name)
  // needs distinct names AND a project rejects duplicate flow_ref_ids.
  for (const [name, flowId] of [
    ["srcpkg", "flow-a"],
    ["otherpkg", "flow-o"],
  ] as const) {
    const dir = await mkdtemp(join(tmpdir(), `va-src-${name}-`));

    await buildSourcePackage(dir, name, flowId);
    const installed = await installPackageRevisionLazy(dir, name);

    sourceInstall[name] = installed;
    await rm(dir, { recursive: true, force: true });
  }
}, 180_000);

// Imported lazily to keep the install isolated from the cut path under test.
async function installPackageRevisionLazy(
  source: string,
  name: string,
): Promise<string> {
  const { installPackageRevision } = await import("@/lib/packages/attach");
  const installed = await installPackageRevision({
    source,
    version: `${name}/v1.0.0`,
    trustStatus: "trusted_by_policy",
    db,
  });

  return installed.id;
}

afterAll(async () => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalDbUrl === undefined) delete process.env.DB_URL;
  else process.env.DB_URL = originalDbUrl;
  await closeDb();
  await pool?.end();
  await container?.stop();
  await rm(homeDir, { recursive: true, force: true });
});

async function createProject(): Promise<{
  id: string;
  slug: string;
  repoPath: string;
}> {
  const id = randomUUID();
  const slug = `va-${id.slice(0, 8)}`;
  const repoPath = join(homeDir, `repo-${id.slice(0, 8)}`);

  await db.insert(schema.projects).values({
    taskKey: `T${randomUUID().slice(0, 8)}`.toUpperCase(),
    id,
    slug,
    name: `VA Proj ${slug}`,
    repoPath,
  });

  return { id, slug, repoPath };
}

// Fork a fresh local package from a source, cut v1, attach v1 to the project.
async function forkCutAttach(
  sourceName: string,
  project: { id: string; slug: string; repoPath: string },
): Promise<{ pkg: any; pinInstallId: string; attachmentId: string }> {
  const { localPackageId } = await forkPackageToLocal({
    sourceInstallId: sourceInstall[sourceName],
    sourceRef: sourceName,
    createdBy: userId,
    forceNew: true,
    db,
  });
  const pkg = await getLocalPackage(localPackageId, db);
  const cut1 = await cutLocalPackageVersion(pkg!, { db });
  const attached = await attachPackage({
    projectId: project.id,
    projectSlug: project.slug,
    packageInstallId: cut1.installId,
    workspaceRoot: project.repoPath,
    db,
  });

  return {
    pkg,
    pinInstallId: cut1.installId,
    attachmentId: attached!.attachmentId,
  };
}

async function attachmentInstall(attachmentId: string): Promise<string> {
  const [row] = await db
    .select()
    .from(schema.projectPackageAttachments)
    .where(eq(schema.projectPackageAttachments.id, attachmentId));

  return row.packageInstallId as string;
}

async function editCommit(
  pkg: any,
  file: string,
  content: string,
): Promise<void> {
  await writeWorkingDirFile(pkg, file, content);
  await gitCommitWorkingDir(pkg.workingDir, `edit ${file}`);
}

describe("version-adopt launch (integration)", () => {
  it("a cut records source_local_package_id + source_commit_sha provenance", async () => {
    const project = await createProject();
    const { pkg, pinInstallId } = await forkCutAttach("srcpkg", project);

    const [install] = await db
      .select()
      .from(schema.packageInstalls)
      .where(eq(schema.packageInstalls.id, pinInstallId));

    expect(install.sourceLocalPackageId).toBe(pkg.id);
    expect(install.sourceCommitSha).toBe(await gitHeadSha(pkg.workingDir));
  });

  it("detects a newer cut and `adopt` advances the project pin to it", async () => {
    const project = await createProject();
    const { pkg, pinInstallId, attachmentId } = await forkCutAttach(
      "srcpkg",
      project,
    );

    // A newer cut: edit + commit, then cut v2 → last_cut_install_id = v2.
    await editCommit(pkg, "flows/flow-a/flow.yaml", FLOW_YAML("flow-a-v2"));
    const cut2 = await cutLocalPackageVersion(pkg, { db });

    const detected = await detectAvailablePackageVersions({
      projectId: project.id,
      db,
    });

    expect(detected).toHaveLength(1);
    expect(detected[0].packageInstallId).toBe(pinInstallId);
    expect(detected[0].newerCutInstallId).toBe(cut2.installId);
    expect(detected[0].offeredOptions).toEqual(["keep", "adopt"]);

    const advanced = await applyPackageVersionChoices({
      projectId: project.id,
      projectSlug: project.slug,
      workspaceRoot: project.repoPath,
      choices: { [pinInstallId]: "adopt" },
      db,
    });

    expect(advanced).toHaveLength(1);
    expect(await attachmentInstall(attachmentId)).toBe(cut2.installId);

    // Idempotent: re-detect now sees no newer version (pin == newest cut).
    expect(
      await detectAvailablePackageVersions({ projectId: project.id, db }),
    ).toHaveLength(0);
  });

  it("revert re-pins the attachment after a failed launch (adopt+launch atomic)", async () => {
    const project = await createProject();
    const { pkg, pinInstallId, attachmentId } = await forkCutAttach(
      "srcpkg",
      project,
    );

    await editCommit(pkg, "flows/flow-a/flow.yaml", FLOW_YAML("flow-a-v2"));
    const cut2 = await cutLocalPackageVersion(pkg, { db });

    const reverts = await applyPackageVersionChoices({
      projectId: project.id,
      projectSlug: project.slug,
      workspaceRoot: project.repoPath,
      choices: { [pinInstallId]: "adopt" },
      db,
    });

    // The pin advanced to the newer cut...
    expect(reverts).toHaveLength(1);
    expect(await attachmentInstall(attachmentId)).toBe(cut2.installId);

    // ...then a launch failure after the adopt re-pins it to the prior install.
    await revertPackageVersionChoices(reverts, {
      projectId: project.id,
      projectSlug: project.slug,
      workspaceRoot: project.repoPath,
      db,
    });
    expect(await attachmentInstall(attachmentId)).toBe(pinInstallId);
  });

  it("`keep` is a no-op — the pin is unchanged", async () => {
    const project = await createProject();
    const { pkg, pinInstallId, attachmentId } = await forkCutAttach(
      "srcpkg",
      project,
    );

    await editCommit(pkg, "flows/flow-a/flow.yaml", FLOW_YAML("flow-a-v2"));
    await cutLocalPackageVersion(pkg, { db });

    const advanced = await applyPackageVersionChoices({
      projectId: project.id,
      projectSlug: project.slug,
      workspaceRoot: project.repoPath,
      choices: { [pinInstallId]: "keep" },
      db,
    });

    expect(advanced).toHaveLength(0);
    expect(await attachmentInstall(attachmentId)).toBe(pinInstallId);
  });

  it("`cut_and_adopt` mints a fresh cut from uncut edits, with provenance, and advances", async () => {
    const project = await createProject();
    const { pkg, pinInstallId, attachmentId } = await forkCutAttach(
      "srcpkg",
      project,
    );

    // Uncut committed edits beyond the last cut (HEAD != cut's source_commit_sha).
    await editCommit(pkg, "flows/flow-a/flow.yaml", FLOW_YAML("flow-a-edited"));

    const detected = await detectAvailablePackageVersions({
      projectId: project.id,
      db,
    });

    expect(detected[0].hasUncutEdits).toBe(true);
    expect(detected[0].offeredOptions).toEqual(["keep", "cut_and_adopt"]);

    const advanced = await applyPackageVersionChoices({
      projectId: project.id,
      projectSlug: project.slug,
      workspaceRoot: project.repoPath,
      choices: { [pinInstallId]: "cut_and_adopt" },
      db,
    });

    expect(advanced).toHaveLength(1);
    const newPin = await attachmentInstall(attachmentId);

    expect(newPin).not.toBe(pinInstallId);

    const [minted] = await db
      .select()
      .from(schema.packageInstalls)
      .where(eq(schema.packageInstalls.id, newPin));

    expect(minted.sourceLocalPackageId).toBe(pkg.id);
    expect(minted.sourceCommitSha).toBe(await gitHeadSha(pkg.workingDir));
  });

  it("`cut_and_adopt` on an invalid committed tree → PRECONDITION; `keep` still works", async () => {
    const project = await createProject();
    const { pkg, pinInstallId, attachmentId } = await forkCutAttach(
      "srcpkg",
      project,
    );

    // Commit an invalid flow.yaml (no name/steps) → fails the cut gate.
    await editCommit(pkg, "flows/flow-a/flow.yaml", "schemaVersion: 1\n");

    await expect(
      applyPackageVersionChoices({
        projectId: project.id,
        projectSlug: project.slug,
        workspaceRoot: project.repoPath,
        choices: { [pinInstallId]: "cut_and_adopt" },
        db,
      }),
    ).rejects.toSatisfy(
      (e: unknown) => isMaisterError(e) && e.code === "PRECONDITION",
    );

    // The invalid cut_and_adopt did not advance the pin.
    expect(await attachmentInstall(attachmentId)).toBe(pinInstallId);

    // keep is unaffected by the invalid tree.
    const advanced = await applyPackageVersionChoices({
      projectId: project.id,
      projectSlug: project.slug,
      workspaceRoot: project.repoPath,
      choices: { [pinInstallId]: "keep" },
      db,
    });

    expect(advanced).toHaveLength(0);
  });

  it("`cut_and_adopt` on a package locked by another session → PRECONDITION", async () => {
    const project = await createProject();
    const { pkg, pinInstallId } = await forkCutAttach("srcpkg", project);

    await editCommit(pkg, "flows/flow-a/flow.yaml", FLOW_YAML("flow-a-edited"));

    // Another session holds a live edit-lock.
    await db
      .update(schema.localPackages)
      .set({
        lockedBySession: "other-session",
        lockedByUserId: userId,
        lockExpiresAt: new Date(Date.now() + 60_000),
      })
      .where(eq(schema.localPackages.id, pkg.id));

    await expect(
      applyPackageVersionChoices({
        projectId: project.id,
        projectSlug: project.slug,
        workspaceRoot: project.repoPath,
        choices: { [pinInstallId]: "cut_and_adopt" },
        db,
      }),
    ).rejects.toSatisfy(
      (e: unknown) => isMaisterError(e) && e.code === "PRECONDITION",
    );
  });

  it("an unknown key or an unoffered option → CONFLICT (server-constrained)", async () => {
    const project = await createProject();
    const { pkg, pinInstallId } = await forkCutAttach("srcpkg", project);

    // Uncut edits → only [keep, cut_and_adopt] offered (no newer cut).
    await editCommit(pkg, "flows/flow-a/flow.yaml", FLOW_YAML("flow-a-edited"));

    // Unknown install id.
    await expect(
      applyPackageVersionChoices({
        projectId: project.id,
        projectSlug: project.slug,
        workspaceRoot: project.repoPath,
        choices: { "not-a-real-install": "adopt" },
        db,
      }),
    ).rejects.toSatisfy(
      (e: unknown) => isMaisterError(e) && e.code === "CONFLICT",
    );

    // `adopt` is not offered (there is no newer cut, only uncut edits).
    await expect(
      applyPackageVersionChoices({
        projectId: project.id,
        projectSlug: project.slug,
        workspaceRoot: project.repoPath,
        choices: { [pinInstallId]: "adopt" },
        db,
      }),
    ).rejects.toSatisfy(
      (e: unknown) => isMaisterError(e) && e.code === "CONFLICT",
    );
  });

  it("multiple attached centralized packages are each detected and advanced", async () => {
    const project = await createProject();
    const a = await forkCutAttach("srcpkg", project);
    const b = await forkCutAttach("otherpkg", project);

    // A newer cut of each (each package owns a distinct flow path).
    await editCommit(a.pkg, "flows/flow-a/flow.yaml", FLOW_YAML("a-v2"));
    const a2 = await cutLocalPackageVersion(a.pkg, { db });

    await editCommit(b.pkg, "flows/flow-o/flow.yaml", FLOW_YAML("o-v2"));
    const b2 = await cutLocalPackageVersion(b.pkg, { db });

    const detected = await detectAvailablePackageVersions({
      projectId: project.id,
      db,
    });

    expect(detected).toHaveLength(2);

    await applyPackageVersionChoices({
      projectId: project.id,
      projectSlug: project.slug,
      workspaceRoot: project.repoPath,
      choices: { [a.pinInstallId]: "adopt", [b.pinInstallId]: "adopt" },
      db,
    });

    expect(await attachmentInstall(a.attachmentId)).toBe(a2.installId);
    expect(await attachmentInstall(b.attachmentId)).toBe(b2.installId);
  });

  it("a later package's failure rolls back an earlier package's advance (all-or-nothing)", async () => {
    const project = await createProject();
    const a = await forkCutAttach("srcpkg", project);
    const b = await forkCutAttach("otherpkg", project);

    // A: mint a newer cut to adopt.
    await editCommit(a.pkg, "flows/flow-a/flow.yaml", FLOW_YAML("a-v2"));
    const a2 = await cutLocalPackageVersion(a.pkg, { db });

    expect(a2.installId).not.toBe(a.pinInstallId);

    // B: uncut edits (so cut_and_adopt is offered) but the editor is LOCKED, so B's
    // cut_and_adopt throws in phase 2 — AFTER A has already advanced.
    await editCommit(b.pkg, "flows/flow-o/flow.yaml", FLOW_YAML("o-v2"));
    await db
      .update(schema.localPackages)
      .set({
        lockedByUserId: userId,
        lockedBySession: "another-session",
        lockExpiresAt: new Date(Date.now() + 60_000),
      })
      .where(eq(schema.localPackages.id, b.pkg.id));

    await expect(
      applyPackageVersionChoices({
        projectId: project.id,
        projectSlug: project.slug,
        workspaceRoot: project.repoPath,
        // Insertion order = apply order: A (adopt) advances, then B (cut_and_adopt)
        // fails on the lock → A must be rolled back before the throw propagates.
        choices: {
          [a.pinInstallId]: "adopt",
          [b.pinInstallId]: "cut_and_adopt",
        },
        db,
      }),
    ).rejects.toSatisfy(
      (e: unknown) => isMaisterError(e) && e.code === "PRECONDITION",
    );

    // A was advanced then reverted → still pinned to its ORIGINAL cut, not a2.
    expect(await attachmentInstall(a.attachmentId)).toBe(a.pinInstallId);
    // B never advanced.
    expect(await attachmentInstall(b.attachmentId)).toBe(b.pinInstallId);
  });

  it("run provenance is derivable from the flow-revision digest (no runs column)", async () => {
    const project = await createProject();
    const { pkg, pinInstallId } = await forkCutAttach("srcpkg", project);

    const [install] = await db
      .select()
      .from(schema.packageInstalls)
      .where(eq(schema.packageInstalls.id, pinInstallId));

    const prov = await resolvePackageProvenanceByRevision(
      install.resolvedRevision as string,
      db,
    );

    expect(prov).not.toBeNull();
    expect(prov!.packageName).toBe("srcpkg");
    expect(prov!.localPackageName).toBe(pkg.name);
    expect(prov!.versionLabel).toMatch(/^local-[0-9a-f]{12}$/);
  });

  it("the same cut attaches to a second project (cross-project version reuse)", async () => {
    const projectA = await createProject();
    const { pkg } = await forkCutAttach("srcpkg", projectA);

    await editCommit(pkg, "flows/flow-a/flow.yaml", FLOW_YAML("shared-v2"));
    const cut2 = await cutLocalPackageVersion(pkg, { db });

    const projectB = await createProject();
    const attachedB = await attachPackage({
      projectId: projectB.id,
      projectSlug: projectB.slug,
      packageInstallId: cut2.installId,
      workspaceRoot: projectB.repoPath,
      db,
    });

    expect(attachedB).not.toBeNull();
    expect(await attachmentInstall(attachedB!.attachmentId)).toBe(
      cut2.installId,
    );
  });
});
