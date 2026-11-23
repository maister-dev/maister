import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, expect, it } from "vitest";

import { resubmitDependency } from "../commands";
import { localDirectoryContentDigest } from "../content-digest";
import {
  authorizeDependencySetupRecovery,
  runMaterialSetup,
  withDependencySetupContext,
} from "../setup";
import { claimDependency } from "../claims";
import { serviceDependency } from "../worker";

import * as schema from "@/lib/db/schema";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";
import {
  projectDependencyAttempts as attempts,
  projectDependencyDeclarations as declarations,
  projects,
  users,
} from "@/lib/db/schema";
import { projectDependencySetupReceipts as receipts } from "@/lib/db/schema";

let database: StartedPostgresTestDb;

beforeAll(async () => {
  database = await startMainPostgresTestDb({
    databaseName: "dependency_worker",
  });
}, 180_000);
afterAll(async () => {
  await database?.stop();
});

async function seedRequest(archivedAt: Date | null, capability?: string) {
  const db = drizzle(database.pool, { schema });
  const actor = randomUUID();

  await db.insert(users).values({
    id: actor,
    email: actor + "@test.invalid",
    role: capability ? "admin" : "member",
    mustChangePassword: false,
    accountStatus: "active",
  });
  const projectId = randomUUID();

  await db.insert(projects).values({
    id: projectId,
    slug: projectId,
    name: "Worker",
    repoPath: "/tmp/" + projectId,
    taskKey: "W" + randomUUID().slice(0, 8).toUpperCase(),
    archivedAt,
  });
  const declarationId = randomUUID();
  const desired = {
    source: capability ?? "/unreachable-package",
    version: "local",
  };

  await db.insert(declarations).values({
    id: declarationId,
    projectId,
    logicalId: "unreachable",
    kind: capability ? "capability_import" : "package",
    ordinal: 0,
    desired,
  });
  const id = randomUUID();

  await db.insert(attempts).values({
    id,
    projectId,
    declarationId,
    generation: 1,
    attemptNo: 1,
    actorUserId: actor,
    desired,
  });

  return { projectId, declarationId, id, actor, desired };
}

it("reclaims work after loss before dispatch, ignores archived projects and records a revoked actor without fetching", async () => {
  const db = drizzle(database.pool, { schema });
  const { id, projectId } = await seedRequest(new Date());

  expect(await claimDependency(db)).toBeNull();
  await db
    .update(projects)
    .set({ archivedAt: null })
    .where(eq(projects.id, projectId));
  const original = await claimDependency(db);

  expect(original?.id).toBe(id);
  expect(await claimDependency(db)).toBeNull();
  await db
    .update(attempts)
    .set({ leaseExpiresAt: new Date(0) })
    .where(eq(attempts.id, id));
  expect(await serviceDependency(db, new AbortController().signal)).toBe(true);
  expect(
    await db.select().from(attempts).where(eq(attempts.id, id)),
  ).toMatchObject([
    { status: "failed", reason: "authority_revoked", claimToken: null },
  ]);
});

it("retires a superseded expired claim before claiming a corrected generation", async () => {
  const db = drizzle(database.pool, { schema });
  const request = await seedRequest(null);
  const [head] = await db
    .select()
    .from(declarations)
    .where(eq(declarations.id, request.declarationId));
  const [prior] = await db
    .select()
    .from(attempts)
    .where(eq(attempts.id, request.id));

  await db
    .update(attempts)
    .set({
      status: "running",
      claimToken: randomUUID(),
      leaseExpiresAt: new Date(0),
    })
    .where(eq(attempts.id, prior.id));
  const desired = { ...head.desired, version: "corrected" };

  await db
    .update(declarations)
    .set({ generation: 2, desired })
    .where(eq(declarations.id, head.id));
  const [replacement] = await db
    .insert(attempts)
    .values({
      projectId: head.projectId,
      declarationId: head.id,
      generation: 2,
      attemptNo: 1,
      actorUserId: prior.actorUserId,
      desired,
    })
    .returning();
  const claim = await claimDependency(db);

  expect(claim?.id).toBe(replacement.id);
  expect(
    await db.select().from(attempts).where(eq(attempts.id, prior.id)),
  ).toMatchObject([
    { status: "failed", reason: "superseded", claimToken: null },
  ]);
});

