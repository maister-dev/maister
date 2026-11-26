import { setTimeout as delay } from "node:timers/promises";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

import { editDependency, resubmitDependency } from "../commands";
import {
  localDirectoryContentDigest,
  materialLayoutDigest,
} from "../content-digest";
import {
  authorizeDependencySetupRecovery,
  runMaterialSetup,
  withDependencySetupContext,
} from "../setup";
import { publishMaterial } from "../material";
import { claimDependency } from "../claims";
import { physicalSetupKey } from "../setup-identity";
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

async function seedRequest(
  archivedAt: Date | null,
  capability?: string,
  logicalId = "unreachable",
) {
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
    logicalId,
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

it("records no dispatch if shutdown wins during physical setup authorization", async () => {
  const db = database.db;
  const target = await mkdtemp(join(tmpdir(), "undispatched-setup-"));
  const controller = new AbortController();
  const setup = { db, target, kind: "flow" as const, revision: randomUUID() };
  const key = physicalSetupKey({ ...setup, target: await realpath(target) });
  try {
    await writeFile(join(target, "setup.sh"), "echo called >> count\n");
    let rejected: Promise<unknown> | undefined;
    await db.transaction(async (tx) => {
      const {
        rows: [{ pid }],
      } = await tx.execute<{ pid: number }>(
        sql`select pg_backend_pid() as pid, pg_advisory_xact_lock(hashtextextended(${key},0))`,
      );
      rejected = runMaterialSetup({ ...setup, signal: controller.signal }).then(
        () => null,
        (error: unknown) => error,
      );
      await vi.waitFor(async () => {
        const { rows } = await db.execute(
          sql`select 1 from pg_stat_activity where ${pid}::int=any(pg_blocking_pids(pid))`,
        );
        expect(rows).toHaveLength(1);
      });
      controller.abort();
    });
    expect(await rejected).toMatchObject({ name: "AbortError" });
    expect(
      await db.select().from(receipts).where(eq(receipts.materialKey, key)),
    ).toEqual([]);
    expect(await runMaterialSetup(setup)).toBe("done");
    expect(await readFile(join(target, "count"), "utf8")).toBe("called\n");
  } finally {
    await rm(target, { recursive: true, force: true });
  }
});

it("keeps the physical setup slot when a Flow setup rewrites its own script", async () => {
  const db = database.db;
  const dir = await mkdtemp(join(tmpdir(), "worker-self-rewrite-"));

  try {
    await writeFile(
      join(dir, "setup.sh"),
      "echo first >> count\necho 'echo replay >> count' > setup.sh\n",
    );
    const args = {
      db,
      kind: "flow" as const,
      target: dir,
      revision: randomUUID(),
    };

    expect(await runMaterialSetup(args)).toBe("done");
    expect(await runMaterialSetup(args)).toBe("done");
    expect(await readFile(join(dir, "count"), "utf8")).toBe("first\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("binds an unchanged legacy receipt and refuses an unidentifiable historical dispatch", async () => {
  const db = database.db;
  const dir = await realpath(await mkdtemp(join(tmpdir(), "legacy-setup-")));
  const revision = randomUUID();
  const bytes = "echo unexpected >> count\n";
  const key = createHash("sha256")
    .update(JSON.stringify([dir, revision, revision, basename(dir)]))
    .update(bytes)
    .digest("hex");

  try {
    await db.insert(receipts).values({
      materialKey: key,
      status: "succeeded",
      claimToken: randomUUID(),
    });
    const setup = () =>
      runMaterialSetup({ db, target: dir, kind: "flow", revision });

    await writeFile(join(dir, "setup.sh"), "echo replaced >> count\n");
    await expect(setup()).rejects.toMatchObject({
      details: { reason: "legacy_setup_evidence_unmapped" },
    });
    // The unrelated new physical revision is independently publishable while
    // the retired/ambiguous slot above still has no matching script.
    const freshSource = join(dir, "fresh-source"),
      target = join(dir, "fresh-target");

    await mkdir(freshSource);
    await writeFile(join(freshSource, "setup.sh"), "echo ran > proof\n");
    const freshRevision = "d".repeat(40);
    const digest = await localDirectoryContentDigest(freshSource);

    await publishMaterial({
      source: freshSource,
      target,
      revision: freshRevision,
      digest,
      layoutDigest: await materialLayoutDigest(freshSource),
      hash: localDirectoryContentDigest,
    });
    expect(
      await runMaterialSetup({
        db,
        target,
        revision: freshRevision,
        kind: "capability",
        contentWitness: digest,
      }),
    ).toBe("done");
    expect(await readFile(join(target, "proof"), "utf8")).toBe("ran\n");
    await writeFile(join(dir, "setup.sh"), bytes);
    expect(await setup()).toBe("done");
    expect(
      (await db.select().from(receipts).where(eq(receipts.materialKey, key)))[0]
        ?.physicalKey,
    ).toMatch(/^[0-9a-f]{64}$/);
    await expect(readFile(join(dir, "count"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  } finally {
    await db.delete(receipts).where(eq(receipts.materialKey, key));
    await rm(dir, { recursive: true, force: true });
  }
});

it.each(["edit", "remove", "failed_recovery", "archive"] as const)(
  "allows another exact recovery after %s abandons an undispatched reservation",
  async (action) => {
    const db = database.db;
    const dir = await mkdtemp(join(tmpdir(), "reserved-setup-"));

    try {
      await writeFile(join(dir, "setup.sh"), "echo call >> count\n");
      const revision = randomUUID();
      const setup = () =>
        runMaterialSetup({ db, target: dir, kind: "flow", revision });
      let key = "";

      await withDependencySetupContext(
        {
          db,
          before: async (materialKey) => {
            key = materialKey;
          },
        },
        setup,
      );
      await db
        .update(receipts)
        .set({ status: "running", ownerPid: 2147483647 })
        .where(eq(receipts.materialKey, key));
      const first = await seedRequest(null);
      const second = await seedRequest(null);

      for (const request of [first, second])
        await db
          .update(attempts)
          .set({
            status: "recovery_required",
            stage: "setup",
            reason: "setup_uncertain",
            resolvedRevision: revision,
            memberRef: "flow:member",
            checkpoint: { setupMaterialKey: key },
          })
          .where(eq(attempts.id, request.id));
      const command = {
        expectedGeneration: 1,
        expectedAttempt: 1,
        memberRef: "flow:member",
        resolvedRevision: revision,
        action: "rerun_setup" as const,
      };
      const target = (request: typeof first) => ({
        projectId: request.projectId,
        declarationId: request.declarationId,
        actorUserId: request.actor,
      });

      await resubmitDependency(db, target(first), command);
      await expect(
        resubmitDependency(db, target(second), command),
      ).rejects.toMatchObject({ details: { reason: "setup_owner_live" } });
      if (action === "edit") {
        await editDependency(db, target(first), {
          expectedGeneration: 1,
          source: "/fixed-package",
          version: "local",
        });
      } else if (action === "remove") {
        await db
          .delete(declarations)
          .where(eq(declarations.id, first.declarationId));
      } else if (action === "failed_recovery") {
        await db
          .update(attempts)
          .set({
            status: "failed",
            stage: "resolve",
            reason: "authority_revoked",
          })
          .where(eq(attempts.retryOfAttemptId, first.id));
      } else {
        await db
          .update(projects)
          .set({ archivedAt: new Date() })
          .where(eq(projects.id, first.projectId));
      }
      await expect(setup()).rejects.toMatchObject({
        details: { reason: "setup_uncertain" },
      });
      await resubmitDependency(db, target(second), command);
      await withDependencySetupContext({ db, recoveryOf: second.id }, setup);
      expect(await readFile(join(dir, "count"), "utf8")).toBe("call\ncall\n");
      await db.delete(projects).where(eq(projects.id, first.projectId));
      await db.delete(projects).where(eq(projects.id, second.projectId));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);

it("preserves dotted memberRef diagnostics on setup failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "worker-dotted-ref-"));
  const dir = join(root, "org.bundle");
  const priorHome = process.env.HOME;
  const db = drizzle(database.pool, { schema });
  let projectId: string | undefined;

  try {
    process.env.HOME = join(root, "home");
    await mkdir(dir);
    await writeFile(join(dir, "setup.sh"), "exit 1\n");
    const request = await seedRequest(null, dir, "org.bundle");

    projectId = request.projectId;
    expect(
      await serviceDependency(db, new AbortController().signal, request.id),
    ).toBe(true);
    const [failed] = await db
      .select()
      .from(attempts)
      .where(eq(attempts.id, request.id));

    expect(failed).toMatchObject({
      status: "failed",
      stage: "setup",
      reason: "setup_failed",
      memberRef: "org.bundle",
    });
  } finally {
    if (projectId) await db.delete(projects).where(eq(projects.id, projectId));
    if (priorHome === undefined) delete process.env.HOME;
    else process.env.HOME = priorHome;
    await rm(root, { recursive: true, force: true });
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
