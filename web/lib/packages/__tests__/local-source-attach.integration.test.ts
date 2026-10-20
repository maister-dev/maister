import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { eq } from "drizzle-orm";
import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closeDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import {
  attachPackage,
  installPackageRevision,
  upgradeAttachment,
} from "@/lib/packages/attach";
import {
  createPackageSource,
  refreshPackageSource,
} from "@/lib/packages/catalog";
import { getProjectPackageAttachments } from "@/lib/queries/packages";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

// ADR-132 §c acceptance #6 chain: an arbitrary host directory registers as a
// kind:local source → discovers → installs with a digest label → attaches to
// a project like a git source → `updateAvailable` stays false until the host
// dir mutates and a re-check re-digests (digest-as-version, by-kind carve).

const schema = schemaModule as unknown as Record<string, any>;

let container: StartedPostgresTestDb["container"];
let testDatabase: StartedPostgresTestDb;
let db: NodePgDatabase<typeof schemaModule>;
let homeDir: string;
let originalHome: string | undefined;
let originalDbUrl: string | undefined;

const FLOW_YAML = (marker: string): string =>
  [
    "schemaVersion: 1",
    "name: flow-l",
    "compat:",
    "  engine_min: 1.1.0",
    "nodes:",
    "  - id: implement",
    "    type: ai_coding",
    "    action:",
    `      prompt: "/aif-implement ${marker}"`,
    "    transitions:",
    "      success: done",
    "",
  ].join("\n");

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "localattach_test",
  });
  container = testDatabase.container;
  db = testDatabase.db;

  homeDir = await mkdtemp(join(tmpdir(), "local-attach-home-"));
  originalHome = process.env.HOME;
  process.env.HOME = homeDir;
  originalDbUrl = process.env.DB_URL;
  process.env.DB_URL = container.getConnectionUri();
}, 180_000);

afterAll(async () => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalDbUrl === undefined) delete process.env.DB_URL;
  else process.env.DB_URL = originalDbUrl;
  await closeDb();
  await testDatabase?.stop();
});

