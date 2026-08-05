/**
 * ADR-157 (T32): the context-mount GC backstop. Reaps mounts at
 * `.maister/<slug>/runs/<runId>/context/<siblingSlug>` by PATH SHAPE — the only
 * cleanup that can reach the residual crash window where a mount was created but
 * its launch snapshot never committed. Covers the background-automation rules (durable
 * per-item marker, bounded retries with explicit backoff, poison-item policy)
 * plus the wiring-seam test that drives the REAL
 * `runSchedulerTick({jobKind: "system_sweep"})` claim→dispatch path.
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { eq } from "drizzle-orm";
import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  MAX_CONTEXT_MOUNT_GC_ATTEMPTS,
  runContextMountGcSweep,
  type ContextMountGcMarker,
} from "@/lib/gc/context-mount-gc";
import { runSchedulerTick } from "@/lib/scheduler/tick-service";
import { addDetachedWorktree, commitFile, listWorktrees } from "@/lib/worktree";
import { schema } from "@/test-support/graph-run-seed";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

vi.mock("@/lib/db/client", () => ({
  getDb: () => db,
  closeDb: async () => undefined,
}));

const execFileAsync = promisify(execFile);

let testDatabase: StartedPostgresTestDb;
let db: NodePgDatabase;

const createdPaths: string[] = [];

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "context_mount_gc_test",
  });
  db = testDatabase.db;
}, 180_000);

afterEach(async () => {
  await db.delete(schema.schedulerJobRuns);
  await db.delete(schema.schedulerJobs);
});

afterAll(async () => {
  await Promise.all(
    createdPaths.map((p) => rm(p, { recursive: true, force: true })),
  );
  await testDatabase?.stop();
});

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    maxBuffer: 16 * 1024 * 1024,
  });

  return stdout;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);

    return true;
  } catch {
    return false;
  }
}

type Fixture = {
  root: string;
  consumingSlug: string;
  siblingSlug: string;
  siblingRepo: string;
  runId: string;
  mountPath: string;
  markerPath: string;
};

async function seedProject(slug: string, repoPath: string): Promise<string> {
  const id = randomUUID();

  await db.insert(schema.projects).values({
    taskKey: `K${id.replaceAll("-", "").slice(0, 9).toUpperCase()}`,
    id,
    slug,
    name: slug,
    repoPath,
    mainBranch: "main",
    maisterYamlPath: "/tmp/m.yaml",
  });

  return id;
}

/**
 * A consuming project with one real detached sibling mount at
 * `<root>/.maister/<consumingSlug>/runs/<runId>/context/<siblingSlug>`. The
 * `runs` row is only inserted when `runStatus` is given — omitting it models the
 * residual crash window (mount on disk, no row anywhere).
 */
async function createMountFixture(
  opts: {
    runStatus?: string;
  } = {},
): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "maister-ctxgc-root-"));
  const siblingRepo = await mkdtemp(join(tmpdir(), "maister-ctxgc-sib-"));

  createdPaths.push(root, siblingRepo);

  await git(siblingRepo, "init", "-q", "-b", "main");
  await writeFile(join(siblingRepo, "README.md"), "sibling\n");
  await commitFile({
    repo: siblingRepo,
    file: "README.md",
    message: "sibling base",
  });

  const consumingRepo = await mkdtemp(join(tmpdir(), "maister-ctxgc-own-"));

  createdPaths.push(consumingRepo);

  const suffix = randomUUID().slice(0, 8);
  const consumingSlug = `own-${suffix}`;
  const siblingSlug = `sib-${suffix}`;
  const consumingProjectId = await seedProject(consumingSlug, consumingRepo);

  await seedProject(siblingSlug, siblingRepo);

  const runId = randomUUID();

  if (opts.runStatus) {
    const taskId = randomUUID();
    const flowId = randomUUID();

    await db.insert(schema.flows).values({
      id: flowId,
      projectId: consumingProjectId,
      flowRefId: "ctx",
      source: "github.com/x/y",
      version: "v1.0.0",
      installedPath: "/tmp/flows/ctx",
      manifest: { schemaVersion: 1, name: "ctx", nodes: [] },
      schemaVersion: 1,
    });
    await db.insert(schema.tasks).values({
      number: Math.trunc(Math.random() * 1e9) + 1,
      id: taskId,
      projectId: consumingProjectId,
      title: "t",
      prompt: "p",
      flowId,
    });
    await db.insert(schema.runs).values({
      id: runId,
      taskId,
      projectId: consumingProjectId,
      flowId,
      flowVersion: "v1.0.0",
      status: opts.runStatus,
    });
  }

  const contextDir = join(
    root,
    ".maister",
    consumingSlug,
    "runs",
    runId,
    "context",
  );

  await mkdir(contextDir, { recursive: true });

  const mountPath = join(contextDir, siblingSlug);

  await addDetachedWorktree({
    projectRepoPath: siblingRepo,
    worktreePath: mountPath,
    committish: (await git(siblingRepo, "rev-parse", "HEAD")).trim(),
  });

  return {
    root,
    consumingSlug,
    siblingSlug,
    siblingRepo,
    runId,
    mountPath,
    markerPath: join(contextDir, ".gc", `${siblingSlug}.json`),
  };
}

