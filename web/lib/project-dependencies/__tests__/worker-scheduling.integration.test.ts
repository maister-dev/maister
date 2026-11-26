import type { ProjectDependencyInput } from "../types";
import type { AddressInfo } from "node:net";

import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";

import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

import { enqueueProjectDependencies } from "../store";
import { claimDependency } from "../claims";
import { serviceDependency } from "../worker";

import * as schema from "@/lib/db/schema";
import { installPackageRevision } from "@/lib/packages/attach";
import {
  users,
  projects,
  projectDependencyAttempts as attempts,
  projectDependencyDeclarations as heads,
  projectPackageAttachments as attachments,
} from "@/lib/db/schema";
import { mkdtempReal } from "@/test-support/worktree-test-root";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

let database: StartedPostgresTestDb;
let root: string;
const actor = randomUUID();
const live = new AbortController().signal;

beforeAll(async () => {
  database = await startMainPostgresTestDb({
    databaseName: "dependency_scheduling",
  });
  root = await mkdtempReal("dependency-scheduling-");
  vi.stubEnv("HOME", root);
  await database.db.insert(users).values({
    id: actor,
    email: actor + "@test.invalid",
    accountStatus: "active",
    role: "admin",
  });
}, 180_000);
afterAll(async () => {
  await database?.stop();
  if (root) await rm(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

async function project(taskKey: string): Promise<string> {
  const id = randomUUID();
  const repoPath = join(root, id);

  await mkdir(repoPath);
  await database.db
    .insert(projects)
    .values({ id, slug: id, name: taskKey, taskKey, repoPath });

  return id;
}
async function enqueue(
  projectId: string,
  declarations: ProjectDependencyInput[],
) {
  await drizzle(database.pool, { schema }).transaction((tx) =>
    enqueueProjectDependencies(tx, {
      actorUserId: actor,
      projectId,
      declarations,
    }),
  );
}
async function attempt(projectId: string, logicalId: string) {
  const [item] = await database.db
    .select({ head: heads, work: attempts })
    .from(heads)
    .innerJoin(attempts, eq(heads.id, attempts.declarationId))
    .where(and(eq(heads.projectId, projectId), eq(heads.logicalId, logicalId)));

  return item;
}
async function flowDir(name: string) {
  const target = join(root, name);

  await mkdir(target, { recursive: true });
  await writeFile(
    join(target, "flow.yaml"),
    JSON.stringify({
      schemaVersion: 1,
      name,
      compat: { engine_min: "1.1.0" },
      nodes: [
        {
          id: "run",
          type: "cli",
          action: { command: "true" },
          transitions: { success: "done" },
        },
      ],
    }),
  );

  return target;
}

it("keeps both projects progressing while an HTTP fetch is held, releases on shutdown, then bounds retries after unarchive", async () => {
  const db = database.db;
  const release = Promise.withResolvers<void>();
  const server = createServer(async (_request, response) => {
    await release.promise;
    response.writeHead(503).end();
  });
  const failedProject = await project("FAIR");
  const siblingProject = await project("NEXT");
  const controller = new AbortController();

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/unavailable.git`;

  await enqueue(failedProject, [
    {
      kind: "package",
      logicalId: "waiting",
      ordinal: 0,
      desired: { source: url, version: "v1" },
    },
  ]);
  const arrived = once(server, "request", {
    signal: AbortSignal.timeout(10_000),
  });
  const active = serviceDependency(db, controller.signal);

  try {
    await arrived;
    const flow = await flowDir("usable");
    const sibling: ProjectDependencyInput = {
      kind: "flow",
      logicalId: "usable",
      ordinal: 0,
      desired: { source: flow, version: "v1" },
    };

    await enqueue(failedProject, [sibling]);
    await enqueue(siblingProject, [sibling]);
    // Hold the first project's actual SQL row lock. The other consumer must
    // skip it even though the first project has a second due item.
    await db.transaction(async (tx) => {
      await tx
        .select()
        .from(projects)
        .where(eq(projects.id, failedProject))
        .for("update");
      expect(await serviceDependency(db, live)).toBe(true);
      expect((await attempt(siblingProject, "usable")).work.status).toBe(
        "succeeded",
      );
    });
    expect(await serviceDependency(db, live)).toBe(true);
    expect((await attempt(failedProject, "usable")).work.status).toBe(
      "succeeded",
    );
    await db
      .update(projects)
      .set({ archivedAt: new Date() })
      .where(eq(projects.id, failedProject));
    controller.abort();
    release.resolve();
    await active;
    const released = await attempt(failedProject, "waiting");

    expect(released.work).toMatchObject({
      status: "pending",
      claimToken: null,
      leaseExpiresAt: null,
    });
    expect(released.head.effectiveRevision).toBeNull();
    await db
      .update(attempts)
      .set({ dueAt: new Date(0) })
      .where(eq(attempts.id, released.work.id));
    expect(await claimDependency(db)).toBeNull();
    await db
      .update(projects)
      .set({ archivedAt: null })
      .where(eq(projects.id, failedProject));
    for (let run = 0; run < 4; run++) {
      expect(await serviceDependency(db, live)).toBe(true);
      const row = (await attempt(failedProject, "waiting")).work;

      expect(row).toMatchObject({
        reason: "source_unavailable",
        status: run === 3 ? "failed" : "pending",
        claimToken: null,
        leaseExpiresAt: null,
      });
      if (run < 3) {
        expect(
          row.dueAt.getTime() - row.updatedAt.getTime(),
        ).toBeGreaterThanOrEqual(1000 * 2 ** run);
        expect(row.checkpoint.retryCount).toBe(run + 1);
        expect(await claimDependency(db)).toBeNull();
        await db
          .update(attempts)
          .set({ dueAt: new Date(0) })
          .where(eq(attempts.id, row.id));
      }
    }
    expect(await claimDependency(db)).toBeNull();
  } finally {
    controller.abort();
    release.resolve();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await active;
  }
}, 30_000);

it.each(["earlier-ready", "later-effective"] as const)(
  "keeps the deterministic member owner when %s reaches attachment first",
  async (order) => {
    const db = database.db;
    const projectId = await project(
      order === "earlier-ready" ? "EARLY" : "LATE",
    );
    const ids = ["alpha", "beta"];
    const inputs: ProjectDependencyInput[] = [];

    for (const [ordinal, logicalId] of ids.entries()) {
      const name = logicalId + "-" + order;
      const dir = join(root, name);

      await mkdir(dir);
      await writeFile(
        join(dir, "maister-package.yaml"),
        `schemaVersion: 1\nname: ${name}\nflows: [{id: shared, path: shared}]\n`,
      );
      await flowDir(name + "/shared");
      inputs.push({
        kind: "package",
        logicalId,
        ordinal,
        desired: { source: dir, version: "v1" },
      });
    }
    await enqueue(projectId, inputs);
    const first = await attempt(projectId, "alpha");
    const second = await attempt(projectId, "beta");
    const owner = order === "earlier-ready" ? first : second;
    const refused = order === "earlier-ready" ? second : first;

    if (order === "earlier-ready") {
      // Both materials have a known competing member. Consumer two attempts
      // attachment while consumer one has already published its exact material.
      const claimed = await claimDependency(db);

      expect(claimed?.id).toBe(first.work.id);
      const install = await installPackageRevision({
        db,
        ...first.head.desired,
      });

      await db
        .update(attempts)
        .set({
          resolvedRevision: install.resolvedRevision,
          checkpoint: { installId: install.id },
        })
        .where(eq(attempts.id, first.work.id));
      expect(await serviceDependency(db, live)).toBe(true);
      expect((await attempt(projectId, "beta")).work).toMatchObject({
        status: "pending",
        reason: "earlier_member_pending",
      });
      await db
        .update(attempts)
        .set({ leaseExpiresAt: new Date(0) })
        .where(eq(attempts.id, first.work.id));
    } else {
      // An earlier unavailable source has no discoverable members. An effective
      // later sibling retains ownership even when the earlier source recovers.
      await db
        .update(attempts)
        .set({ dueAt: new Date(Date.now() + 600_000) })
        .where(eq(attempts.id, first.work.id));
    }
    expect(await serviceDependency(db, live)).toBe(true);
    const effective = (await attempt(projectId, owner.head.logicalId)).head
      .effectiveAttachmentId;

    expect(effective).toEqual(expect.any(String));
    await db
      .update(attempts)
      .set({ dueAt: new Date(0) })
      .where(eq(attempts.id, refused.work.id));
    expect(await serviceDependency(db, live)).toBe(true);
    expect(
      (await attempt(projectId, refused.head.logicalId)).work,
    ).toMatchObject({ status: "failed", reason: "flow_member_conflict" });
    expect(
      await db
        .select()
        .from(attachments)
        .where(eq(attachments.projectId, projectId)),
    ).toMatchObject([{ id: effective }]);
  },
);
