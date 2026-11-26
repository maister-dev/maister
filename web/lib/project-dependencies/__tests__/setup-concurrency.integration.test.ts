import { randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

import { serviceDependency } from "../worker";

import { installCapabilityRevision } from "@/lib/capabilities/import";
import {
  capabilityImports,
  projectDependencyAttempts as attempts,
  projectDependencyDeclarations as declarations,
  projectPackageAttachments,
  projects,
  users,
} from "@/lib/db/schema";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

let database: StartedPostgresTestDb;
let root: string;
const actor = randomUUID();
const home = process.env.HOME;

beforeAll(async () => {
  database = await startMainPostgresTestDb({
    databaseName: "dependency_setup_concurrency",
  });
  root = await mkdtemp(join(tmpdir(), "dependency-setup-concurrency-"));
  process.env.HOME = root;
  await database.db.insert(users).values({
    id: actor,
    email: "setup-concurrency@example.invalid",
    role: "admin",
    accountStatus: "active",
  });
}, 180_000);
afterAll(async () => {
  if (home === undefined) delete process.env.HOME;
  else process.env.HOME = home;
  await database?.stop();
  if (root) await rm(root, { recursive: true, force: true });
});
const flowManifest = (id: string) =>
  `schemaVersion: 1\nname: ${id}\ncompat: {engine_min: 3.0.0}\nnodes:\n  - id: step\n    type: cli\n    action: {command: echo ok}\n    transitions: {success: done}\n`;

it.each([
  "flow",
  "capability_import",
  "package-flow",
  "package-capability",
] as const)(
  "keeps an independent same-project Flow install available during %s setup",
  async (kind) => {
    const id = randomUUID(),
      area = join(root, id);
    const db = database.db;

    await mkdir(area);
    const slow = join(area, "slow"),
      fast = join(area, "fast"),
      repo = join(area, "project");

    await Promise.all([mkdir(slow), mkdir(fast), mkdir(repo)]);
    await db.insert(projects).values({
      id,
      slug: "p-" + id.slice(0, 8),
      repoPath: repo,
      name: "Setup",
      taskKey: id.slice(0, 8).toUpperCase(),
    });
    await writeFile(join(fast, "flow.yaml"), flowManifest("independent"));
    const packageMember = kind.startsWith("package");
    const member = packageMember ? join(slow, "member") : slow;

    if (packageMember) {
      await mkdir(member);
      const section = kind === "package-flow" ? "flows" : "capabilities";
      let secondMember = "";

      if (kind === "package-capability") {
        await mkdir(join(slow, "second"));
        await writeFile(
          join(slow, "second", "setup.sh"),
          "touch '" + join(area, "second-started") + "'\n",
        );
        secondMember = "  - {id: next-member, path: second}\n";
      }
      await writeFile(
        join(slow, "maister-package.yaml"),
        `schemaVersion: 1\nname: blocked-package\n${section}:\n  - {id: blocked, path: member}\n${secondMember}`,
      );
    }
    if (kind === "flow" || kind === "package-flow")
      await writeFile(join(member, "flow.yaml"), flowManifest("blocked"));
    const started = join(area, "started"),
      release = join(area, "release");

    await writeFile(
      join(member, "setup.sh"),
      `#!/bin/sh\ntouch '${started}'\nwhile [ ! -f '${release}' ]; do sleep 0.05; done\n`,
    );
    async function enqueue(
      logicalId: string,
      dependencyKind: "flow" | "capability_import" | "package",
      source: string,
    ) {
      const desired = { source, version: "local" };
      const [head] = await db
        .insert(declarations)
        .values({
          projectId: id,
          kind: dependencyKind,
          logicalId,
          ordinal: 0,
          desired,
        })
        .returning();
      const [attempt] = await db
        .insert(attempts)
        .values({
          projectId: id,
          declarationId: head.id,
          generation: 1,
          attemptNo: 1,
          actorUserId: actor,
          desired,
        })
        .returning();

      return attempt.id;
    }
    if (kind === "capability_import") {
      const legacy = await installCapabilityRevision({
        db,
        projectId: id,
        source: slow,
        version: "local",
        capabilityRefId: "blocked",
      });

      await db
        .update(capabilityImports)
        .set({ manifest: {} })
        .where(eq(capabilityImports.id, legacy.importRowId));
    }
    const slowId = await enqueue(
      "blocked",
      packageMember
        ? "package"
        : kind === "flow"
          ? "flow"
          : "capability_import",
      slow,
    );
    const fastId = await enqueue("independent", "flow", fast);
    const worker = () => serviceDependency(db, new AbortController().signal);
    const busy = worker();

    try {
      await vi.waitFor(() => access(started), { timeout: 8000, interval: 50 });
      expect(await worker()).toBe(true);
      expect(
        await db.select().from(attempts).where(eq(attempts.id, fastId)),
      ).toMatchObject([{ status: "succeeded" }]);
      expect(
        await db.select().from(attempts).where(eq(attempts.id, slowId)),
      ).toMatchObject([{ status: "running", stage: "setup" }]);
      if (kind === "package-capability") {
        // Revoke after the first legitimate dispatch. Neither a later member
        // nor the effective attachment may be published by this actor.
        await db
          .update(users)
          .set({ role: "member" })
          .where(eq(users.id, actor));
      }
    } finally {
      await writeFile(release, "");
      await busy;
      await db.update(users).set({ role: "admin" }).where(eq(users.id, actor));
    }
    const [settled] = await db
      .select()
      .from(attempts)
      .where(eq(attempts.id, slowId));

    if (kind === "package-capability") {
      expect(settled).toMatchObject({
        status: "failed",
        reason: "authority_revoked",
      });
      await expect(access(join(area, "second-started"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(
        await db
          .select()
          .from(projectPackageAttachments)
          .where(eq(projectPackageAttachments.projectId, id)),
      ).toHaveLength(0);
    } else expect(settled.status).toBe("succeeded");
  },
  20000,
);
