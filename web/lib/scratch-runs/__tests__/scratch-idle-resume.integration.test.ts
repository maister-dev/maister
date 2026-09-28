// Ownership residuals T1.5 (D-A8): a scratch permission parked by the host's
// absolute cap resumes from the stored answer. Real Postgres, a REAL
// supervisor running the resumable mock adapter (it requests a permission on
// its first prompt and, after `session/resume`, replays the one a checkpoint
// cancelled), the production projection worker.

import type { Db } from "@/lib/execution-host/db";
import type { ProjectionWorker } from "@/lib/execution-host/events/projection-worker";
import type { RealSupervisor } from "@/test-support/real-supervisor";
import type { ScratchLaunchInput } from "@/lib/scratch-runs/types";
import type { SupervisorFaultProxy } from "@/test-support/supervisor-fault-proxy";

import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
import { countLiveRuns, promoteNextPending } from "@/lib/scheduler";
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
import { startSupervisorFaultProxy } from "@/test-support/supervisor-fault-proxy";

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
// Every host call goes through it, so a case can hold one answer on the wire.
let proxy: SupervisorFaultProxy;
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
  proxy = await startSupervisorFaultProxy(supervisor.url);
  restoreUrl = useRealSupervisorUrl(proxy.url);
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
  await proxy?.close();
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

