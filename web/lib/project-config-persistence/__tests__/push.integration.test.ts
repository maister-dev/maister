import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  symlink,
  readFile,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

import { git, gitResult } from "../git";
import {
  confirmProjectConfiguration,
  previewProjectConfiguration,
} from "../service";

import { projects, users } from "@/lib/db/schema";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

let database: StartedPostgresTestDb;
let root: string;
const actorUserId = randomUUID();
const priorWorktrees = process.env.MAISTER_WORKTREES_ROOT;

vi.mock("@/lib/db/client", async (original) => ({
  ...(await original<typeof import("@/lib/db/client")>()),
  getDb: () => database.db,
}));
const authorized = async (): Promise<void> => {};

beforeAll(async () => {
  database = await startMainPostgresTestDb({ databaseName: "config_push" });
  root = await mkdtemp(join(tmpdir(), "config-push-"));
  process.env.MAISTER_WORKTREES_ROOT = join(root, "private");
  await database.db.insert(users).values({
    id: actorUserId,
    email: `${actorUserId}@example.invalid`,
    role: "admin",
    accountStatus: "active",
    mustChangePassword: false,
  });
}, 180_000);
afterAll(async () => {
  if (priorWorktrees === undefined) delete process.env.MAISTER_WORKTREES_ROOT;
  else process.env.MAISTER_WORKTREES_ROOT = priorWorktrees;
  await database?.stop();
  await rm(root, { recursive: true, force: true });
});

async function seed() {
  const projectId = randomUUID();
  const repo = join(root, projectId);
  const remote = join(root, `${projectId}.git`);

  await mkdir(repo);
  await mkdir(remote);
  await git(remote, ["init", "--bare", "-b", "main"]);
  await git(repo, ["init", "-b", "main"]);
  await git(repo, ["config", "user.name", "Push Config"]);
  await git(repo, ["config", "user.email", "push@example.invalid"]);
  await git(repo, ["remote", "add", "origin", `file://${remote}`]);
  await writeFile(join(repo, "README.md"), "Existing project history\n");
  await git(repo, ["add", "README.md"]);
  await git(repo, ["commit", "-m", "existing project"]);
  const legacySha = (await git(repo, ["rev-parse", "HEAD"])).trim();

  await database.db.insert(projects).values({
    id: projectId,
    slug: `p-${projectId}`,
    name: "Push",
    repoPath: repo,
    taskKey: `PS${projectId.slice(0, 8).toUpperCase()}`,
  });
  const preview = await previewProjectConfiguration(
    database.db,
    projectId,
    actorUserId,
  );

  if (preview.kind !== "ready") throw new Error("Expected ready save");
  const identity = { id: preview.previewId, projectId, actorUserId };
  const receipt = await confirmProjectConfiguration(
    database.db,
    identity,
    authorized,
  );

  return { repo, remote, identity, receipt, legacySha };
}

it("IT-CPC-05: separate push includes the reviewed outgoing range and excludes a later local commit", async () => {
  const { previewConfigurationPush, confirmConfigurationPush } =
    await import("../push");
  const { repo, remote, identity, receipt, legacySha } = await seed();
  const review = await previewConfigurationPush(
    database.db,
    identity,
    authorized,
  );

  expect(review.outgoingShas).toEqual([legacySha, receipt.committedSha]);
  await writeFile(join(repo, "later.txt"), "owner work\n");
  await git(repo, ["add", "later.txt"]);
  await git(repo, ["commit", "-m", "later owner work"]);
  const later = (await git(repo, ["rev-parse", "HEAD"])).trim();
  const result = await confirmConfigurationPush(
    database.db,
    identity,
    review.pushPreviewId,
    authorized,
  );

  expect(result).toMatchObject({
    state: "succeeded",
    commitSha: receipt.committedSha,
    localCommitPreserved: true,
    cleanupState: "complete",
  });
  expect((await git(remote, ["rev-parse", "main"])).trim()).toBe(
    receipt.committedSha,
  );
  expect((await git(repo, ["rev-parse", "HEAD"])).trim()).toBe(later);
  expect(
    await confirmConfigurationPush(
      database.db,
      identity,
      review.pushPreviewId,
      authorized,
    ),
  ).toEqual(result);
});

