import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";

import {
  flows,
  packageInstalls,
  projectDependencyAttempts as attempts,
  projectDependencyDeclarations as heads,
  projectPackageAttachments as attachments,
  projects,
  users,
} from "@/lib/db/schema";
import { projectFlowSymlinkPath } from "@/lib/flow-paths";
import {
  attachPackage,
  installPackageRevision,
  upgradeAttachment,
} from "@/lib/packages/attach";
import { serviceDependency } from "@/lib/project-dependencies/worker";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

const git = promisify(execFile);
const source = "https://packages.test.invalid/material.git";
const actor = randomUUID();
let origin: string,
  sandbox: string,
  home: string,
  database: StartedPostgresTestDb,
  originalHome: string | undefined;

async function gitOrigin(args: string[]): Promise<string> {
  return (await git("git", ["-C", origin, ...args])).stdout.trim();
}
async function writePackage(
  subpath: string,
  marker: string,
  name = "catalog-package",
  setup?: string,
): Promise<void> {
  const dir = join(origin, subpath);

  await mkdir(join(dir, "flow"), { recursive: true });
  await writeFile(
    join(dir, "maister-package.yaml"),
    `schemaVersion: 1\nname: ${name}\nmcps:\n  - {id: member-mcp, transport: http, url: https://mcp.example.invalid}\nflows:\n  - {id: material-flow, path: flow}\n${setup ? "capabilities:\n  - {id: late-bundle, path: bundle}\n" : ""}`,
  );
  await writeFile(
    join(dir, "flow", "flow.yaml"),
    `schemaVersion: 1\nname: material-flow\nmcps: [member-mcp]\ncompat: {engine_min: 3.0.0}\nnodes:\n  - id: step\n    type: cli\n    action: {command: echo ${marker}}\n    transitions: {success: done}\n`,
  );
  await writeFile(join(dir, "witness.txt"), marker);
  if (setup) {
    await mkdir(join(dir, "bundle"), { recursive: true });
    await writeFile(join(dir, "bundle/setup.sh"), setup);
  }
}
beforeAll(async () => {
  database = await startMainPostgresTestDb({
    databaseName: "dependency_material",
  });
  sandbox = await mkdtemp(join(tmpdir(), "dependency-material-"));
  home = join(sandbox, "home");
  origin = join(sandbox, "origin");
  await mkdir(home);
  await mkdir(origin);
  originalHome = process.env.HOME;
  process.env.HOME = home;
  await gitOrigin(["init", "--initial-branch=main"]);
  await gitOrigin(["config", "user.name", "Material test"]);
  await gitOrigin(["config", "user.email", "material@example.invalid"]);
  await git("git", [
    "config",
    "--global",
    `url.${pathToFileURL(origin).href}.insteadOf`,
    source,
  ]);
  await writePackage("first", "first");
  await writePackage("second", "second");
  await gitOrigin(["add", "."]);
  await gitOrigin(["commit", "-m", "Independent same-name package materials"]);
  await gitOrigin(["tag", "shared"]);
  await database.db.insert(users).values({
    id: actor,
    email: "material@example.invalid",
    role: "admin",
    accountStatus: "active",
  });
}, 180_000);
afterAll(async () => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  await database?.stop();
  if (sandbox) await rm(sandbox, { recursive: true, force: true });
});
async function project() {
  const id = randomUUID(),
    slug = "project-" + id.slice(0, 8),
    repoPath = join(sandbox, slug);

  await mkdir(repoPath);
  await database.db.insert(projects).values({
    id,
    slug,
    name: slug,
    taskKey: slug.slice(8).toUpperCase(),
    repoPath,
  });

  return {
    projectId: id,
    projectSlug: slug,
    workspaceRoot: repoPath,
    db: database.db,
  };
}
async function request(
  target: Awaited<ReturnType<typeof project>>,
  path: string,
  version: string,
) {
  const desired = {
    source,
    path,
    version,
    capabilityRefIds: { mcp: [], restriction: [], skill: [], setting: [] },
  };
  const [head] = await database.db
    .insert(heads)
    .values({
      projectId: target.projectId,
      logicalId: "manifest-alias",
      kind: "package",
      ordinal: 0,
      desired,
    })
    .returning();
  const [attempt] = await database.db
    .insert(attempts)
    .values({
      projectId: target.projectId,
      declarationId: head.id,
      generation: 1,
      attemptNo: 1,
      actorUserId: actor,
      desired,
    })
    .returning();

  return { head, attempt };
}
const tick = () => serviceDependency(database.db, new AbortController().signal);

