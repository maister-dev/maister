import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, expect, it } from "vitest";

import { git } from "../git";
import { previewProjectConfiguration } from "../service";
import { findConfigOperation } from "../store";

import { projects, users } from "@/lib/db/schema";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

type FixtureChild = {
  child: ChildProcess;
  exited: Promise<unknown>;
  output: () => string;
};
let database: StartedPostgresTestDb;
let root: string;
const actorUserId = randomUUID();
const children: FixtureChild[] = [];
const priorWorktrees = process.env.MAISTER_WORKTREES_ROOT;

beforeAll(async () => {
  database = await startMainPostgresTestDb({
    databaseName: "config_owner_recovery",
  });
  root = await mkdtemp(join(tmpdir(), "config-owner-recovery-"));
  process.env.MAISTER_WORKTREES_ROOT = join(root, "private");
  await database.db.insert(users).values({
    id: actorUserId,
    email: `${actorUserId}@example.invalid`,
    role: "admin",
    accountStatus: "active",
    mustChangePassword: false,
  });
}, 180_000);

afterEach(async () => {
  for (const fixture of children.splice(0)) {
    if (fixture.child.exitCode === null && fixture.child.signalCode === null)
      fixture.child.kill("SIGKILL");
    await fixture.exited;
  }
});

afterAll(async () => {
  if (priorWorktrees === undefined) delete process.env.MAISTER_WORKTREES_ROOT;
  else process.env.MAISTER_WORKTREES_ROOT = priorWorktrees;
  try {
    await database?.stop();
  } finally {
    if (root) await rm(root, { recursive: true, force: true });
  }
});

function launch(fixture: string, args: string[]): FixtureChild {
  const child = spawn(
    process.execPath,
    [
      "--import",
      "./scripts/_register-shim.mjs",
      "--import",
      "tsx",
      `lib/project-config-persistence/__tests__/fixtures/${fixture}.ts`,
      ...args,
    ],
    {
      cwd: process.cwd(),
      env: { ...process.env, DB_URL: database.databaseUrl },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";

  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    output = (output + chunk).slice(-64 * 1024);
  });
  child.stderr?.on("data", (chunk: string) => {
    output = (output + chunk).slice(-64 * 1024);
  });
  const result = { child, exited: once(child, "close"), output: () => output };

  children.push(result);

  return result;
}