it("IT-CPC-05: failed push preserves the local commit, delegates original hook stdin/argv and retries only with a fresh review", async () => {
  const { previewConfigurationPush, confirmConfigurationPush } =
    await import("../push");
  const { repo, remote, identity, receipt } = await seed();
  const hook = join(repo, ".git", "hooks", "pre-push");
  const observed = join(repo, ".git", "push-observed");

  await writeFile(
    hook,
    `#!/bin/sh\nprintf '%s\\n%s\\n' "$1" "$2" > '${observed}'\ncat >> '${observed}'\nexit 1\n`,
    { mode: 0o700 },
  );
  const review = await previewConfigurationPush(
    database.db,
    identity,
    authorized,
  );
  const failed = await confirmConfigurationPush(
    database.db,
    identity,
    review.pushPreviewId,
    authorized,
  );

  expect(failed).toMatchObject({ state: "failed", localCommitPreserved: true });
  expect(await readFile(observed, "utf8")).toContain(
    `${receipt.committedSha} refs/heads/main ${"0".repeat(40)}`,
  );
  expect((await git(repo, ["rev-parse", "HEAD"])).trim()).toBe(
    receipt.committedSha,
  );
  await unlink(hook);
  expect(
    await confirmConfigurationPush(
      database.db,
      identity,
      review.pushPreviewId,
      authorized,
    ),
  ).toEqual(failed);
  const retry = await previewConfigurationPush(
    database.db,
    identity,
    authorized,
  );

  expect(retry.pushPreviewId).not.toBe(review.pushPreviewId);
  expect(
    await confirmConfigurationPush(
      database.db,
      identity,
      retry.pushPreviewId,
      authorized,
    ),
  ).toMatchObject({ state: "succeeded" });
  expect((await git(remote, ["rev-parse", "main"])).trim()).toBe(
    receipt.committedSha,
  );
  await database.db
    .update(projects)
    .set({ name: "Next independent save" })
    .where(eq(projects.id, identity.projectId));
  expect(
    (
      await previewProjectConfiguration(
        database.db,
        identity.projectId,
        actorUserId,
      )
    ).kind,
  ).toBe("ready");
});

it("IT-CPC-05: changed origin refuses the old push review without touching either remote", async () => {
  const { previewConfigurationPush, confirmConfigurationPush } =
    await import("../push");
  const { repo, remote, identity } = await seed();
  const review = await previewConfigurationPush(
    database.db,
    identity,
    authorized,
  );
  const other = join(root, `${randomUUID()}.git`);

  await mkdir(other);
  await git(other, ["init", "--bare", "-b", "main"]);
  await git(repo, ["remote", "set-url", "origin", `file://${other}`]);
  expect(
    await confirmConfigurationPush(
      database.db,
      identity,
      review.pushPreviewId,
      authorized,
    ),
  ).toMatchObject({ state: "stale", reason: "push_review_stale" });
  expect(await gitResult(remote, ["show-ref", "--heads"])).toMatchObject({
    code: 1,
    stdout: "",
  });
  expect(await gitResult(other, ["show-ref", "--heads"])).toMatchObject({
    code: 1,
    stdout: "",
  });
});

