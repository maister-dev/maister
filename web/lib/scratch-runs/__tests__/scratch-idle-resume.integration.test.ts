// Ownership residuals T1.5 (D-A8): a scratch permission parked by the host's
// absolute cap resumes from the stored answer. Real Postgres, a REAL
// supervisor running the resumable mock adapter (it requests a permission on
// its first prompt and, after `session/resume`, replays the one a checkpoint
// cancelled), the production projection worker.

import type { Db } from "@/lib/execution-host/db";
import type { ProjectionWorker } from "@/lib/execution-host/events/projection-worker";
import type { RealSupervisor } from "@/test-support/real-supervisor";
import type { ScratchLaunchInput } from "@/lib/scratch-runs/types";

import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { and, asc, eq } from "drizzle-orm";
import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import * as schema from "@/lib/db/schema";
import { testPlatformRunnerRow } from "@/lib/__tests__/runner-fixtures";
import { canonicalProjectors } from "@/lib/execution-host/events/projection-runtime";
import { createExecutionHosts } from "@/lib/execution-host/client";
import { startProjectionWorker } from "@/lib/execution-host/events/projection-worker";
import { stopRuntimeEventConsumers } from "@/lib/execution-host/events/consumer";
import { resetRegistrarStateForTests } from "@/lib/execution-host/registrar";
import { resetResolverForTests } from "@/lib/execution-host/resolver";
import { runSweepTick } from "@/lib/runs/keepalive-sweeper";
import { promoteNextPending } from "@/lib/scheduler";
import { respondToHitl, type HitlActor } from "@/lib/services/hitl";
import { applyScratchPromptCompletion } from "@/lib/scratch-runs/turn-completion";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";
import {
  startRealSupervisor,
  useRealSupervisorUrl,
} from "@/test-support/real-supervisor";

const execFileAsync = promisify(execFile);
const USER_ID = "scratch-idle-user";

vi.mock("@/lib/db/client", () => ({
  getDb: () => db,
  closeDb: async () => {},
}));
vi.mock("@/lib/authz", () => ({
  requireActiveSession: vi.fn(async () => ({
    id: USER_ID,
    email: "scratch@test",
    role: "admin",
  })),
  requireProjectAction: vi.fn(async () => undefined),
}));

type Service = typeof import("@/lib/scratch-runs/service");

let service: Service;
let testDatabase: StartedPostgresTestDb;
let db: NodePgDatabase<typeof schema>;
let supervisor: RealSupervisor;
let worker: ProjectionWorker;
let restoreUrl: () => void = () => {};
let projectId: string;
let journalDir: string;
const savedEnv: Record<string, string | undefined> = {};

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "scratch_idle_resume",
  });
  db = testDatabase.db;
  journalDir = await mkdtemp(join(tmpdir(), "scratch-idle-journal-"));
  supervisor = await startRealSupervisor({
    fixture: "mock-acp-adapter-resumable.mjs",
    env: {
      MOCK_ACP_REQUEST_PERMISSION: "1",
      MOCK_ACP_STATE_DIR: journalDir,
      // ~8 s: the host cap is the only writer that parks a scratch permission.
      MAISTER_PERMISSION_MAX_HOURS: "0.00222",
    },
  });
  restoreUrl = useRealSupervisorUrl(supervisor.url);
  resetRegistrarStateForTests();
  resetResolverForTests();
  worker = startProjectionWorker({
    db: db as unknown as Db,
    projectors: canonicalProjectors,
  });
  service = await import("@/lib/scratch-runs/service");
  for (const key of [
    "DB_URL",
    "MAISTER_RUNTIME_ROOT",
    "MAISTER_WORKTREES_ROOT",
    "MAISTER_MAX_CONCURRENT_RUNS",
  ])
    savedEnv[key] = process.env[key];
  process.env.DB_URL = testDatabase.container.getConnectionUri();
  process.env.MAISTER_MAX_CONCURRENT_RUNS = "64";
  process.env.MAISTER_RUNTIME_ROOT = join(supervisor.runtimeRoot, "runtime");
  process.env.MAISTER_WORKTREES_ROOT = join(
    supervisor.runtimeRoot,
    "worktrees",
  );

  const repo = await mkdtemp(join(supervisor.runtimeRoot, "repo-"));
  const runnerId = randomUUID();

  await execFileAsync("git", ["init", "-q", "-b", "main", repo]);
  for (const args of [
    ["config", "user.email", "t@t.local"],
    ["config", "user.name", "T"],
    ["config", "commit.gpgsign", "false"],
  ])
    await execFileAsync("git", ["-C", repo, ...args]);
  await writeFile(join(repo, "base.txt"), "base\n");
  await execFileAsync("git", ["-C", repo, "add", "-A"]);
  await execFileAsync("git", ["-C", repo, "commit", "-q", "-m", "base"]);

  projectId = randomUUID();
  await db.insert(schema.users).values({
    id: USER_ID,
    email: `${USER_ID}@maister.local`,
    role: "member",
    accountStatus: "active",
  });
  await db
    .insert(schema.platformAcpRunners)
    .values(
      testPlatformRunnerRow(
        runnerId,
        "claude",
      ) as typeof schema.platformAcpRunners.$inferInsert,
    );
  await db.insert(schema.platformRuntimeSettings).values({
    id: "singleton",
    defaultRunnerId: runnerId,
  });
  await db.insert(schema.projects).values({
    id: projectId,
    slug: `idle-${projectId.slice(0, 8)}`,
    name: "Scratch idle resume",
    repoPath: repo,
    taskKey: "SIR",
  });
}, 240_000);