describe("kind:local source → install → attach chain (integration)", () => {
  it("register → discover → install by digest → attach → drift flips updateAvailable via re-check", async () => {
    // The arbitrary host directory (monorepo layout).
    const root = await mkdtemp(join(tmpdir(), "host-checkout-"));

    try {
      await mkdir(join(root, "packages/hostpkg/flows/flow-l"), {
        recursive: true,
      });
      await writeFile(
        join(root, "packages/hostpkg/maister-package.yaml"),
        "schemaVersion: 1\nname: hostpkg\nflows:\n  - { id: flow-l, path: flows/flow-l }\ncapabilities: []\n",
      );
      await writeFile(
        join(root, "packages/hostpkg/flows/flow-l/flow.yaml"),
        FLOW_YAML("v1"),
      );

      const { id: sourceId } = await createPackageSource({
        url: root,
        kind: "local",
        db,
      });
      const discovery = await refreshPackageSource({ id: sourceId, db });
      const entry = discovery?.packages[0];

      expect(entry).toMatchObject({ name: "hostpkg", dir: "hostpkg" });

      // Install the discovered package (the admin route's local form:
      // version is server-derived from the digest, path from the dir).
      const install = await installPackageRevision({
        source: root,
        version: "local",
        path: `packages/${entry!.dir}`,
        trustStatus: "trusted_by_policy",
        db,
      });

      expect(install.versionLabel).toBe(entry!.digestVersionLabel);

      // Attach to a project like any git-sourced install.
      const projectId = randomUUID();
      const slug = `la-${projectId.slice(0, 8)}`;

      await db.insert(schema.projects).values({
        taskKey: `T${randomUUID().slice(0, 8)}`.toUpperCase(),
        id: projectId,
        slug,
        name: `LA ${slug}`,
        repoPath: join(homeDir, `repo-${slug}`),
      });
      const attached = await attachPackage({
        projectId,
        projectSlug: slug,
        packageInstallId: install.id,
        workspaceRoot: join(homeDir, `repo-${slug}`),
        db,
      });

      expect(attached?.attachmentId).toBeDefined();

      // The trust confirmation count is an admin-only read-model enrichment.
      // A second project using this exact install proves the count is distinct
      // by project rather than a revision/package-wide number.
      const secondProjectId = randomUUID();
      const secondSlug = `la-${secondProjectId.slice(0, 8)}`;

      await db.insert(schema.projects).values({
        taskKey: `T${randomUUID().slice(0, 8)}`.toUpperCase(),
        id: secondProjectId,
        slug: secondSlug,
        name: `LA ${secondSlug}`,
        repoPath: join(homeDir, `repo-${secondSlug}`),
      });
      await attachPackage({
        projectId: secondProjectId,
        projectSlug: secondSlug,
        packageInstallId: install.id,
        workspaceRoot: join(homeDir, `repo-${secondSlug}`),
        db,
      });

      // Pinned digest == discovered digest ⇒ no update.
      const before = await getProjectPackageAttachments(projectId);

      expect(before).toHaveLength(1);
      expect(before[0]).toMatchObject({
        packageName: "hostpkg",
        versionLabel: entry!.digestVersionLabel,
        updateAvailable: false,
      });
      expect(before[0]).not.toHaveProperty("affectedProjectCount");

      const trustView = await getProjectPackageAttachments(projectId, {
        includeAffectedProjectCount: true,
      });

      expect(trustView[0]?.affectedProjectCount).toBe(2);

      // Mutate the host dir → re-check → the by-kind carve flips the flag
      // and offers the fresh digest as the upgrade label.
      await writeFile(
        join(root, "packages/hostpkg/flows/flow-l/flow.yaml"),
        FLOW_YAML("v2"),
      );
      const recheck = await refreshPackageSource({ id: sourceId, db });
      const freshLabel = recheck?.packages[0]?.digestVersionLabel;

      expect(freshLabel).not.toBe(entry!.digestVersionLabel);

      const after = await getProjectPackageAttachments(projectId);

      expect(after[0]).toMatchObject({ updateAvailable: true });
      // The upgrade target appears once the fresh digest is installed.
      const freshInstall = await installPackageRevision({
        source: root,
        version: "local",
        path: `packages/${recheck!.packages[0]!.dir}`,
        trustStatus: "trusted_by_policy",
        db,
      });

      expect(freshInstall.versionLabel).toBe(freshLabel);

      const withTarget = await getProjectPackageAttachments(projectId);

      expect(withTarget[0]?.upgradeTarget).toMatchObject({
        installId: freshInstall.id,
        versionLabel: freshLabel,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);

  it("switches an attachment between package sources and offers the reverse switch", async () => {
    const upstreamRoot = await mkdtemp(join(tmpdir(), "source-upstream-"));
    const localRoot = await mkdtemp(join(tmpdir(), "source-local-"));

    try {
      for (const [root, marker] of [
        [upstreamRoot, "upstream"],
        [localRoot, "local"],
      ] as const) {
        await mkdir(join(root, "packages/switchpkg/flows/flow-l"), {
          recursive: true,
        });
        await writeFile(
          join(root, "packages/switchpkg/maister-package.yaml"),
          "schemaVersion: 1\nname: switchpkg\nflows:\n  - { id: flow-l, path: flows/flow-l }\ncapabilities: []\n",
        );
        await writeFile(
          join(root, "packages/switchpkg/flows/flow-l/flow.yaml"),
          FLOW_YAML(marker),
        );
      }

      const upstreamSource = await createPackageSource({
        url: upstreamRoot,
        kind: "local",
        db,
      });
      const localSource = await createPackageSource({
        url: localRoot,
        kind: "local",
        db,
      });
      const upstreamDiscovery = await refreshPackageSource({
        id: upstreamSource.id,
        db,
      });
      const localDiscovery = await refreshPackageSource({
        id: localSource.id,
        db,
      });
      const upstreamInstall = await installPackageRevision({
        source: upstreamRoot,
        version: "local",
        path: `packages/${upstreamDiscovery!.packages[0]!.dir}`,
        trustStatus: "trusted_by_policy",
        db,
      });
      const localInstall = await installPackageRevision({
        source: localRoot,
        version: "local",
        path: `packages/${localDiscovery!.packages[0]!.dir}`,
        trustStatus: "trusted_by_policy",
        db,
      });

      // The read model keys the label by registered source kind. Mark this
      // fixture as git after local discovery so the test remains hermetic.
      await db
        .update(schema.packageSources)
        .set({ kind: "git" })
        .where(eq(schema.packageSources.id, upstreamSource.id));

      const projectId = randomUUID();
      const slug = `switch-${projectId.slice(0, 8)}`;
      const workspaceRoot = join(homeDir, `repo-${slug}`);

      await db.insert(schema.projects).values({
        taskKey: `T${randomUUID().slice(0, 8)}`.toUpperCase(),
        id: projectId,
        slug,
        name: `Switch ${slug}`,
        repoPath: workspaceRoot,
      });
      const attached = await attachPackage({
        projectId,
        projectSlug: slug,
        packageInstallId: upstreamInstall.id,
        workspaceRoot,
        db,
      });

      const fromGit = await getProjectPackageAttachments(projectId);

      expect(fromGit[0]).toMatchObject({
        packageInstallId: upstreamInstall.id,
        sourceKind: "git",
        sourceTargets: [
          {
            installId: localInstall.id,
            sourceKind: "local",
            compatible: true,
          },
        ],
      });

      await upgradeAttachment({
        projectId,
        projectSlug: slug,
        attachmentId: attached!.attachmentId,
        packageInstallId: localInstall.id,
        workspaceRoot,
        db,
      });

      const fromLocal = await getProjectPackageAttachments(projectId);

      expect(fromLocal[0]).toMatchObject({
        packageInstallId: localInstall.id,
        sourceKind: "local",
        sourceTargets: [
          {
            installId: upstreamInstall.id,
            sourceKind: "git",
            compatible: true,
          },
        ],
      });
    } finally {
      await rm(upstreamRoot, { recursive: true, force: true });
      await rm(localRoot, { recursive: true, force: true });
    }
  }, 120_000);
});