it.each(["prepared", "committed"] as const)(
  "IT-CPC-10: a fresh process recovers the same SHA after owner death at %s receipt",
  async (stage) => {
    const projectId = randomUUID();
    const repo = join(root, projectId);

    await mkdir(repo);
    await git(repo, ["init", "-b", "main"]);
    await git(repo, ["config", "user.name", "Recovery Test"]);
    await git(repo, ["config", "user.email", "recovery@example.invalid"]);
    await database.db.insert(projects).values({
      id: projectId,
      slug: `recover-${projectId}`,
      name: "Recovery",
      repoPath: repo,
      taskKey: `RC${projectId.slice(0, 8).toUpperCase()}`,
    });
    const preview = await previewProjectConfiguration(
      database.db,
      projectId,
      actorUserId,
    );

    if (preview.kind !== "ready")
      throw new Error("Expected a ready fixture review");
    const key = stage === "prepared" ? 1 : 2;
    const lock = await database.pool.connect();
    let waiter: number | undefined;

    await lock.query("SELECT pg_advisory_lock(261030, $1)", [key]);
    try {
      await database.pool.query(
        `CREATE FUNCTION config_owner_death_barrier() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id='${preview.previewId}' AND NEW.state='${stage}' THEN PERFORM pg_advisory_xact_lock(261030, ${key}); END IF; RETURN NEW; END; $$`,
      );
      await database.pool.query(
        "CREATE TRIGGER config_owner_death_barrier BEFORE UPDATE ON project_config_persist_operations FOR EACH ROW EXECUTE FUNCTION config_owner_death_barrier()",
      );
      const owner = launch("config-operation-owner", [
        preview.previewId,
        projectId,
        actorUserId,
      ]);

      await expect
        .poll(
          async () => {
            if (
              owner.child.exitCode !== null ||
              owner.child.signalCode !== null
            )
              throw new Error(owner.output());
            const waiting = await database.pool.query<{ pid: number }>(
              "SELECT pid FROM pg_locks WHERE locktype='advisory' AND classid=261030 AND objid=$1 AND NOT granted",
              [key],
            );

            waiter = waiting.rows[0]?.pid;

            return waiting.rows.length;
          },
          { timeout: 30_000, interval: 25 },
        )
        .toBe(1);
      const sha = (
        await git(repo, [
          "rev-parse",
          `refs/maister/config-persist/${preview.previewId}`,
        ])
      ).trim();
      const ownership = JSON.parse(
        await readFile(
          join(repo, ".git", "maister-config-mutation.lock", "owner.json"),
          "utf8",
        ),
      ) as { processId: number; operationId: string };

      expect(ownership).toMatchObject({
        processId: owner.child.pid,
        operationId: preview.previewId,
      });
      const duplicate = launch("config-operation-owner", [
        preview.previewId,
        projectId,
        actorUserId,
      ]);

      await duplicate.exited;
      expect(duplicate.child.exitCode, duplicate.output()).toBe(1);
      expect(duplicate.output()).toContain('"reason":"operation_busy"');
      if (stage === "prepared") {
        await expect(
          database.pool.query(
            "UPDATE projects SET name='Concurrent edit' WHERE id=$1",
            [projectId],
          ),
        ).rejects.toMatchObject({ code: "55P03" });
      }
      owner.child.kill("SIGKILL");
      await owner.exited;
      // Retire only the backend proven to belong to the killed fixture's blocked statement.
      await database.pool.query("SELECT pg_terminate_backend($1)", [waiter]);
      await lock.query("SELECT pg_advisory_unlock(261030, $1)", [key]);
      await database.pool.query(
        "DROP TRIGGER config_owner_death_barrier ON project_config_persist_operations",
      );
      await database.pool.query("DROP FUNCTION config_owner_death_barrier()");
      const restarted = launch("config-startup-recovery", []);

      await restarted.exited;
      expect(restarted.child.exitCode, restarted.output()).toBe(0);
      expect(restarted.output()).toContain('"committed":1');
      expect(
        await findConfigOperation(database.db, {
          id: preview.previewId,
          projectId,
          actorUserId,
        }),
      ).toMatchObject({
        state: "committed",
        preparedSha: sha,
        committedSha: sha,
      });
      expect((await git(repo, ["rev-parse", "HEAD"])).trim()).toBe(sha);
      expect((await git(repo, ["rev-list", "--count", "HEAD"])).trim()).toBe(
        "1",
      );
      expect(await git(repo, ["status", "--porcelain=v1"])).toBe("");
    } finally {
      for (const fixture of children) {
        if (
          fixture.child.exitCode === null &&
          fixture.child.signalCode === null
        )
          fixture.child.kill("SIGKILL");
        await fixture.exited;
      }
      if (waiter !== undefined)
        await database.pool.query("SELECT pg_terminate_backend($1)", [waiter]);
      await lock.query("SELECT pg_advisory_unlock(261030, $1)", [key]);
      lock.release();
      await database.pool.query(
        "DROP TRIGGER IF EXISTS config_owner_death_barrier ON project_config_persist_operations",
      );
      await database.pool.query(
        "DROP FUNCTION IF EXISTS config_owner_death_barrier()",
      );
    }
  },
);