it("IT-CPC-05/10: lost DB acknowledgement after remote success recovers by observation without a second push", async () => {
  const {
    previewConfigurationPush,
    confirmConfigurationPush,
    recoverConfigurationPushes,
  } = await import("../push");
  const { repo, remote, identity, receipt } = await seed();
  const count = join(root, `${identity.id}-received`);

  await writeFile(
    join(remote, "hooks", "post-receive"),
    `#!/bin/sh\necho received >> '${count}'\n`,
    { mode: 0o700 },
  );
  const review = await previewConfigurationPush(
    database.db,
    identity,
    authorized,
  );

  await database.pool.query(
    `CREATE FUNCTION config_push_ack_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id='${review.pushPreviewId}' AND NEW.state='succeeded' THEN RAISE EXCEPTION 'injected push receipt outage' USING ERRCODE='40001'; END IF; RETURN NEW; END; $$`,
  );
  await database.pool.query(
    "CREATE TRIGGER config_push_ack_fault BEFORE UPDATE ON project_config_push_intents FOR EACH ROW EXECUTE FUNCTION config_push_ack_fault()",
  );
  let nextCommittedSha = receipt.committedSha;

  try {
    await expect(
      confirmConfigurationPush(
        database.db,
        identity,
        review.pushPreviewId,
        authorized,
      ),
    ).rejects.toMatchObject({
      code: "EXECUTOR_UNAVAILABLE",
      details: { reason: "recovery_required" },
    });
    expect((await git(remote, ["rev-parse", "main"])).trim()).toBe(
      receipt.committedSha,
    );
    await database.db
      .update(projects)
      .set({ name: "Allowed while push unknown" })
      .where(eq(projects.id, identity.projectId));
    const next = await previewProjectConfiguration(
      database.db,
      identity.projectId,
      actorUserId,
    );

    expect(next.kind).toBe("ready");
    if (next.kind !== "ready")
      throw new Error("Expected independent local save");
    nextCommittedSha = (
      await confirmProjectConfiguration(
        database.db,
        { ...identity, id: next.previewId },
        authorized,
      )
    ).committedSha;
  } finally {
    await database.pool.query(
      "DROP TRIGGER config_push_ack_fault ON project_config_push_intents",
    );
    await database.pool.query("DROP FUNCTION config_push_ack_fault()");
  }
  await recoverConfigurationPushes(database.db, identity, authorized);
  expect(
    await confirmConfigurationPush(
      database.db,
      identity,
      review.pushPreviewId,
      authorized,
    ),
  ).toMatchObject({ state: "succeeded", cleanupState: "complete" });
  expect(await readFile(count, "utf8")).toBe("received\n");
  expect((await git(repo, ["rev-parse", "HEAD"])).trim()).toBe(
    nextCommittedSha,
  );
});