it("serializes a shared cache across projects, refuses a different subpath's bytes and recovers an existing attachment at its exact cached revision after a tag moves", async () => {
  const db = database.db;
  const left = await project(),
    right = await project(),
    other = await project();
  const first = await request(left, "first", "shared");

  await request(right, "first", "shared");
  await Promise.all([tick(), tick()]);
  const saved = await db
    .select()
    .from(packageInstalls)
    .where(eq(packageInstalls.name, "catalog-package"));

  expect(saved).toHaveLength(1);
  const immutable = saved[0]!;

  expect(
    await readFile(join(immutable.installedPath, "witness.txt"), "utf8"),
  ).toBe("first");
  for (const target of [left, right]) {
    const [attached] = await db
      .select()
      .from(attachments)
      .where(eq(attachments.projectId, target.projectId));

    expect(attached?.packageInstallId).toBe(immutable.id);
    const [flow] = await db
      .select()
      .from(flows)
      .where(eq(flows.projectId, target.projectId));

    expect(
      await readlink(
        projectFlowSymlinkPath(
          target.workspaceRoot,
          target.projectSlug,
          "material-flow",
        ),
      ),
    ).toBe(flow?.installedPath);
  }
  const failed = await request(other, "second", "shared");

  await tick();
  expect(
    await db.select().from(attempts).where(eq(attempts.id, failed.attempt.id)),
  ).toMatchObject([{ status: "failed", reason: "install_identity_conflict" }]);
  expect(
    await db
      .select()
      .from(attachments)
      .where(eq(attachments.projectId, other.projectId)),
  ).toEqual([]);
  expect(
    await readFile(join(immutable.installedPath, "witness.txt"), "utf8"),
  ).toBe("first");
  const [original] = await db
    .select()
    .from(attachments)
    .where(eq(attachments.projectId, left.projectId));
  const yetToPublish = projectFlowSymlinkPath(
    left.workspaceRoot,
    left.projectSlug,
    "material-flow",
  );
  const originalLink = await readlink(yetToPublish);

  await rm(yetToPublish);
  const newTarget = await project();
  const onlyCached = await request(newTarget, "first", "shared");

  await writePackage("first", "moved");
  await gitOrigin(["add", "."]);
  await gitOrigin(["commit", "-m", "Move source tag"]);
  await gitOrigin(["tag", "-f", "shared"]);
  // Simulate the durable windows on both sides of the project transaction.
  for (const id of [first.attempt.id, onlyCached.attempt.id]) {
    await db
      .update(attempts)
      .set({
        status: "running",
        claimToken: randomUUID(),
        leaseExpiresAt: new Date(0),
        resolvedRevision: immutable.resolvedRevision,
        checkpoint: { installId: immutable.id },
      })
      .where(eq(attempts.id, id));
  }
  await Promise.all([tick(), tick()]);
  expect(
    await db
      .select()
      .from(attachments)
      .where(eq(attachments.projectId, left.projectId)),
  ).toEqual([original]);
  const [reused] = await db
    .select()
    .from(attachments)
    .where(eq(attachments.projectId, newTarget.projectId));

  expect(reused?.packageInstallId).toBe(immutable.id);
  expect(await readlink(yetToPublish)).toBe(originalLink);
  expect(
    await readlink(
      projectFlowSymlinkPath(
        newTarget.workspaceRoot,
        newTarget.projectSlug,
        "material-flow",
      ),
    ),
  ).toBe(originalLink);
  expect(
    await db
      .select()
      .from(packageInstalls)
      .where(eq(packageInstalls.name, "catalog-package")),
  ).toHaveLength(1);
  for (const item of [first, onlyCached]) {
    expect(
      await db.select().from(attempts).where(eq(attempts.id, item.attempt.id)),
    ).toMatchObject([
      { status: "succeeded", resolvedRevision: immutable.resolvedRevision },
    ]);
  }
});
it("leaves the previous project's member link and immutable enablement usable when setup rejects a replacement", async () => {
  const target = await project();
  const { db, projectId } = target;

  await writePackage("stable", "before", "rollback-package");
  await writePackage(
    "broken",
    "after",
    "rollback-package",
    "#!/bin/sh\nexit 17\n",
  );
  const stable = await installPackageRevision({
    source: join(origin, "stable"),
    version: "v1",
    trustStatus: "trusted_by_policy",
    db,
  });
  const broken = await installPackageRevision({
    source: join(origin, "broken"),
    version: "v2",
    trustStatus: "trusted_by_policy",
    db,
  });
  const attached = await attachPackage({
    ...target,
    packageInstallId: stable.id,
  });
  const link = projectFlowSymlinkPath(
      target.workspaceRoot,
      target.projectSlug,
      "material-flow",
    ),
    before = await readlink(link);

  await expect(
    upgradeAttachment({
      ...target,
      attachmentId: attached!.attachmentId,
      packageInstallId: broken.id,
    }),
  ).rejects.toMatchObject({ details: { reason: "setup_failed" } });
  expect(
    await db
      .select()
      .from(attachments)
      .where(eq(attachments.projectId, projectId)),
  ).toMatchObject([
    { id: attached!.attachmentId, packageInstallId: stable.id },
  ]);
  const [current] = await db
    .select()
    .from(flows)
    .where(
      and(eq(flows.projectId, projectId), eq(flows.flowRefId, "material-flow")),
    );

  expect(current!.installedPath).toBe(before);
  expect(await readlink(link)).toBe(before);
});