afterAll(async () => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await stopRuntimeEventConsumers();
  restoreUrl();
  await worker?.stop();
  await supervisor?.kill();
  await testDatabase?.stop();
  await rm(journalDir, { recursive: true, force: true });
});

function launchBody(prompt: string): ScratchLaunchInput {
  return {
    projectId,
    baseBranch: "main",
    prompt,
    reasoningEffort: "high",
    attachments: [],
  };
}

const actor: HitlActor = {
  kind: "user",
  userId: USER_ID,
  label: "Scratch operator",
};

function hosts() {
  return createExecutionHosts({ db: db as unknown as Db });
}

async function waitFor<T>(
  probe: () => Promise<T | null | undefined | false>,
  what: string,
  timeoutMs = 60_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const value = await probe();

    if (value) return value as T;
    if (Date.now() > deadline)
      throw new Error(
        `timed out waiting for ${what}\nsupervisor log:\n${await supervisor.logTail(4_000)}`,
      );
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function runOf(runId: string) {
  const [run] = await db
    .select()
    .from(schema.runs)
    .where(eq(schema.runs.id, runId));

  return run;
}

async function dialogOf(runId: string) {
  const [scratch] = await db
    .select()
    .from(schema.scratchRuns)
    .where(eq(schema.scratchRuns.runId, runId));

  return scratch.dialogStatus;
}

async function hitlOf(runId: string) {
  return db
    .select()
    .from(schema.hitlRequests)
    .where(eq(schema.hitlRequests.runId, runId))
    .orderBy(asc(schema.hitlRequests.createdAt));
}

// Launches a scratch dialog whose first turn raises a permission and lets the
// host's absolute cap park it: the run is `NeedsInputIdle`, the dialog still
// `NeedsInput`, the permission request open.
async function parkedDialog(): Promise<{ runId: string; hitlId: string }> {
  const staged = service.launchScratchRunStaged({
    body: launchBody("needs a permission"),
    userId: USER_ID,
  });
  let runId: string | null = null;
  let driverSettled = false;

  void (async () => {
    for (;;) {
      const step = await staged.next();

      if (step.done) return;
      const value = step.value as { runId?: string };

      if (value.runId) runId = value.runId;
    }
    // The launch's own turn is superseded by the park: its driver yields.
  })()
    .catch(() => undefined)
    .finally(() => {
      driverSettled = true;
    });
  const id = await waitFor(async () => runId, "the scratch run row");

  await waitFor(
    async () =>
      (await runOf(id)).status === "NeedsInputIdle" &&
      (await dialogOf(id)) === "NeedsInput",
    "the host cap parks the permission",
  ).catch(async (error: unknown) => {
    throw new Error(
      `${(error as Error).message}\nrun=${(await runOf(id)).status} dialog=${await dialogOf(id)} hitl=${JSON.stringify(await hitlOf(id))}`,
    );
  });
  // The stale launch driver's owner application locks the run row, and the
  // freed-slot gate reads its candidates SKIP LOCKED: a case that drives the
  // gate while it is still settling would race its own fixture.
  await waitFor(async () => driverSettled, "the launch driver settles");
  const [hitl] = await hitlOf(id);

  expect(hitl).toMatchObject({ kind: "permission", respondedAt: null });

  return { runId: id, hitlId: hitl.id };
}

function answer(runId: string, hitlRequestId: string) {
  return respondToHitl(
    { runId, hitlRequestId, body: { optionId: "allow" } },
    actor,
    { db: db as never, executionHosts: hosts() },
  );
}

async function resumedAndDelivered(runId: string) {
  await waitFor(
    async () => (await dialogOf(runId)) === "WaitingForUser",
    "the resumed turn completes",
  );
  const rows = await hitlOf(runId);

  // The stored answer was delivered to the re-raised request on its own row:
  // no second request, no NeedsInput flip.
  expect(rows).toHaveLength(1);
  expect(rows[0].respondedAt).not.toBeNull();
  expect(rows[0].response).toMatchObject({
    optionId: "allow",
    _audit: { deliveredViaResume: true },
  });
  expect((await runOf(runId)).status).toBe("Running");
  const resumes = await db
    .select()
    .from(schema.executionAssignments)
    .where(
      and(
        eq(schema.executionAssignments.runId, runId),
        eq(schema.executionAssignments.placementReason, "resume"),
      ),
    );

  // One resume placement drove the session; a claim a failed respawn rolled
  // back stays on the ledger, released under its own reason.
  expect(
    resumes.filter(
      (row) => row.releasedReason !== "scratch_idle_resume_rollback",
    ),
  ).toHaveLength(1);
}

describe("scratch idle resume after a host park (D-A8)", () => {
  it("T1.5 (a): the stored answer respawns the session with session/resume and answers the re-raised permission", async () => {
    const { runId, hitlId } = await parkedDialog();
    const before = (
      await db
        .select({ hostSessionId: schema.runSessions.hostSessionId })
        .from(schema.runSessions)
        .where(eq(schema.runSessions.runId, runId))
    )[0].hostSessionId;

    const response = await answer(runId, hitlId);

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      runStatus: "Running",
      state: "resume-in-progress",
    });
    await resumedAndDelivered(runId);
    const [session] = await db
      .select({
        hostSessionId: schema.runSessions.hostSessionId,
        acpSessionId: schema.runSessions.acpSessionId,
      })
      .from(schema.runSessions)
      .where(eq(schema.runSessions.runId, runId));

    expect(session.hostSessionId).not.toBe(before);
  }, 180_000);

  it("T1.5 (b): at capacity the answer is queued with a coalesced key, and the freed-slot gate's scratch arm admits it", async () => {
    const { runId, hitlId } = await parkedDialog();
    const previous = process.env.MAISTER_MAX_CONCURRENT_RUNS;
    const live = await db
      .select({ id: schema.runs.id })
      .from(schema.runs)
      .where(
        and(
          eq(schema.runs.status, "Running"),
          eq(schema.runs.projectId, projectId),
        ),
      );

    process.env.MAISTER_MAX_CONCURRENT_RUNS = String(Math.max(1, live.length));
    try {
      const first = await answer(runId, hitlId);

      expect(first.status).toBe(202);
      await expect(first.json()).resolves.toMatchObject({
        runStatus: "NeedsInputIdle",
        state: "resume-in-progress",
      });
      const queuedAt = (await runOf(runId)).resumeRequestedAt;

      expect(queuedAt).not.toBeNull();
      expect((await runOf(runId)).status).toBe("NeedsInputIdle");
      // An identical retry keeps the run's place in the FIFO.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect((await answer(runId, hitlId)).status).toBe(202);
      expect((await runOf(runId)).resumeRequestedAt?.getTime()).toBe(
        queuedAt?.getTime(),
      );
    } finally {
      process.env.MAISTER_MAX_CONCURRENT_RUNS = previous;
    }
    // A slot frees: the gate admits the queued scratch resume through the
    // same claim the respond route takes, and respawns it.
    await promoteNextPending({ db: db as never, pool: "flow" });
    await resumedAndDelivered(runId);
    expect((await runOf(runId)).resumeRequestedAt).toBeNull();
  }, 180_000);

  it("T1.5 (c)/(f): a host that is down at respawn answers 503 and leaves the run parked with the answer kept; the retry once it is back delivers it", async () => {
    const { runId, hitlId } = await parkedDialog();

    await supervisor.stop();
    try {
      const response = await answer(runId, hitlId);

      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toMatchObject({
        code: "EXECUTOR_UNAVAILABLE",
        details: { reason: "delivery_unavailable" },
      });
      expect((await runOf(runId)).status).toBe("NeedsInputIdle");
      expect(await dialogOf(runId)).toBe("NeedsInput");
      const [row] = await hitlOf(runId);

      expect(row).toMatchObject({ respondedAt: null });
      expect(row.response).toMatchObject({ optionId: "allow" });
      // (f): a scratch answer stores no `_delivery` intent — only the flow and
      // agent preparers write one — so a refused attempt leaves nothing the
      // re-delivery would have to withdraw.
      expect(row.response).not.toHaveProperty("_delivery");
    } finally {
      supervisor = await supervisor.restart();
      resetRegistrarStateForTests();
      resetResolverForTests();
    }
    // The operator's next step: the same answer once the host is back.
    const retry = await answer(runId, hitlId);

    expect(retry.status).toBe(202);
    await resumedAndDelivered(runId);
  }, 180_000);

  it("T1.5 (e): a parked dialog never answered is abandoned with its run by the TTL pass", async () => {
    const { runId } = await parkedDialog();

    // The TTL is measured from the park.
    await db
      .update(schema.runs)
      .set({ checkpointAt: new Date(Date.now() - 48 * 3_600_000) })
      .where(eq(schema.runs.id, runId));
    await runSweepTick({ db: db as never, executionHosts: hosts() });
    expect((await runOf(runId)).status).toBe("Abandoned");
    expect(await dialogOf(runId)).toBe("Abandoned");
  }, 180_000);

  it("T1.5 (d): a resumed turn that completes without re-raising the permission closes the stored answer", async () => {
    const { runId } = await parkedDialog();
    // The same state a respawned session reaches when its agent answers the
    // interrupted turn without asking again: the answer is stored for the
    // PARKED session, and the turn on the new one completes.
    const [row] = await hitlOf(runId);

    await db
      .update(schema.hitlRequests)
      .set({ response: { optionId: "allow" } })
      .where(eq(schema.hitlRequests.id, row.id));
    await db
      .update(schema.runSessions)
      .set({ hostSessionId: `respawned-${runId}` })
      .where(eq(schema.runSessions.runId, runId));
    await db
      .update(schema.scratchRuns)
      .set({ dialogStatus: "Running" })
      .where(eq(schema.scratchRuns.runId, runId));
    await db.transaction((tx) =>
      applyScratchPromptCompletion(tx as never, runId),
    );
    expect(await dialogOf(runId)).toBe("WaitingForUser");
    const [closed] = await hitlOf(runId);

    expect(closed.respondedAt).not.toBeNull();
    expect(closed.response).toEqual({ optionId: "allow" });
  }, 180_000);
});