// `git worktree list` reports REALPATHS, and macOS tmpdirs live under the
// /var → /private/var symlink — so both sides are normalized before comparing.
async function realOf(p: string): Promise<string> {
  return realpath(p).catch(() => p);
}

async function siblingRegistrations(repoPath: string): Promise<string[]> {
  const worktrees = await listWorktrees(repoPath);

  return Promise.all(worktrees.map((w) => realOf(w.path)));
}

async function readMarker(p: string): Promise<ContextMountGcMarker> {
  return JSON.parse(await readFile(p, "utf8")) as ContextMountGcMarker;
}

describe("context mount GC backstop", () => {
  it("reaps an orphan whose owning run row never existed (the residual crash window)", async () => {
    const fx = await createMountFixture();

    const summary = await runContextMountGcSweep({ db, root: fx.root });

    expect(summary).toMatchObject({ scanned: 1, removed: 1, live: 0 });
    expect(await pathExists(fx.mountPath)).toBe(false);
    expect(await siblingRegistrations(fx.siblingRepo)).not.toContain(
      await realOf(fx.mountPath),
    );
  }, 120_000);

  it("reaps an orphan from a terminal (killed) run", async () => {
    const fx = await createMountFixture({ runStatus: "Crashed" });

    const summary = await runContextMountGcSweep({ db, root: fx.root });

    expect(summary).toMatchObject({ scanned: 1, removed: 1, live: 0 });
    expect(await siblingRegistrations(fx.siblingRepo)).not.toContain(
      await realOf(fx.mountPath),
    );
  }, 120_000);

  it("leaves a live run's mount alone", async () => {
    const running = await createMountFixture({ runStatus: "Running" });
    const runningSummary = await runContextMountGcSweep({
      db,
      root: running.root,
    });

    expect(runningSummary).toMatchObject({ scanned: 1, removed: 0, live: 1 });
    expect(await siblingRegistrations(running.siblingRepo)).toContain(
      await realOf(running.mountPath),
    );

    // `Review` is IN the live set: a rework can re-open a session that still
    // expects its mounts.
    const review = await createMountFixture({ runStatus: "Review" });
    const reviewSummary = await runContextMountGcSweep({
      db,
      root: review.root,
    });

    expect(reviewSummary).toMatchObject({ scanned: 1, removed: 0, live: 1 });

    // So is a parked orchestrator.
    const parked = await createMountFixture({
      runStatus: "WaitingOnChildren",
    });
    const parkedSummary = await runContextMountGcSweep({
      db,
      root: parked.root,
    });

    expect(parkedSummary).toMatchObject({ scanned: 1, removed: 0, live: 1 });
  }, 180_000);

  it("poison policy: a mount naming no active sibling project is permanently failed with evidence", async () => {
    const fx = await createMountFixture();

    await db
      .delete(schema.projects)
      .where(eq(schema.projects.slug, fx.siblingSlug));

    const first = await runContextMountGcSweep({ db, root: fx.root });

    expect(first).toMatchObject({ scanned: 1, removed: 0, poisoned: 1 });

    const marker = await readMarker(fx.markerPath);

    expect(marker.state).toBe("failed");
    expect(marker.attemptCount).toBe(1);
    expect(marker.nextRetryAt).toBeNull();
    expect(marker.lastErrorCode).toBe("sibling_project_absent");
    expect(marker.lastErrorMessage).toContain(fx.siblingSlug);

    // Permanently failed items are never re-attempted — they cannot starve the
    // rest of the scan.
    const second = await runContextMountGcSweep({ db, root: fx.root });

    expect(second).toMatchObject({ scanned: 1, skipped: 1, poisoned: 0 });
    expect((await readMarker(fx.markerPath)).attemptCount).toBe(1);
  }, 120_000);

  it("poison policy: a dir that is not a registered worktree of its sibling is permanently failed", async () => {
    const fx = await createMountFixture();
    const strayContext = join(
      fx.root,
      ".maister",
      fx.consumingSlug,
      "runs",
      randomUUID(),
      "context",
    );

    await mkdir(join(strayContext, fx.siblingSlug), { recursive: true });

    const summary = await runContextMountGcSweep({ db, root: fx.root });

    expect(summary.scanned).toBe(2);
    expect(summary.removed).toBe(1); // the real mount
    expect(summary.poisoned).toBe(1); // the stray dir

    const strayMarker = await readMarker(
      join(strayContext, ".gc", `${fx.siblingSlug}.json`),
    );

    expect(strayMarker.state).toBe("failed");
    expect(strayMarker.lastErrorCode).toBe("not_a_registered_worktree");
  }, 120_000);

  it("bounded retries with explicit backoff: a transient removal failure arms next_retry_at, then exhausts", async () => {
    const fx = await createMountFixture();
    const now = new Date("2026-08-05T10:00:00.000Z");
    const failing = vi.fn(async () => {
      throw new Error("worktree is locked");
    });

    const first = await runContextMountGcSweep({
      db,
      root: fx.root,
      now: () => now,
      removeWorktree: failing as never,
    });

    expect(first).toMatchObject({ scanned: 1, removed: 0, failed: 1 });

    const armed = await readMarker(fx.markerPath);

    expect(armed.state).toBe("retry_waiting");
    expect(armed.attemptCount).toBe(1);
    expect(armed.lastErrorCode).toBe("removal_failed");
    expect(new Date(armed.nextRetryAt as string).getTime()).toBe(
      now.getTime() + 60_000,
    );

    // Still inside the backoff window → skipped, attemptCount unchanged.
    const skipped = await runContextMountGcSweep({
      db,
      root: fx.root,
      now: () => new Date(now.getTime() + 30_000),
      removeWorktree: failing as never,
    });

    expect(skipped).toMatchObject({ scanned: 1, skipped: 1, failed: 0 });
    expect((await readMarker(fx.markerPath)).attemptCount).toBe(1);

    // Burn the rest of the budget; the last attempt flips to permanent `failed`.
    let clock = now.getTime();

    for (
      let attempt = 2;
      attempt <= MAX_CONTEXT_MOUNT_GC_ATTEMPTS;
      attempt += 1
    ) {
      clock += 7 * 24 * 60 * 60_000; // well past any backoff
      await runContextMountGcSweep({
        db,
        root: fx.root,
        now: () => new Date(clock),
        removeWorktree: failing as never,
      });
    }

    const exhausted = await readMarker(fx.markerPath);

    expect(exhausted.attemptCount).toBe(MAX_CONTEXT_MOUNT_GC_ATTEMPTS);
    expect(exhausted.state).toBe("failed");
    expect(exhausted.nextRetryAt).toBeNull();
    expect(failing).toHaveBeenCalledTimes(MAX_CONTEXT_MOUNT_GC_ATTEMPTS);
  }, 180_000);

  it("a successful reap clears the marker so a re-created mount starts clean", async () => {
    const fx = await createMountFixture();

    await runContextMountGcSweep({
      db,
      root: fx.root,
      removeWorktree: (async () => {
        throw new Error("transient");
      }) as never,
    });
    expect(await pathExists(fx.markerPath)).toBe(true);

    // Far enough in the future to clear the 1m backoff.
    await runContextMountGcSweep({
      db,
      root: fx.root,
      now: () => new Date(Date.now() + 3_600_000),
    });

    expect(await pathExists(fx.markerPath)).toBe(false);
    expect(await pathExists(fx.mountPath)).toBe(false);
  }, 120_000);
});

describe("context mount GC wiring seam", () => {
  it("the real runSchedulerTick({jobKind: 'system_sweep'}) claim→dispatch path runs the sweep", async () => {
    const fx = await createMountFixture();
    const originalRoot = process.env.MAISTER_RUNTIME_ROOT;

    process.env.MAISTER_RUNTIME_ROOT = fx.root;
    try {
      const summary = await runSchedulerTick({ jobKind: "system_sweep" });

      // The claim actually fired for the system_sweep job.
      expect(summary.claimedCount).toBeGreaterThan(0);
      expect(summary.attempts.some((a) => a.jobKind === "system_sweep")).toBe(
        true,
      );
      // …and the registered sweep really reaped through that dispatch — a
      // registration checklist nothing executes is an unverified claim.
      expect(await pathExists(fx.mountPath)).toBe(false);
      expect(await siblingRegistrations(fx.siblingRepo)).not.toContain(
        await realOf(fx.mountPath),
      );
    } finally {
      if (originalRoot === undefined) delete process.env.MAISTER_RUNTIME_ROOT;
      else process.env.MAISTER_RUNTIME_ROOT = originalRoot;
    }
  }, 180_000);
});