it("IT-CPC-10: a fresh web process repairs the accepted push after owner death at the remote acknowledgement receipt", async () => {
  const { previewConfigurationPush, confirmConfigurationPush } =
    await import("../push");
  const { repo, remote, identity, receipt } = await seed();
  const count = join(root, `${identity.id}-process-received`);

  await writeFile(
    join(remote, "hooks", "post-receive"),
    `#!/bin/sh\necho received >> '${count}'\n`,
    { mode: 0o700 },
  );
  const review = await previewConfigurationPush(
    database.db,
    identity,
    authorized,
  );
  const lock = await database.pool.connect();
  let waiter: number | undefined;
  const children: Array<{
    child: ChildProcess;
    exited: Promise<unknown>;
    output: () => string;
  }> = [];
  const launch = (fixture: string, args: string[]) => {
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

    child.stdout?.on("data", (chunk) => {
      output = (output + String(chunk)).slice(-65536);
    });
    child.stderr?.on("data", (chunk) => {
      output = (output + String(chunk)).slice(-65536);
    });
    const fixtureChild = {
      child,
      exited: once(child, "close"),
      output: () => output,
    };

    children.push(fixtureChild);

    return fixtureChild;
  };

  await lock.query("SELECT pg_advisory_lock(261030, 3)");
  try {
    await database.pool.query(
      `CREATE FUNCTION config_push_owner_barrier() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id='${review.pushPreviewId}' AND NEW.state='succeeded' THEN PERFORM pg_advisory_xact_lock(261030,3); END IF; RETURN NEW; END; $$`,
    );
    await database.pool.query(
      "CREATE TRIGGER config_push_owner_barrier BEFORE UPDATE ON project_config_push_intents FOR EACH ROW EXECUTE FUNCTION config_push_owner_barrier()",
    );
    const owner = launch("config-push-owner", [
      identity.id,
      identity.projectId,
      actorUserId,
      review.pushPreviewId,
    ]);

    await expect
      .poll(
        async () => {
          if (owner.child.exitCode !== null || owner.child.signalCode !== null)
            throw new Error(owner.output());
          const waiting = await database.pool.query<{ pid: number }>(
            "SELECT pid FROM pg_locks WHERE locktype='advisory' AND classid=261030 AND objid=3 AND NOT granted",
          );

          waiter = waiting.rows[0]?.pid;

          return waiting.rows.length;
        },
        { timeout: 30_000, interval: 25 },
      )
      .toBe(1);
    expect((await git(remote, ["rev-parse", "main"])).trim()).toBe(
      receipt.committedSha,
    );
    await expect(
      confirmConfigurationPush(
        database.db,
        identity,
        review.pushPreviewId,
        authorized,
      ),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      details: { reason: "recovery_required" },
    });
    owner.child.kill("SIGKILL");
    await owner.exited;
    await database.pool.query("SELECT pg_terminate_backend($1)", [waiter]);
    waiter = undefined;
    await lock.query("SELECT pg_advisory_unlock(261030,3)");
    await database.pool.query(
      "DROP TRIGGER config_push_owner_barrier ON project_config_push_intents",
    );
    await database.pool.query("DROP FUNCTION config_push_owner_barrier()");
    const restarted = launch("config-startup-recovery", []);

    await restarted.exited;
    expect(restarted.child.exitCode, restarted.output()).toBe(0);
    expect(
      await confirmConfigurationPush(
        database.db,
        identity,
        review.pushPreviewId,
        authorized,
      ),
    ).toMatchObject({ state: "succeeded", cleanupState: "complete" });
    expect(await readFile(count, "utf8")).toBe("received\n");
    expect((await git(repo, ["rev-parse", "HEAD"])).trim()).toBe(
      receipt.committedSha,
    );
  } finally {
    for (const fixture of children) {
      if (fixture.child.exitCode === null && fixture.child.signalCode === null)
        fixture.child.kill("SIGKILL");
      await fixture.exited;
    }
    if (waiter !== undefined)
      await database.pool.query("SELECT pg_terminate_backend($1)", [waiter]);
    await lock.query("SELECT pg_advisory_unlock(261030,3)");
    lock.release();
    await database.pool.query(
      "DROP TRIGGER IF EXISTS config_push_owner_barrier ON project_config_push_intents",
    );
    await database.pool.query(
      "DROP FUNCTION IF EXISTS config_push_owner_barrier()",
    );
  }
});

it("IT-CPC-05: expiry prunes only unused private push files without a remote update", async () => {
  const {
    previewConfigurationPush,
    confirmConfigurationPush,
    pruneConfigurationPushReviews,
  } = await import("../push");
  const { repo, remote, identity, receipt } = await seed();
  let review: Awaited<ReturnType<typeof previewConfigurationPush>>;

  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now() - 11 * 60_000);
  try {
    review = await previewConfigurationPush(database.db, identity, authorized);
  } finally {
    vi.useRealTimers();
  }
  await pruneConfigurationPushReviews(database.db);
  expect(
    await confirmConfigurationPush(
      database.db,
      identity,
      review.pushPreviewId,
      authorized,
    ),
  ).toMatchObject({ state: "stale", cleanupState: "complete" });
  expect(await gitResult(remote, ["show-ref", "--heads"])).toMatchObject({
    code: 1,
    stdout: "",
  });
  expect((await git(repo, ["rev-parse", "HEAD"])).trim()).toBe(
    receipt.committedSha,
  );
});

