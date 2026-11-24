import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  access,
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

import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

import {
  flows,
  flowRevisions,
  packageInstalls,
  projectDependencyAttempts as attempts,
  projectDependencyDeclarations as heads,
  projectPackageAttachments as attachments,
  projects,
  users,
} from "@/lib/db/schema";
import { prepareCapabilityRevision } from "@/lib/capabilities/import";
import { localDirectoryContentDigest } from "@/lib/project-dependencies/content-digest";
import {
  projectFlowSymlinkPath,
  systemCachePath,
  systemCapabilityCachePath,
} from "@/lib/flow-paths";
import { installOperatorPackage } from "@/lib/project-dependencies/operator";
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

  const damagedTarget = await project();
  const damaged = await request(damagedTarget, "first", "shared");

  await db
    .update(attempts)
    .set({
      status: "running",
      claimToken: randomUUID(),
      leaseExpiresAt: new Date(0),
      resolvedRevision: immutable.resolvedRevision,
      checkpoint: { installId: immutable.id },
    })
    .where(eq(attempts.id, damaged.attempt.id));
  await writeFile(
    join(immutable.installedPath, "witness.txt"),
    "damaged after install",
  );
  await tick();
  expect(
    await db.select().from(attempts).where(eq(attempts.id, damaged.attempt.id)),
  ).toMatchObject([{ status: "failed", reason: "install_identity_conflict" }]);
  expect(
    await db
      .select()
      .from(attachments)
      .where(eq(attachments.projectId, damagedTarget.projectId)),
  ).toEqual([]);
});
it.each([
  "manual-capability",
  "manual-flow",
  "cli-flow",
  "cli-capability",
  "manual-revoked",
  "manual-stale",
] as const)(
  "preserves the effective project attachment and link when %s setup rejects a replacement",
  async (mode) => {
    const target = await project();
    const { db, projectId } = target;

    const stableDir = "stable-" + mode;
    const brokenDir = "broken-" + mode;
    const name = "rollback-" + mode;
    const started = join(sandbox, mode + "-started");
    const release = join(sandbox, mode + "-release");
    const success = mode === "manual-stale" || mode === "manual-revoked";
    const cli = mode.startsWith("cli-");
    const capability = mode.endsWith("-capability");
    const setup = `#!/bin/sh\ntouch '${started}'\nwhile [ ! -e '${release}' ]; do sleep 0.05; done\nexit ${success ? "0" : "17"}\n`;

    await writePackage(stableDir, "before", name);
    await writePackage(
      brokenDir,
      "after",
      name,
      capability ? setup : undefined,
    );
    if (!capability)
      await writeFile(join(origin, brokenDir, "flow", "setup.sh"), setup);
    const stable = await installPackageRevision({
      source: join(origin, stableDir),
      version: "v1",
      trustStatus: "trusted_by_policy",
      db,
    });
    const broken = await installPackageRevision({
      source: join(origin, brokenDir),
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

    const pin = { source: join(origin, brokenDir), version: "v2" };

    if (cli)
      await db
        .update(heads)
        .set({ desired: pin, generation: 2 })
        .where(eq(heads.projectId, projectId));
    const operation = cli
      ? installOperatorPackage(target, pin)
      : upgradeAttachment({
          ...target,
          attachmentId: attached!.attachmentId,
          packageInstallId: broken.id,
          actorGrant: { userId: actor, action: "managePackages" },
        });
    const outcome = operation.then(
      () => null,
      (error: unknown) => error,
    );

    try {
      await vi.waitFor(() => access(started), { timeout: 8000, interval: 25 });
      await db.transaction(async (tx) => {
        await tx
          .select({ id: projects.id })
          .from(projects)
          .where(eq(projects.id, projectId))
          .for("update", { noWait: true });
        if (mode === "manual-revoked")
          await tx
            .update(users)
            .set({ role: "member" })
            .where(eq(users.id, actor));
        if (mode === "manual-stale")
          await tx
            .update(heads)
            .set({ generation: 2, desired: { ...pin, version: "corrected" } })
            .where(eq(heads.projectId, projectId));
      });
    } finally {
      await writeFile(release, "");
      await outcome;
      if (mode === "manual-revoked")
        await db
          .update(users)
          .set({ role: "admin" })
          .where(eq(users.id, actor));
    }
    expect(await outcome).toMatchObject({
      details: {
        reason:
          mode === "manual-stale"
            ? "stale_generation"
            : mode === "manual-revoked"
              ? "authority_revoked"
              : "setup_failed",
      },
    });
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
        and(
          eq(flows.projectId, projectId),
          eq(flows.flowRefId, "material-flow"),
        ),
      );

    expect(current!.installedPath).toBe(before);
    expect(await readlink(link)).toBe(before);
  },
);

it("publishes only the local package bytes whose immutable revision was recorded", async () => {
  await writePackage("changing", "original", "changing-package");
  const dir = join(origin, "changing");
  const revision = (await localDirectoryContentDigest(dir)).slice(0, 40);
  const installed = await installPackageRevision({
    source: dir,
    version: "v1",
    db: database.db,
    onResolve: async (resolved) => {
      expect(resolved).toBe(revision);
      await writeFile(join(dir, "witness.txt"), "after resolution");
    },
  });
  const [row] = await database.db
    .select()
    .from(packageInstalls)
    .where(eq(packageInstalls.id, installed.id));

  expect(await readFile(join(row.installedPath, "witness.txt"), "utf8")).toBe(
    "original",
  );
  expect(row.resolvedRevision).toBe(revision);
});

it("resolves local file URLs with localhost and encoded spaces for package and capability material", async () => {
  await writePackage("with space", "encoded", "encoded-package");
  const file = pathToFileURL(join(origin, "with space")).href.replace(
    "file:///",
    "file://localhost/",
  );
  const pkg = await installPackageRevision({
    source: file,
    version: "v1",
    db: database.db,
  });
  const target = await project();
  const cap = await prepareCapabilityRevision({
    source: file,
    version: "v1",
    capabilityRefId: "encoded-capability",
    ...target,
  });

  expect(pkg.resolvedRevision).toBe(
    (await localDirectoryContentDigest(join(origin, "with space"))).slice(
      0,
      40,
    ),
  );
  expect(await readFile(join(cap.installedPath, "witness.txt"), "utf8")).toBe(
    "encoded",
  );
});

it("refuses a sealed capability cache that lost an original file while allowing generated outputs", async () => {
  const target = await project();
  const dir = join(origin, "sealed-cap");

  await mkdir(dir);
  await writeFile(join(dir, "setup.sh"), "exit 0\n");
  const opts = {
    source: dir,
    version: "v1",
    capabilityRefId: "sealed-cap",
    ...target,
  };
  const material = await prepareCapabilityRevision(opts);

  await writeFile(join(material.installedPath, "generated"), "setup output");
  expect((await prepareCapabilityRevision(opts)).hasSetup).toBe(true);
  await rm(join(material.installedPath, "setup.sh"));
  await expect(prepareCapabilityRevision(opts)).rejects.toMatchObject({
    details: { reason: "install_identity_conflict" },
  });
  await rm(material.installedPath, { recursive: true });
  await expect(prepareCapabilityRevision(opts)).rejects.toMatchObject({
    details: { reason: "install_identity_conflict" },
  });
});

it.each([
  "package",
  "flow",
  "capability_import",
  "expired-lease",
  "blocked-cache",
] as const)(
  "fences %s publication after a principal or lease change during a real Git fetch",
  async (mode) => {
    const target = await project();
    const { db, projectId } = target;
    const expires = mode === "expired-lease" || mode === "blocked-cache";
    const kind = expires ? "package" : mode;
    const name = "fenced-" + mode.replaceAll("_", "-");
    const originDir = join(sandbox, name);

    await mkdir(originDir);
    await git("git", ["-C", originDir, "init", "--initial-branch=main"]);
    await writeFile(
      join(originDir, "flow.yaml"),
      `schemaVersion: 1\nname: ${name}\ncompat: {engine_min: 3.0.0}\nnodes:\n  - id: step\n    type: cli\n    action: {command: echo ready}\n    transitions: {success: done}\n`,
    );
    await writeFile(
      join(originDir, "maister-package.yaml"),
      `schemaVersion: 1\nname: ${name}\n`,
    );
    await git("git", ["-C", originDir, "add", "."]);
    await git("git", [
      "-C",
      originDir,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "-m",
      "Publication guard",
    ]);
    const revision = (
      await git("git", ["-C", originDir, "rev-parse", "HEAD"])
    ).stdout.trim();
    const url = "https://fence.example.invalid/" + name + ".git";

    await git("git", [
      "config",
      "--global",
      `url.${pathToFileURL(originDir).href}.insteadOf`,
      url,
    ]);
    const { stdout: executable } = await git("which", ["git"]);
    const shim = join(sandbox, "gate-" + name);
    const started = join(shim, "started"),
      release = join(shim, "release");

    await mkdir(shim);
    await writeFile(
      join(shim, "git"),
      '#!/bin/sh\nif [ "$1" = clone ]; then touch "$FENCE_STARTED"; while [ ! -f "$FENCE_RELEASE" ]; do sleep 0.05; done; fi\nexec "$REAL_TEST_GIT" "$@"\n',
      { mode: 0o755 },
    );
    const desired = { source: url, version: "main" };
    const [head] = await db
      .insert(heads)
      .values({ projectId, logicalId: name, kind, ordinal: 0, desired })
      .returning();
    const [work] = await db
      .insert(attempts)
      .values({
        projectId,
        declarationId: head.id,
        generation: 1,
        attemptNo: 1,
        actorUserId: actor,
        desired,
      })
      .returning();

    vi.stubEnv("PATH", shim + ":" + process.env.PATH);
    vi.stubEnv("REAL_TEST_GIT", executable.trim());
    vi.stubEnv("FENCE_STARTED", started);
    vi.stubEnv("FENCE_RELEASE", release);
    const path =
      kind === "package"
        ? join(home, ".maister", "packages", name + "@" + revision.slice(0, 12))
        : kind === "flow"
          ? systemCachePath(name, revision)
          : systemCapabilityCachePath(name, revision);

    const locked = Promise.withResolvers<void>();
    const releaseCache = Promise.withResolvers<void>();
    const locker =
      mode === "blocked-cache"
        ? db.transaction(async (tx) => {
            await tx.execute(
              sql`SELECT pg_advisory_xact_lock(hashtextextended(${path},0))`,
            );
            locked.resolve();
            await releaseCache.promise;
          })
        : null;

    if (locker) await locked.promise;
    const running = tick();

    try {
      await vi.waitFor(() => access(started), { timeout: 8000, interval: 25 });
      if (locker) {
        await writeFile(release, "");
        await vi.waitFor(
          async () => {
            const { rows } = await db.execute(
              sql`SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND wait_event='advisory'`,
            );

            expect(rows.length).toBeGreaterThan(0);
          },
          { timeout: 8000, interval: 25 },
        );
      }
      if (expires)
        await db
          .update(attempts)
          .set({ leaseExpiresAt: new Date(0) })
          .where(eq(attempts.id, work.id));
      else
        await db
          .update(users)
          .set({ role: "member" })
          .where(eq(users.id, actor));
      releaseCache.resolve();
      await writeFile(release, "");
      await running;
      await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
      const [state] = await db
        .select()
        .from(attempts)
        .where(eq(attempts.id, work.id));

      if (expires) {
        expect(state).toMatchObject({
          status: "running",
          leaseExpiresAt: new Date(0),
        });
        expect(await tick()).toBe(true);
        expect(
          await db.select().from(attempts).where(eq(attempts.id, work.id)),
        ).toMatchObject([{ status: "succeeded" }]);
      } else
        expect(state).toMatchObject({
          status: "failed",
          reason: "authority_revoked",
        });
    } finally {
      releaseCache.resolve();
      await locker;
      await writeFile(release, "");
      await running;
      await db.update(users).set({ role: "admin" }).where(eq(users.id, actor));
      vi.unstubAllEnvs();
    }
  },
);

it("refuses a changed standalone Flow recovery before publishing its new revision", async () => {
  const target = await project();

  await writePackage("recover-flow", "moved", "unused-recovery");
  const pin = { source: join(origin, "recover-flow/flow"), version: "v1" };
  const [head] = await database.db
    .insert(heads)
    .values({
      projectId: target.projectId,
      kind: "flow",
      logicalId: "material-flow",
      ordinal: 0,
      desired: pin,
    })
    .returning();
  const [job] = await database.db
    .insert(attempts)
    .values({
      projectId: target.projectId,
      declarationId: head.id,
      generation: 1,
      attemptNo: 1,
      actorUserId: actor,
      status: "running",
      claimToken: randomUUID(),
      leaseExpiresAt: new Date(0),
      desired: pin,
      resolvedRevision: "1".repeat(40),
    })
    .returning();

  await serviceDependency(database.db, new AbortController().signal, job.id);
  expect(
    await database.db.select().from(attempts).where(eq(attempts.id, job.id)),
  ).toMatchObject([{ status: "failed", reason: "revision_mismatch" }]);
  expect(
    await database.db
      .select()
      .from(flowRevisions)
      .where(eq(flowRevisions.source, pin.source)),
  ).toEqual([]);
});

it("rejects an unowned nested setup file before direct attach or reinstall reads the package members", async () => {
  const dir = join(origin, "nested");

  await mkdir(join(dir, "bundle"), { recursive: true });
  await writeFile(
    join(dir, "maister-package.yaml"),
    "schemaVersion: 1\nname: nested-package\ncapabilities:\n  - {id: nested-cap, path: bundle}\n",
  );
  await writeFile(join(dir, "bundle/README"), "capability");
  const options = { source: dir, version: "v1", db: database.db };
  const installed = await installPackageRevision(options);
  const [row] = await database.db
    .select()
    .from(packageInstalls)
    .where(eq(packageInstalls.id, installed.id));

  await writeFile(join(row.installedPath, "bundle/setup.sh"), "exit 0\n");
  const target = await project();
  const conflict = { details: { reason: "install_identity_conflict" } };
  const attach = () => attachPackage({ ...target, packageInstallId: row.id });

  await expect(attach()).rejects.toMatchObject(conflict);
  await expect(installPackageRevision(options)).rejects.toMatchObject(conflict);
  // Pre-witness installations still have their source coordinates and immutable revision.
  await database.pool.query(
    "UPDATE package_installs SET manifest=manifest-'contentWitness' WHERE id=$1",
    [row.id],
  );
  await expect(attach()).rejects.toMatchObject(conflict);
  expect(
    await database.db
      .select()
      .from(attachments)
      .where(eq(attachments.projectId, target.projectId)),
  ).toEqual([]);
});