// Fills the flow pool exactly: a filler `Running` run holds a slot, and the cap
// is set to the live count. Returns the release — the filler finishes and the
// cap is restored — so the next freed-slot pass has room.
async function atCapacity(): Promise<() => Promise<void>> {
  const previous = process.env.MAISTER_MAX_CONCURRENT_RUNS;
  const fillerId = randomUUID();

  await db.insert(schema.runs).values({
    id: fillerId,
    projectId,
    flowVersion: "v1.0.0",
    status: "Running",
  });
  process.env.MAISTER_MAX_CONCURRENT_RUNS = String(
    await countLiveRuns(db as never, "flow"),
  );

  return async () => {
    await db
      .update(schema.runs)
      .set({ status: "Done", endedAt: new Date() })
      .where(eq(schema.runs.id, fillerId));
    process.env.MAISTER_MAX_CONCURRENT_RUNS = previous;
  };
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
    const release = await atCapacity();

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
      await release();
    }
    // A slot frees: the gate admits the queued scratch resume through the
    // same claim the respond route takes, and respawns it.
    await promoteNextPending({ db: db as never, pool: "flow" });
    await resumedAndDelivered(runId);
    expect((await runOf(runId)).resumeRequestedAt).toBeNull();
  }, 180_000);

  // ADR-183 D9: an answer's resume claim is a pool admission, so the host's
  // pressure record fences it like a full pool — the host would refuse the
  // respawn anyway. Found at the rebase onto the residuals merge, whose new
  // claim read `capForPool` directly (the pool-cap-fence guard).
  it("T1.5 (b′): under the host's pressure record the answer is queued as at capacity, and resumes once the record clears", async () => {
    const { runId, hitlId } = await parkedDialog();
    const [host] = await db
      .select({ id: schema.executionHosts.id })
      .from(schema.executionHosts)
      .where(eq(schema.executionHosts.kind, "local_direct"));

    await db
      .insert(schema.executionHostPressure)
      .values({ executionHostId: host!.id, pressuredSince: new Date() });
    try {
      const response = await answer(runId, hitlId);

      expect(response.status).toBe(202);
      await expect(response.json()).resolves.toMatchObject({
        runStatus: "NeedsInputIdle",
        state: "resume-in-progress",
      });
      expect(await runOf(runId)).toMatchObject({ status: "NeedsInputIdle" });
      expect((await runOf(runId)).resumeRequestedAt).not.toBeNull();
    } finally {
      await db
        .delete(schema.executionHostPressure)
        .where(eq(schema.executionHostPressure.executionHostId, host!.id));
    }
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

    // Closed, and marked as never delivered: an identical retry is refused.
    expect(closed.respondedAt).not.toBeNull();
    expect(closed.response).toMatchObject({
      optionId: "allow",
      _closed: { reason: "not_requested" },
    });
  }, 180_000);

  // The respawned agent re-plans before it asks again: the resumed session
  // raises whatever request the parked session's journal holds, so rewriting
  // it here is the agent asking for something else.
  async function replanParkedRequest(
    runId: string,
    toolCall: Record<string, unknown>,
    options?: Array<Record<string, unknown>>,
  ): Promise<void> {
    const [session] = await db
      .select({ acpSessionId: schema.runSessions.acpSessionId })
      .from(schema.runSessions)
      .where(eq(schema.runSessions.runId, runId));
    const path = join(journalDir, `${session.acpSessionId}.json`);
    const journal = JSON.parse(await readFile(path, "utf8")) as {
      pendingPermission: Record<string, unknown>;
    };

    expect(journal.pendingPermission).toBeDefined();
    journal.pendingPermission = {
      ...journal.pendingPermission,
      toolCall,
      ...(options ? { options } : {}),
    };
    await writeFile(path, JSON.stringify(journal));
  }

  it("C4: a freed-slot respawn that fails puts the answered run back in the queue at its place", async () => {
    const { runId, hitlId } = await parkedDialog();
    const release = await atCapacity();
    let queuedAt: Date | null = null;

    try {
      expect((await answer(runId, hitlId)).status).toBe(202);
      queuedAt = (await runOf(runId)).resumeRequestedAt;
      expect(queuedAt).not.toBeNull();
    } finally {
      await release();
    }
    // The gate admits the run on a freed slot, but the host is down when the
    // session is respawned: the claim rolls back.
    await supervisor.stop();
    try {
      await promoteNextPending({ db: db as never, pool: "flow" });
      await waitFor(async () => {
        const rolledBack = await db
          .select({ id: schema.executionAssignments.id })
          .from(schema.executionAssignments)
          .where(
            and(
              eq(schema.executionAssignments.runId, runId),
              eq(
                schema.executionAssignments.releasedReason,
                "scratch_idle_resume_rollback",
              ),
            ),
          );

        return rolledBack.length === 1;
      }, "the failed respawn rolls the claim back");
      const run = await runOf(runId);

      // Parked again, and still queued at its original place — not dropped
      // from the queue with the operator's answer undelivered.
      expect(run.status).toBe("NeedsInputIdle");
      expect(run.resumeRequestedAt?.getTime()).toBe(queuedAt?.getTime());
    } finally {
      supervisor = await supervisor.restart();
      resetRegistrarStateForTests();
      resetResolverForTests();
    }
    // The next freed-slot pass admits it again and delivers the answer.
    await promoteNextPending({ db: db as never, pool: "flow" });
    await resumedAndDelivered(runId);
  }, 180_000);

  it("C3: the resumed session is re-prompted with the interrupted turn's own message, never a newer queued one", async () => {
    const { runId, hitlId } = await parkedDialog();
    // Sent while the first turn ran: queued behind it, its own turn next.
    const { appendScratchMessage } = await import(
      "@/lib/scratch-runs/messages"
    );
    const queued = await db.transaction((tx) =>
      appendScratchMessage(tx as never, {
        runId,
        role: "user",
        content: "queued later",
        delivery: "queued",
      }),
    );

    expect((await answer(runId, hitlId)).status).toBe(202);
    // The resumed turn completes and the queued row goes out as its own turn
    // right behind it (whose own permission request then parks the dialog
    // again), so wait on the row, not on a transient dialog status.
    await waitFor(async () => {
      const [row] = await db
        .select({ delivery: schema.runMessages.delivery })
        .from(schema.runMessages)
        .where(eq(schema.runMessages.id, queued.id));

      return row.delivery === "prompted";
    }, "the queued row's own dispatch");
    const echoes = async (text: string) =>
      (
        await db
          .select({ content: schema.runMessages.content })
          .from(schema.runMessages)
          .where(eq(schema.runMessages.runId, runId))
      ).filter((row) => row.content.includes(`echo: ${text}`)).length;

    await waitFor(
      async () => (await echoes("queued later")) >= 1,
      "the queued turn's reply",
    );
    // The launch prompt went out twice — the parked session, then the
    // resumed one — and the queued text once, on its own turn.
    expect(await echoes("needs a permission")).toBe(2);
    expect(await echoes("queued later")).toBe(1);
    const [stored] = await hitlOf(runId);

    expect(stored.response).toMatchObject({
      optionId: "allow",
      _audit: { deliveredViaResume: true },
    });
  }, 180_000);

  it("C1: the stored answer reaches the same request re-raised under a fresh toolCallId", async () => {
    const { runId, hitlId } = await parkedDialog();

    // The adapter mints a new id for every call (and a subagent call's parent
    // id), and an option label can carry session state; the tool, its input
    // and the choices are what the operator approved.
    await replanParkedRequest(
      runId,
      {
        toolCallId: "tc-9",
        title: "Mock tool",
        kind: "execute",
        _meta: { claudeCode: { toolName: "Mock", parentToolUseId: "tu-9" } },
      },
      [
        { optionId: "allow", kind: "allow_always", name: "Allow (41% used)" },
        { optionId: "deny", kind: "reject_once", name: "Deny" },
      ],
    );
    expect((await answer(runId, hitlId)).status).toBe(202);
    await resumedAndDelivered(runId);
  }, 180_000);

  it("C1: the stored answer never reaches a request for a different tool — it is retired and the operator is asked afresh", async () => {
    const { runId, hitlId } = await parkedDialog();
    const other = {
      toolCallId: "tc-2",
      title: "Delete the build",
      kind: "delete",
      rawInput: { command: "rm -rf build" },
    };

    await replanParkedRequest(runId, other);
    expect((await answer(runId, hitlId)).status).toBe(202);
    const rows = await waitFor(async () => {
      const current = await hitlOf(runId);

      return current.length === 2 && (await dialogOf(runId)) === "NeedsInput"
        ? current
        : null;
    }, "a fresh request for the other tool");

    // The operator's "allow" was for "Mock tool": closed, never delivered.
    expect(rows[0]).toMatchObject({ id: hitlId, supersededAt: null });
    expect(rows[0].respondedAt).not.toBeNull();
    expect(rows[0].response).toMatchObject({
      optionId: "allow",
      _closed: { reason: "request_changed" },
    });
    expect(rows[0].schema).toMatchObject({ toolCall: { title: "Mock tool" } });
    expect(rows[1]).toMatchObject({ respondedAt: null, response: null });
    expect(rows[1].schema).toMatchObject({ toolCall: other });
    expect((await runOf(runId)).status).toBe("NeedsInput");
  }, 180_000);

  // The stored answer's acknowledgement is an HTTP answer, outside the event
  // stream's order. Held on the wire, the answer has still reached the agent,
  // so the run moves on first; the late acknowledgement must not undo that.
  function holdStoredAnswerAck(
    runId: string,
    label: string,
    action: "hold-response" | "hold-request" = "hold-response",
  ) {
    return proxy.arm(
      {
        caseId: `idle-late-ack-${label}-${runId}`,
        method: "POST",
        path: /^\/sessions\/[^/]+\/input$/,
      },
      action,
    );
  }

  async function storedAnswerAckSettled(runId: string): Promise<boolean> {
    const inputs = await db
      .select({ state: schema.executionCommands.state })
      .from(schema.executionCommands)
      .where(
        and(
          eq(schema.executionCommands.runId, runId),
          eq(schema.executionCommands.kind, "session.input"),
        ),
      );

    return (
      inputs.length > 0 &&
      inputs.every(
        (row) => !["queued", "delivering", "accepted"].includes(row.state),
      )
    );
  }

  it("a late acknowledgement of the stored answer never moves the dialog its completed turn settled", async () => {
    const { runId, hitlId } = await parkedDialog();
    const held = holdStoredAnswerAck(runId, "turn");

    try {
      expect((await answer(runId, hitlId)).status).toBe(202);
      await held.awaitReached(60_000);
      await waitFor(
        async () => (await dialogOf(runId)) === "WaitingForUser",
        "the turn completes under the held acknowledgement",
      );
    } finally {
      held.release();
    }
    await waitFor(
      () => storedAnswerAckSettled(runId),
      "the late acknowledgement applied",
    );
    expect((await hitlOf(runId))[0].respondedAt).not.toBeNull();
    expect(await dialogOf(runId)).toBe("WaitingForUser");
  }, 180_000);

  it("a late acknowledgement of the stored answer never resurrects a run stopped while it was on the wire", async () => {
    const { runId, hitlId } = await parkedDialog();
    const held = holdStoredAnswerAck(runId, "stop");
    let stopped: { status: string; dialogStatus: string } | null = null;

    try {
      expect((await answer(runId, hitlId)).status).toBe(202);
      await held.awaitReached(60_000);
      await service.stopScratchWorkbench(runId, {
        db: db as never,
        executionHosts: hosts(),
      });
      stopped = {
        status: (await runOf(runId)).status,
        dialogStatus: await dialogOf(runId),
      };
      expect(stopped.dialogStatus).not.toBe("Running");
    } finally {
      held.release();
    }
    await waitFor(
      () => storedAnswerAckSettled(runId),
      "the late acknowledgement settled",
    );
    expect({
      status: (await runOf(runId)).status,
      dialogStatus: await dialogOf(runId),
    }).toEqual(stopped);
  }, 180_000);

  // The host keeps several requests pending per session (parallel tool
  // calls). The mock raises one, so the others are seeded beside it, bound to
  // the parked session as the consumer records them.
  async function seedParallelRequest(
    runId: string,
    parked: Awaited<ReturnType<typeof hitlOf>>[number],
    opts: { title: string; answered: boolean },
  ): Promise<string> {
    const id = randomUUID();

    await db.insert(schema.hitlRequests).values({
      id,
      runId,
      stepId: parked.stepId,
      kind: "permission",
      prompt: `Approve ${opts.title}?`,
      schema: {
        ...(parked.schema as Record<string, unknown>),
        requestId: `req-${id.slice(0, 8)}`,
        toolCall: {
          toolCallId: "tc-parallel",
          title: opts.title,
          kind: "read",
        },
      },
      response: opts.answered ? { optionId: "allow" } : null,
      // Newer than the parked request.
      createdAt: new Date(parked.createdAt.getTime() + 1_000),
    });

    return id;
  }

  it("a request the parked session raised that nobody answered is closed at the resume", async () => {
    const { runId, hitlId } = await parkedDialog();
    const [parked] = await hitlOf(runId);
    const parallelId = await seedParallelRequest(runId, parked, {
      title: "Parallel tool",
      answered: false,
    });

    expect((await answer(runId, hitlId)).status).toBe(202);
    await waitFor(
      async () => (await dialogOf(runId)) === "WaitingForUser",
      "the resumed turn completes",
    );
    const [parallel] = await db
      .select()
      .from(schema.hitlRequests)
      .where(eq(schema.hitlRequests.id, parallelId));

    // No live session holds it: left open it would pin the dialog.
    expect(parallel.respondedAt).not.toBeNull();
    expect(parallel.response).toBeNull();
  }, 180_000);

  it("with several answers stored, the re-raised request gets its own, not the newest", async () => {
    const { runId, hitlId } = await parkedDialog();
    const [parked] = await hitlOf(runId);
    const otherId = await seedParallelRequest(runId, parked, {
      title: "Other tool",
      answered: true,
    });

    expect((await answer(runId, hitlId)).status).toBe(202);
    await waitFor(
      async () => (await dialogOf(runId)) === "WaitingForUser",
      "the resumed turn completes on its own stored answer",
    );
    const rows = await hitlOf(runId);

    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.id === hitlId)?.response).toMatchObject({
      optionId: "allow",
      _audit: { deliveredViaResume: true },
    });
    // Never asked again, so the turn's completion closes it.
    expect(rows.find((row) => row.id === otherId)?.response).toMatchObject({
      _closed: { reason: "not_requested" },
    });
  }, 180_000);

  it("in a park of parallel requests, another one re-raised first keeps the stored answer, and answering it unblocks the dialog", async () => {
    const { runId, hitlId } = await parkedDialog();
    const [parked] = await hitlOf(runId);
    const parallelId = await seedParallelRequest(runId, parked, {
      title: "Parallel tool",
      answered: false,
    });

    // The resumed agent re-raises the parallel request first.
    await replanParkedRequest(runId, {
      toolCallId: "tc-parallel",
      title: "Parallel tool",
      kind: "read",
    });
    expect((await answer(runId, hitlId)).status).toBe(202);
    const fresh = await waitFor(async () => {
      const row = (await hitlOf(runId)).find(
        (candidate) => candidate.id !== hitlId && candidate.id !== parallelId,
      );

      return row && (await dialogOf(runId)) === "NeedsInput" ? row : null;
    }, "the re-raised parallel request asked afresh");
    const kept = (await hitlOf(runId)).find((row) => row.id === hitlId)!;

    expect(kept.respondedAt).toBeNull();
    expect(kept.response).toEqual({ optionId: "allow" });
    // The earlier session's stored row holds no live request: answering the
    // fresh one moves the dialog on, and the turn's completion closes it.
    const live = await respondToHitl(
      { runId, hitlRequestId: fresh.id, body: { optionId: "allow" } },
      actor,
      { db: db as never, executionHosts: hosts() },
    );

    expect(live.status).toBe(200);
    await waitFor(
      async () => (await dialogOf(runId)) === "WaitingForUser",
      "the turn completes",
    );
    expect(
      (await hitlOf(runId)).find((row) => row.id === hitlId)?.response,
    ).toMatchObject({
      optionId: "allow",
      _closed: { reason: "not_requested" },
    });
  }, 180_000);

  it("a failed delivery of the stored answer never re-opens a run stopped while it was on the wire", async () => {
    const { runId, hitlId } = await parkedDialog();
    const held = holdStoredAnswerAck(runId, "failed", "hold-request");
    let stopped: { status: string; dialogStatus: string } | null = null;

    try {
      expect((await answer(runId, hitlId)).status).toBe(202);
      await held.awaitReached(60_000);
      await service.stopScratchWorkbench(runId, {
        db: db as never,
        executionHosts: hosts(),
      });
      stopped = {
        status: (await runOf(runId)).status,
        dialogStatus: await dialogOf(runId),
      };
    } finally {
      // The answer never reaches the host: its delivery fails.
      held.cut();
    }
    await waitFor(
      () => storedAnswerAckSettled(runId),
      "the failed delivery settled",
    );
    expect({
      status: (await runOf(runId)).status,
      dialogStatus: await dialogOf(runId),
    }).toEqual(stopped);
  }, 180_000);
});