it("IT-CPC-10: owner death retains a proven index reservation until its committed-ref hook retires", async () => {
  const { createConnection } = await import("node:net");
  const { assertConfigGitOwnerRetired } = await import("../repository-lock");
  const { confirmProjectConfiguration } = await import("../service");
  const projectId = randomUUID();
  const repo = join(root, projectId);
  const marker = join(root, `${projectId}-reserved`);
  const socketPath = join(tmpdir(), `ci-${projectId.slice(0, 8)}.sock`);

  await mkdir(repo);
  await git(repo, ["init", "-b", "main"]);
  await git(repo, ["config", "user.name", "Reservation Recovery"]);
  await git(repo, ["config", "user.email", "reservation@example.invalid"]);
  const hooks = join(root, `reservation-hooks-${projectId}`);

  await mkdir(hooks);
  await writeFile(
    join(hooks, "reference-transaction"),
    `#!${process.execPath}\nconst fs=require('node:fs');const net=require('node:net');const input=fs.readFileSync(0,'utf8');if(process.argv[2]==='committed'&&input.split('\\n').some(line=>line.endsWith(' refs/heads/main'))){const server=net.createServer(socket=>{socket.end();server.close();});server.listen(${JSON.stringify(socketPath)},()=>fs.writeFileSync(${JSON.stringify(marker)},'reserved'));}\n`,
    { mode: 0o700 },
  );
  await git(repo, ["config", "core.hooksPath", hooks]);
  await database.db.insert(projects).values({
    id: projectId,
    slug: `reservation-${projectId}`,
    name: "Reservation",
    repoPath: repo,
    taskKey: `IR${projectId.slice(0, 8).toUpperCase()}`,
  });
  const preview = await previewProjectConfiguration(
    database.db,
    projectId,
    actorUserId,
  );

  if (preview.kind !== "ready")
    throw new Error("Expected a ready reservation review");
  const identity = { id: preview.previewId, projectId, actorUserId };
  const owner = launch("config-operation-owner", [
    identity.id,
    projectId,
    actorUserId,
  ]);
  let groups: number[] = [];
  const releaseHook = async (): Promise<void> => {
    await new Promise<void>((resolve, reject) => {
      const socket = createConnection(socketPath);

      socket.once("error", reject);
      socket.once("connect", () => {
        socket.end();
        resolve();
      });
    });
  };

  try {
    await expect
      .poll(
        async () => {
          if (owner.child.exitCode !== null || owner.child.signalCode !== null)
            throw new Error(owner.output());
          try {
            return await readFile(marker, "utf8");
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
            throw error;
          }
        },
        { timeout: 30_000, interval: 25 },
      )
      .toBe("reserved");
    const beforeLock = await readFile(join(repo, ".git", "index.lock"), "utf8");

    expect(beforeLock).toContain(identity.id);
    const recorded = JSON.parse(
      await readFile(
        join(repo, ".git", "maister-config-mutation.lock", "owner.json"),
        "utf8",
      ),
    ) as { groups: number[]; processId: number };

    expect(recorded.processId).toBe(owner.child.pid);
    groups = recorded.groups;
    const sha = (await git(repo, ["rev-parse", "HEAD"])).trim();

    owner.child.kill("SIGKILL");
    await owner.exited;
    await expect(
      confirmProjectConfiguration(database.db, identity, async () => {}),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      details: { reason: "operation_busy" },
    });
    expect(await readFile(join(repo, ".git", "index.lock"), "utf8")).toBe(
      beforeLock,
    );
    await releaseHook();
    await expect
      .poll(
        async () => {
          try {
            for (const group of groups)
              await assertConfigGitOwnerRetired(owner.child.pid!, group);

            return true;
          } catch (error) {
            if ((error as { code?: string }).code === "CONFLICT") return false;
            throw error;
          }
        },
        { timeout: 30_000, interval: 50 },
      )
      .toBe(true);
    const restarted = launch("config-startup-recovery", []);

    await restarted.exited;
    expect(restarted.child.exitCode, restarted.output()).toBe(0);
    expect(await findConfigOperation(database.db, identity)).toMatchObject({
      state: "committed",
      committedSha: sha,
    });
    await expect(
      readFile(join(repo, ".git", "index.lock")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(await git(repo, ["status", "--porcelain=v1"])).toBe("");
  } finally {
    if (owner.child.exitCode === null && owner.child.signalCode === null)
      owner.child.kill("SIGKILL");
    await owner.exited;
    await releaseHook().catch((error) => {
      if (
        !["ENOENT", "ECONNREFUSED"].includes(
          (error as NodeJS.ErrnoException).code ?? "",
        )
      )
        throw error;
    });
    await expect
      .poll(
        async () => {
          try {
            for (const group of groups)
              await assertConfigGitOwnerRetired(owner.child.pid!, group);

            return true;
          } catch (error) {
            if ((error as { code?: string }).code === "CONFLICT") return false;
            throw error;
          }
        },
        { timeout: 30_000, interval: 50 },
      )
      .toBe(true);
    await rm(socketPath, { force: true });
  }
});