it("ignores source markers, retains exact setup completion and fences an uncertain dispatch", async () => {
  const db = drizzle(database.pool, { schema });
  const dir = await mkdtemp(join(tmpdir(), "worker-setup-"));

  try {
    await writeFile(join(dir, ".maister-setup-done"), "from-source");
    await writeFile(join(dir, "setup.sh"), "echo setup >> count\n");
    const args = {
      db,
      kind: "capability" as const,
      target: dir,
      revision: "f".repeat(40),
      contentWitness: await localDirectoryContentDigest(dir),
    };

    expect(await runMaterialSetup(args)).toBe("done");
    expect(await runMaterialSetup(args)).toBe("done");
    const [row] = await db.select().from(receipts);

    await db
      .update(receipts)
      .set({ status: "running", ownerPid: 2147483647 })
      .where(eq(receipts.materialKey, row.materialKey));
    await expect(runMaterialSetup(args)).rejects.toMatchObject({
      details: { reason: "setup_uncertain" },
    });
    expect(await readFile(join(dir, "count"), "utf8")).toBe("setup\n");
    const source = await seedRequest(null);

    await db
      .update(attempts)
      .set({
        status: "recovery_required",
        stage: "setup",
        reason: "setup_uncertain",
        resolvedRevision: args.revision,
        memberRef: "capability:bundle",
        checkpoint: { setupMaterialKey: row.materialKey },
      })
      .where(eq(attempts.id, source.id));
    expect(
      await db.transaction((tx) =>
        authorizeDependencySetupRecovery(tx, source.id),
      ),
    ).toBe("rerun");
    await expect(runMaterialSetup(args)).rejects.toMatchObject({
      details: { reason: "setup_owner_live" },
    });
    await withDependencySetupContext({ db, recoveryOf: source.id }, () =>
      runMaterialSetup(args),
    );
    expect(await runMaterialSetup(args)).toBe("done");
    expect(await readFile(join(dir, "count"), "utf8")).toBe("setup\nsetup\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("preserves a dispatched standalone setup on shutdown and permits only the exact recovery, even at a stable local path revision", async () => {
  const root = await mkdtemp(join(tmpdir(), "worker-interrupted-"));
  const dir = join(root, "bundle");
  const priorHome = process.env.HOME;
  const controller = new AbortController();
  const count = join(root, "calls");

  try {
    process.env.HOME = join(root, "home");
    await mkdir(dir);
    // The first shell records its effect and replaces itself with a blocking process.
    await writeFile(
      join(dir, "setup.sh"),
      `if [ -e "${count}" ]; then echo recovered >> "${count}"; else echo started >> "${count}"; exec sleep 40; fi\n`,
    );
    const db = drizzle(database.pool, { schema });
    const request = await seedRequest(null, dir);
    const running = serviceDependency(db, controller.signal);

    for (let i = 0; i < 180; i++) {
      if ((await readFile(count, "utf8").catch(() => "")) === "started\n")
        break;
      await delay(25);
    }
    controller.abort();
    expect(await running).toBe(true);
    const [uncertain] = await db
      .select()
      .from(attempts)
      .where(eq(attempts.id, request.id));

    expect(uncertain).toMatchObject({
      status: "recovery_required",
      stage: "setup",
      memberRef: "capability:unreachable",
    });
    const recovery = {
      expectedGeneration: 1,
      expectedAttempt: 1,
      memberRef: uncertain.memberRef!,
      resolvedRevision: uncertain.resolvedRevision!,
      action: "rerun_setup" as const,
    };
    const target = {
      projectId: request.projectId,
      declarationId: request.declarationId,
      actorUserId: request.actor,
    };

    expect(await resubmitDependency(db, target, recovery)).toMatchObject({
      attempt: 2,
    });
    expect(await resubmitDependency(db, target, recovery)).toMatchObject({
      attempt: 2,
    });
    await db
      .update(users)
      .set({ role: "member" })
      .where(eq(users.id, request.actor));
    expect(await serviceDependency(db, new AbortController().signal)).toBe(
      true,
    );
    const [refused] = await db
      .select()
      .from(attempts)
      .where(eq(attempts.retryOfAttemptId, request.id));

    expect(refused).toMatchObject({
      status: "failed",
      reason: "authority_revoked",
    });
    const takeover = randomUUID();

    await db.insert(users).values({
      id: takeover,
      email: takeover + "@test.invalid",
      role: "admin",
      accountStatus: "active",
      mustChangePassword: false,
    });
    expect(
      await resubmitDependency(
        db,
        { ...target, actorUserId: takeover },
        { expectedGeneration: 1, expectedAttempt: 2 },
      ),
    ).toMatchObject({ attempt: 3 });
    expect(await serviceDependency(db, new AbortController().signal)).toBe(
      true,
    );
    const [completed] = await db
      .select()
      .from(attempts)
      .where(eq(attempts.retryOfAttemptId, refused.id));

    expect(completed).toMatchObject({
      status: "succeeded",
      resolvedRevision: uncertain.resolvedRevision,
    });
    expect(await readFile(count, "utf8")).toBe("started\nrecovered\n");
    const other = await seedRequest(null, dir);

    await db
      .update(attempts)
      .set({
        checkpoint: { contentWitness: uncertain.checkpoint.contentWitness },
        resolvedRevision: uncertain.resolvedRevision,
      })
      .where(eq(attempts.id, other.id));
    await writeFile(join(dir, "data"), "changed bytes");
    await serviceDependency(db, new AbortController().signal);
    expect(
      await db.select().from(attempts).where(eq(attempts.id, other.id)),
    ).toMatchObject([{ status: "failed", reason: "revision_mismatch" }]);
    expect(await readFile(count, "utf8")).toBe("started\nrecovered\n");
  } finally {
    controller.abort();
    if (priorHome === undefined) delete process.env.HOME;
    else process.env.HOME = priorHome;
    await rm(root, { recursive: true, force: true });
  }
});