it("IT-CPC-05: server compare-and-swap refuses a remote change after the reviewed pre-push baseline", async () => {
  const { previewConfigurationPush, confirmConfigurationPush } =
    await import("../push");
  const { repo, remote, identity, receipt } = await seed();

  await git(repo, [
    "push",
    "origin",
    `${receipt.committedSha}:refs/heads/main`,
  ]);
  await database.db
    .update(projects)
    .set({ name: "Second save" })
    .where(eq(projects.id, identity.projectId));
  const next = await previewProjectConfiguration(
    database.db,
    identity.projectId,
    actorUserId,
  );

  if (next.kind !== "ready") throw new Error("Expected a second save");
  const nextIdentity = { ...identity, id: next.previewId };
  const second = await confirmProjectConfiguration(
    database.db,
    nextIdentity,
    authorized,
  );
  const tree = (
    await git(repo, ["rev-parse", `${receipt.committedSha}^{tree}`])
  ).trim();
  const rival = (
    await git(repo, [
      "commit-tree",
      tree,
      "-p",
      receipt.committedSha!,
      "-m",
      "Concurrent remote owner",
    ])
  ).trim();

  await git(remote, [
    "fetch",
    "--no-write-fetch-head",
    `file://${repo}`,
    rival,
  ]);
  await writeFile(
    join(repo, ".git", "hooks", "pre-push"),
    `#!/bin/sh\ngit --git-dir='${remote}' update-ref refs/heads/main ${rival} ${receipt.committedSha}\n`,
    { mode: 0o700 },
  );
  const review = await previewConfigurationPush(
    database.db,
    nextIdentity,
    authorized,
  );

  expect(review.remoteBase).toBe(receipt.committedSha);
  expect(
    await confirmConfigurationPush(
      database.db,
      nextIdentity,
      review.pushPreviewId,
      authorized,
    ),
  ).toMatchObject({ state: "failed", localCommitPreserved: true });
  expect((await git(remote, ["rev-parse", "main"])).trim()).toBe(rival);
  expect((await git(repo, ["rev-parse", "HEAD"])).trim()).toBe(
    second.committedSha,
  );
});

it("IT-CPC-05: a direct Git URL rewrite is captured once while chained rewriting refuses before issuance", async () => {
  const { previewConfigurationPush, confirmConfigurationPush } =
    await import("../push");
  const { repo, remote, identity, receipt } = await seed();

  await git(repo, [
    "config",
    `url.file://${remote}.insteadOf`,
    "config-test://project",
  ]);
  await git(repo, ["remote", "set-url", "origin", "config-test://project"]);
  const review = await previewConfigurationPush(
    database.db,
    identity,
    authorized,
  );

  expect(review.url).toBe(`file://${remote}`);
  expect(
    await confirmConfigurationPush(
      database.db,
      identity,
      review.pushPreviewId,
      authorized,
    ),
  ).toMatchObject({ state: "succeeded" });
  expect((await git(remote, ["rev-parse", "main"])).trim()).toBe(
    receipt.committedSha,
  );
  await git(repo, [
    "config",
    "url.file:///unexpected-remote.insteadOf",
    `file://${remote}`,
  ]);
  await expect(
    previewConfigurationPush(database.db, identity, authorized),
  ).rejects.toMatchObject({
    code: "CONFLICT",
    details: { reason: "push_review_stale" },
  });
});

it("IT-CPC-05: canonical symlink hooks and explicitly disabled hooks keep normal Git behavior", async () => {
  const { previewConfigurationPush, confirmConfigurationPush } =
    await import("../push");
  const { repo, identity } = await seed();
  const hook = join(repo, ".git", "shared-pre-push");

  await writeFile(hook, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  await symlink("../shared-pre-push", join(repo, ".git", "hooks", "pre-push"));
  const review = await previewConfigurationPush(
    database.db,
    identity,
    authorized,
  );

  expect(
    await confirmConfigurationPush(
      database.db,
      identity,
      review.pushPreviewId,
      authorized,
    ),
  ).toMatchObject({ state: "succeeded" });
  await git(repo, ["config", "core.hooksPath", "/dev/null"]);
  const noHookReview = await previewConfigurationPush(
    database.db,
    identity,
    authorized,
  );

  expect(
    await confirmConfigurationPush(
      database.db,
      identity,
      noHookReview.pushPreviewId,
      authorized,
    ),
  ).toMatchObject({ state: "succeeded" });
});

it("IT-CPC-05: missing origin is an actionable configuration refusal without a remote request", async () => {
  const { previewConfigurationPush } = await import("../push");
  const { repo, identity } = await seed();

  await git(repo, ["remote", "remove", "origin"]);
  await expect(
    previewConfigurationPush(database.db, identity, authorized),
  ).rejects.toMatchObject({
    code: "CONFLICT",
    details: { reason: "push_review_stale" },
  });
});
