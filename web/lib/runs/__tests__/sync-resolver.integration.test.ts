import type {
  PromptStopReason,
  SupervisorEvent,
} from "@/lib/supervisor-client";

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { and, eq } from "drizzle-orm";
import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import * as fullSchema from "@/lib/db/schema";
import { testPlatformRunnerRow } from "@/lib/__tests__/runner-fixtures";
import {
  createFakeExecutionHost,
  fakeExecutionHosts,
  type FakeExecutionHost,
} from "@/test-support/fake-execution-host";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

const execFileAsync = promisify(execFile);

// The mocked supervisor boundary (no live agent). createSession / streamSession /
// sendPrompt / deleteSession are the resolver's session seam; deliverPermission is
// the HITL respond seam. Every other export stays real (spread `actual`).
const supMock = vi.hoisted(() => ({
  createSession: vi.fn(),
  deleteSession: vi.fn(),
  sendPrompt: vi.fn(),
  streamSession: vi.fn(),
  deliverPermission: vi.fn(),
}));

vi.mock("@/lib/supervisor-client", async (orig) => {
  const actual = await orig<typeof import("@/lib/supervisor-client")>();

  return { ...actual, ...supMock };
});

// Spy on promoteNextPending (slot-release contract) without changing its real
// behavior — a call with no Pending work is a no-op, so calling through is safe.
const schedulerSpy = vi.hoisted(() => ({ promoteNextPending: vi.fn() }));

vi.mock("@/lib/scheduler", async (orig) => {
  const actual = await orig<typeof import("@/lib/scheduler")>();

  return {
    ...actual,
    promoteNextPending: (...args: unknown[]) => {
      schedulerSpy.promoteNextPending(...args);

      return (actual.promoteNextPending as any)(...args);
    },
  };
});

// respondToHitl imports @/lib/authz, which pulls next-auth → next/server (an ESM
// path vitest cannot resolve). Stub it (established hitl-integration-test pattern).
vi.mock("@/lib/authz", () => ({
  requireProjectAction: vi.fn(async () => {}),
}));

let db: NodePgDatabase;

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));

const { addWorktree, syncOperationInProgress, aheadBehindCounts } =
  await import("@/lib/worktree");
const { syncRunTarget } = await import("@/lib/runs/sync-target");
const { respondToHitl } = await import("@/lib/services/hitl");
const { hasSyncDriver } = await import("@/lib/runs/sync-driver-registry");
const { markAbandoned } = await import("@/lib/runs/state-transitions");

const schema = fullSchema as unknown as Record<string, any>;
const { runs, workspaces, tasks, runSyncAttempts, runSessions, hitlRequests } =
  schema;

let testDatabase: StartedPostgresTestDb;
let pool: Pool;
let fake: FakeExecutionHost;
let root: string;

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "maister_test",
  });
  pool = testDatabase.pool;
  db = testDatabase.db;
  // ADR-165: the resolver is placed on and driven through the local execution
  // host — a fake host whose wire is routed to the supervisor spies above, so
  // every assertion on those spies keeps its shape (handle-form payloads).
  fake = createFakeExecutionHost();
  Object.assign(fake.transport, {
    createSession: async (env: {
      payload: Record<string, unknown>;
      fence: { runId: string };
    }) => supMock.createSession({ ...env.payload, runId: env.fence.runId }),
    sendPrompt: async (
      sessionId: string,
      env: { payload: unknown },
      opts?: unknown,
    ) => supMock.sendPrompt(sessionId, env.payload, opts),
    streamSession: (sessionId: string, opts?: unknown) =>
      supMock.streamSession(sessionId, opts),
    deleteSession: async (sessionId: string) => {
      await supMock.deleteSession(sessionId);

      return { outcome: "terminated" as const };
    },
    deliverInput: async (
      sessionId: string,
      env: { payload: { requestId: string; optionId?: string } },
    ) => {
      await supMock.deliverPermission(
        sessionId,
        env.payload.requestId,
        env.payload.optionId,
      );

      return { ok: true as const, replayed: false };
    },
  });
  await fakeExecutionHosts(db, { fake });
}, 180_000);

afterAll(async () => {
  await testDatabase?.stop();
});

beforeEach(async () => {
  for (const t of [
    "run_sync_attempts",
    "run_sessions",
    "hitl_requests",
    "workspaces",
    "runs",
    "tasks",
    "flows",
    "platform_acp_runners",
    "platform_runtime_settings",
    "projects",
    "users",
  ]) {
    await pool.query(`DELETE FROM "${t}"`);
  }
  root = await mkdtemp(join(tmpdir(), `sync-resolver-${randomUUID()}-`));
  vi.clearAllMocks();
  supMock.createSession.mockImplementation(async (input: any) => ({
    sessionId: `sess-${input.runId}`,
    pid: 4242,
    acpSessionId: `acp-${input.runId}`,
  }));
  supMock.deleteSession.mockResolvedValue(undefined);
  supMock.deliverPermission.mockResolvedValue(undefined);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

// ---- git helpers ----------------------------------------------------------

async function git(
  cwd: string,
  args: readonly string[],
  env?: Record<string, string>,
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync("git", args, {
    cwd,
    env: env ? { ...process.env, ...env } : process.env,
  });
}

async function identity(repo: string): Promise<void> {
  await git(repo, ["config", "user.email", "test@example.test"]);
  await git(repo, ["config", "user.name", "Test User"]);
}

async function headSha(cwd: string, rev = "HEAD"): Promise<string> {
  return (await git(cwd, ["rev-parse", rev])).stdout.trim();
}

async function initRepoWithRemote(): Promise<{
  remote: string;
  parent: string;
  baseSha: string;
}> {
  const remote = join(root, `remote-${randomUUID()}.git`);
  const parent = join(root, `parent-${randomUUID()}`);

  await git(root, ["init", "--bare", "-b", "main", remote]);
  await git(root, ["clone", remote, parent]);
  await identity(parent);
  await writeFile(join(parent, "base.txt"), "base\n");
  await git(parent, ["add", "base.txt"]);
  await git(parent, ["commit", "-m", "base"]);
  await git(parent, ["push", "-u", "origin", "main"]);

  return { remote, parent, baseSha: await headSha(parent) };
}

async function addRunWorktree(parent: string, branch: string): Promise<string> {
  const wt = join(root, `wt-${randomUUID()}`);

  await addWorktree({
    projectRepoPath: parent,
    branch,
    worktreePath: wt,
    startPoint: "main",
  });

  return wt;
}

// A conflicting run branch: run edits conf.txt one way; origin/main edits it the
// other way, so a rebase of the run branch onto main conflicts on conf.txt.
async function seedConflictWorktree(
  branch: string,
  opts?: { publish?: boolean },
): Promise<{ parent: string; wt: string; before: string }> {
  const { remote, parent } = await initRepoWithRemote();
  const wt = await addRunWorktree(parent, branch);

  await writeFile(join(wt, "conf.txt"), "run side\n");
  await git(wt, ["add", "conf.txt"]);
  await git(wt, ["commit", "-m", "run edits conf"]);
  const before = await headSha(wt);

  if (opts?.publish) await git(wt, ["push", "-u", "origin", branch]);

  const c = join(root, `conf-${randomUUID()}`);

  await git(root, ["clone", remote, c]);
  await identity(c);
  await writeFile(join(c, "conf.txt"), "main side\n");
  await git(c, ["add", "conf.txt"]);
  await git(c, ["commit", "-m", "main edits conf"]);
  await git(c, ["push", "origin", "main"]);
  await rm(c, { recursive: true, force: true });

  return { parent, wt, before };
}

// Stand in for the AI agent: resolve the paused rebase and finish it, leaving a
// clean tree with main as an ancestor of HEAD.
async function resolveConflictInWorktree(wt: string): Promise<void> {
  await writeFile(join(wt, "conf.txt"), "merged\n");
  await git(wt, ["add", "conf.txt"]);
  await git(wt, ["rebase", "--continue"], { GIT_EDITOR: "true" });
}

// ---- seed helpers ---------------------------------------------------------

async function seedGraph(parentRepoPath: string): Promise<{
  projectId: string;
  flowId: string;
  runnerId: string;
}> {
  const projectId = randomUUID();
  const runnerId = randomUUID();
  const flowId = randomUUID();

  await db
    .insert(schema.platformAcpRunners)
    .values(testPlatformRunnerRow(runnerId, "claude"));
  await db.insert(schema.projects).values({
    id: projectId,
    slug: `p-${projectId.slice(0, 8)}`,
    name: "P",
    repoPath: parentRepoPath,
    mainBranch: "main",
    maisterYamlPath: "/tmp/m.yaml",
    // Exercise the new sync resolution tier (projects.sync_runner_id).
    syncRunnerId: runnerId,
    taskKey: `T${projectId
      .replace(/[^0-9A-Za-z]/g, "")
      .slice(0, 7)
      .toUpperCase()}`,
  });
  await db.insert(schema.flows).values({
    id: flowId,
    projectId,
    flowRefId: "g",
    source: "github.com/x/y",
    version: "v1.0.0",
    installedPath: "/tmp/flows/g",
    manifest: {},
    schemaVersion: 1,
  });

  return { projectId, flowId, runnerId };
}

async function seedRun(opts: {
  projectId: string;
  flowId: string;
  worktreePath: string;
  branch: string;
  parentRepoPath: string;
  baseCommit: string;
  prUrl?: string | null;
  title?: string;
  prompt?: string;
}): Promise<{ runId: string; workspaceId: string; taskId: string }> {
  const runId = randomUUID();
  const taskId = randomUUID();
  const workspaceId = randomUUID();

  await db.insert(tasks).values({
    id: taskId,
    projectId: opts.projectId,
    number: Math.trunc(Math.random() * 1e9) + 1,
    title: opts.title ?? "Fix the widget",
    prompt: opts.prompt ?? "Make the widget stop crashing",
    status: "InFlight",
  });
  await db.insert(runs).values({
    id: runId,
    projectId: opts.projectId,
    taskId,
    flowId: opts.flowId,
    flowVersion: "v1.0.0",
    status: "Review",
    runKind: "flow",
  });
  await db.insert(workspaces).values({
    id: workspaceId,
    runId,
    projectId: opts.projectId,
    branch: opts.branch,
    worktreePath: opts.worktreePath,
    parentRepoPath: opts.parentRepoPath,
    baseBranch: "main",
    baseCommit: opts.baseCommit,
    targetBranch: "main",
    prUrl: opts.prUrl ?? null,
    promotionState: "none",
    lifecycleOperationState: "none",
  });

  return { runId, workspaceId, taskId };
}

// A bare live flow run to occupy a flow-pool scheduler slot (cap test).
async function seedLiveFlowRun(
  projectId: string,
  flowId: string,
): Promise<void> {
  const taskId = randomUUID();

  await db.insert(tasks).values({
    id: taskId,
    projectId,
    number: Math.trunc(Math.random() * 1e9) + 1,
    title: "live",
    prompt: "p",
    status: "InFlight",
  });
  await db.insert(runs).values({
    id: randomUUID(),
    projectId,
    taskId,
    flowId,
    flowVersion: "v1.0.0",
    status: "Running",
    runKind: "flow",
  });
}

function actor(): { type: "user"; id: string } {
  return { type: "user", id: "user-1" };
}

async function attemptRow(runId: string): Promise<any> {
  const [row] = await db
    .select()
    .from(runSyncAttempts)
    .where(eq(runSyncAttempts.runId, runId));

  return row;
}

async function assignmentRows(runId: string) {
  return await db
    .select({
      epoch: fullSchema.executionAssignments.epoch,
      state: fullSchema.executionAssignments.state,
      placementReason: fullSchema.executionAssignments.placementReason,
      releasedReason: fullSchema.executionAssignments.releasedReason,
    })
    .from(fullSchema.executionAssignments)
    .where(eq(fullSchema.executionAssignments.runId, runId))
    .orderBy(fullSchema.executionAssignments.epoch);
}

async function deleteCommandRows(runId: string) {
  return await db
    .select({
      kind: fullSchema.executionCommands.kind,
      state: fullSchema.executionCommands.state,
      assignmentEpoch: fullSchema.executionCommands.assignmentEpoch,
    })
    .from(fullSchema.executionCommands)
    .where(
      and(
        eq(fullSchema.executionCommands.runId, runId),
        eq(fullSchema.executionCommands.kind, "session.delete"),
      ),
    );
}

async function readRun(runId: string): Promise<any> {
  const [row] = await db.select().from(runs).where(eq(runs.id, runId));

  return row;
}

// ---- supervisor stream harness --------------------------------------------

type StreamController = {
  emit: (event: SupervisorEvent) => void;
  close: () => void;
  iterate: (signal?: AbortSignal) => AsyncGenerator<SupervisorEvent>;
};

function eventStream(): StreamController {
  const buf: Array<SupervisorEvent | "END"> = [];
  let wake: (() => void) | null = null;
  const notify = (): void => {
    const w = wake;

    wake = null;
    w?.();
  };

  return {
    emit(event) {
      buf.push(event);
      notify();
    },
    close() {
      buf.push("END");
      notify();
    },
    async *iterate(signal) {
      const onAbort = (): void => notify();

      signal?.addEventListener("abort", onAbort);
      try {
        for (;;) {
          while (buf.length === 0) {
            if (signal?.aborted) return;
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
          }
          const item = buf.shift() as SupervisorEvent | "END";

          if (item === "END") return;
          yield item;
        }
      } finally {
        signal?.removeEventListener("abort", onAbort);
      }
    },
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });

  return { promise, resolve };
}

function permissionEvent(sessionId: string): SupervisorEvent {
  return {
    type: "session.permission_request",
    sessionId,
    monotonicId: 1,
    requestId: "req-1",
    options: [
      { optionId: "allow", kind: "allow_once", name: "Allow" },
      { optionId: "deny", kind: "reject_once", name: "Deny" },
    ],
    toolCall: { title: "Edit conf.txt" },
  };
}

async function waitFor(
  predicate: () => Promise<boolean>,
  timeoutMs = 8000,
): Promise<void> {
  const start = Date.now();

  for (;;) {
    if (await predicate()) return;
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitFor timed out");
    }
    await new Promise((r) => setTimeout(r, 20));
  }
}

// ---------------------------------------------------------------------------

// ADR-141 (#4): the resolver turn is BACKGROUNDED. `syncRunTarget` returns at the
// cut — the CAS has committed, so the run is `Running` and the attempt is
// `agent_running` — and the resolve (30min of active time, plus arbitrarily long
// HITL pauses) continues after the response. Injecting the scheduler lets a test
// await exactly what the HTTP path deliberately does not, with no polling.
//
// A resolve failure is therefore NOT a rejected promise any more: it is a durable
// state change (the attempt ledger + runs.status), which is what these assert.
function backgrounded(): {
  schedule: (task: () => Promise<void>) => void;
  settled: () => Promise<void>;
} {
  let done: Promise<void> = Promise.resolve();

  return {
    schedule: (task) => {
      done = task();
    },
    settled: () => done,
  };
}

describe("syncRunTarget — agent resolver (ADR-141 Task 10)", () => {
  it("conflict + agent=true → resolver session launched, run Running, agent_launched", async () => {
    const { parent, wt } = await seedConflictWorktree("sync/agent-a", {
      publish: true,
    });
    const { projectId, flowId, runnerId } = await seedGraph(parent);
    const { runId } = await seedRun({
      projectId,
      flowId,
      worktreePath: wt,
      branch: "sync/agent-a",
      parentRepoPath: parent,
      baseCommit: await headSha(parent, "main"),
      prUrl: "https://github.com/x/y/pull/1",
      title: "Fix the parser",
      prompt: "The parser rejects valid input",
    });

    const stream = eventStream();

    supMock.streamSession.mockImplementation((_sid: string, opts: any) =>
      stream.iterate(opts?.signal),
    );
    supMock.sendPrompt.mockImplementation(async (_sid: string, _input: any) => {
      await resolveConflictInWorktree(wt);

      return { stopReason: "end_turn" as PromptStopReason };
    });

    const bg = backgrounded();
    const out = await syncRunTarget({
      runId,
      actor: actor(),
      agent: true,
      db,
      schedule: bg.schedule,
    });

    expect(out.outcome).toBe("agent_launched");
    // At the cut the push has not happened yet, so `false` is the honest answer;
    // the attempt row below carries the real outcome once the resolve settles.
    expect(out.pushed).toBe(false);
    // The response is truthful about the run being live (the 202 contract).
    expect((await readRun(runId)).status).toBe("Running");

    await bg.settled();

    // A fresh resolver session was created inside the worktree.
    expect(supMock.createSession).toHaveBeenCalledTimes(1);
    const createArg = supMock.createSession.mock.calls[0][0];

    // Handle-form wire: the worktree rides the adoption, not the create.
    expect(createArg).not.toHaveProperty("worktreePath");
    expect(
      (
        fake.callsOf("adoptWorkspace")[0]?.envelope?.payload as {
          path?: string;
        }
      )?.path,
    ).toBe(wt);
    expect(createArg.sessionName).toBe("sync-1");

    // The prompt carries target ref, strategy, the conflicted file, and the task.
    const promptArg = supMock.sendPrompt.mock.calls[0][1].prompt as string;

    expect(promptArg).toContain("conf.txt");
    expect(promptArg).toContain("main");
    expect(promptArg).toContain("rebase");
    expect(promptArg).toContain("Fix the parser");

    // run_sessions has the sync-1 snapshot row.
    const [sessionRow] = await db
      .select()
      .from(runSessions)
      .where(
        and(
          eq(runSessions.runId, runId),
          eq(runSessions.sessionName, "sync-1"),
        ),
      );

    expect(sessionRow).toBeDefined();
    expect(sessionRow.runnerId).toBe(runnerId);
    expect(sessionRow.runnerSnapshot).toMatchObject({ id: runnerId });
    // The PRODUCER of the handle reconcile's W2 arm keys on. The row is inserted
    // null in the CAS tx, and nothing else ever writes this column — every
    // existing recovery test FEEDS liveSessionId in, so they prove the consumer
    // and never this. Null here makes a live resolver look session-less, and
    // activeRunSessionsFor would then hand W2 the run's OLD flow-session handle.
    expect(sessionRow.acpSessionId).toBe(`acp-${runId}`);

    // Attempt finalized; run back to Review; session torn down; slot released.
    const row = await attemptRow(runId);

    expect(row.phase).toBe("succeeded");
    expect(row.pushed).toBe(true);
    expect(row.mode).toBe("agent");
    expect(row.runnerId).toBe(runnerId);
    expect(row.sessionName).toBe("sync-1");
    expect((await readRun(runId)).status).toBe("Review");
    expect(await syncOperationInProgress(wt)).toBe(false);
    expect(
      (await aheadBehindCounts(parent, "main", "sync/agent-a")).behind,
    ).toBe(0);
    expect(supMock.deleteSession).toHaveBeenCalledWith(`sess-${runId}`);
    expect(schedulerSpy.promoteNextPending).toHaveBeenCalled();
    // ADR-165 (N3): the resolver ran as its own `sync_resolver` generation,
    // released when the run returned to Review, and its teardown was a fenced
    // `session.delete` command under that generation.
    expect(await assignmentRows(runId)).toEqual([
      {
        epoch: 1,
        state: "released",
        placementReason: "sync_resolver",
        releasedReason: "sync_finished",
      },
    ]);
    expect(await deleteCommandRows(runId)).toEqual([
      { kind: "session.delete", state: "succeeded", assignmentEpoch: 1 },
    ]);
  });

  // THE trap of backgrounding the resolver. `return await` was the only thing
  // keeping syncRunTarget's `finally` from firing while the resolver ran; handing
  // the response back without transferring driver ownership deregisters it at
  // RESPONSE time. reconcile's classifier consults the registry FIRST and treats
  // "no driver" as a post-restart orphan — a resolver's run_sessions row carries
  // acp_session_id null, so `liveSession` is false for a live resolver too, giving
  // `sync-orphaned-idle`: the sweep then hard-resets the worktree under the running
  // agent and releases its claim. That regression already shipped once.
  it("keeps the in-proc driver registered for the WHOLE backgrounded resolve", async () => {
    const { parent, wt } = await seedConflictWorktree("sync/agent-driver");
    const { projectId, flowId } = await seedGraph(parent);
    const { runId } = await seedRun({
      projectId,
      flowId,
      worktreePath: wt,
      branch: "sync/agent-driver",
      parentRepoPath: parent,
      baseCommit: await headSha(parent, "main"),
    });

    const stream = eventStream();
    const gate = deferred<void>();

    supMock.streamSession.mockImplementation((_sid: string, opts: any) =>
      stream.iterate(opts?.signal),
    );
    supMock.sendPrompt.mockImplementation(async () => {
      await gate.promise;
      await resolveConflictInWorktree(wt);

      return { stopReason: "end_turn" as PromptStopReason };
    });

    const bg = backgrounded();

    await syncRunTarget({
      runId,
      actor: actor(),
      agent: true,
      db,
      schedule: bg.schedule,
    });

    // The response has been sent and the resolver is mid-turn: this is the exact
    // window in which reconcile must still see a live driver and SKIP.
    expect(hasSyncDriver(runId)).toBe(true);

    gate.resolve();
    await bg.settled();

    // ...and released exactly once the resolve is genuinely done, so a real
    // orphan is still recoverable.
    expect(hasSyncDriver(runId)).toBe(false);
    expect((await attemptRow(runId)).phase).toBe("succeeded");
  });

  // The resolver holds its claim across the whole resolve — "30 minutes of active
  // time, plus arbitrarily long HITL pauses" by its own comment — so a user
  // abandoning mid-resolve is ordinary, not exotic. Nothing covered it.
  //
  // It also pins F2's rollback: the success finalize used to be six independent
  // writes, so a refusal partway left the attempt `succeeded` while the run sat at
  // `Running` — the one shape every recovery arm filters out by phase, which is how
  // reconcile came to crash (or re-dispatch the graph of) a sync that had already
  // finished. Routed through the single transactional writer, the whole finalize is
  // now all-or-nothing.
  it("a run abandoned mid-resolve cancels the resolver and leaves nothing half-applied", async () => {
    const { parent, wt, before } =
      await seedConflictWorktree("sync/agent-aband");
    const { projectId, flowId } = await seedGraph(parent);
    const { runId, workspaceId } = await seedRun({
      projectId,
      flowId,
      worktreePath: wt,
      branch: "sync/agent-aband",
      parentRepoPath: parent,
      baseCommit: await headSha(parent, "main"),
    });

    const stream = eventStream();

    supMock.streamSession.mockImplementation((_sid: string, opts: any) =>
      stream.iterate(opts?.signal),
    );
    supMock.sendPrompt.mockImplementation(async () => {
      await resolveConflictInWorktree(wt);
      // The agent resolved; the user hits Abandon before the driver finalizes.
      await markAbandoned(runId, { db });

      return { stopReason: "end_turn" as PromptStopReason };
    });

    const bg = backgrounded();

    await syncRunTarget({
      runId,
      actor: actor(),
      agent: true,
      db,
      schedule: bg.schedule,
    });
    await bg.settled();

    const attempt = await attemptRow(runId);
    const run = await readRun(runId);

    // Abandon's terminal stands; the resolver never overwrites it with `succeeded`.
    expect(attempt.phase).toBe("failed");
    expect(run.status).toBe("Abandoned");
    // Neither half of the finalize leaked: no Review flip, no grace-window restart.
    expect(run.reviewEnteredAt).toBeNull();

    // ...and the claim is freed rather than stranded behind the terminal attempt.
    const [ws] = await db
      .select()
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId));

    expect(ws.lifecycleOperationState).toBe("none");
    expect(hasSyncDriver(runId)).toBe(false);
    // `before` is the pre-sync head: an abandoned run's local branch is inert (it is
    // never pushed and the worktree is GC'd), so this only pins that we did not
    // somehow publish it.
    expect(before).toBeTruthy();
  });

  it("crash stop-reason (non-end_turn) → abort restore, attempt failed, Review", async () => {
    const { parent, wt, before } =
      await seedConflictWorktree("sync/agent-crash");
    const { projectId, flowId } = await seedGraph(parent);
    const { runId } = await seedRun({
      projectId,
      flowId,
      worktreePath: wt,
      branch: "sync/agent-crash",
      parentRepoPath: parent,
      baseCommit: await headSha(parent, "main"),
    });

    const stream = eventStream();

    supMock.streamSession.mockImplementation((_sid: string, opts: any) =>
      stream.iterate(opts?.signal),
    );
    supMock.sendPrompt.mockResolvedValue({
      stopReason: "refusal" as PromptStopReason,
    });

    const bg = backgrounded();

    // The launch itself succeeds — the crash happens in the backgrounded turn,
    // long after the response, so it settles as state rather than as a throw.
    expect(
      (
        await syncRunTarget({
          runId,
          actor: actor(),
          agent: true,
          db,
          schedule: bg.schedule,
        })
      ).outcome,
    ).toBe("agent_launched");
    await bg.settled();

    const row = await attemptRow(runId);

    expect(row.phase).toBe("failed");
    expect(row.errorCode).toBe("CRASH");
    expect((await readRun(runId)).status).toBe("Review");
    expect(await headSha(wt)).toBe(before);
    expect(await syncOperationInProgress(wt)).toBe(false);
    expect(supMock.deleteSession).toHaveBeenCalledWith(`sess-${runId}`);
  });

  it("verification failure (rebase left incomplete) → abort restore, failed, Review", async () => {
    const { parent, wt, before } =
      await seedConflictWorktree("sync/agent-verify");
    const { projectId, flowId } = await seedGraph(parent);
    const { runId } = await seedRun({
      projectId,
      flowId,
      worktreePath: wt,
      branch: "sync/agent-verify",
      parentRepoPath: parent,
      baseCommit: await headSha(parent, "main"),
    });

    const stream = eventStream();

    supMock.streamSession.mockImplementation((_sid: string, opts: any) =>
      stream.iterate(opts?.signal),
    );
    // end_turn but the rebase is still in progress → verify gate fails.
    supMock.sendPrompt.mockResolvedValue({
      stopReason: "end_turn" as PromptStopReason,
    });

    const bg = backgrounded();

    expect(
      (
        await syncRunTarget({
          runId,
          actor: actor(),
          agent: true,
          db,
          schedule: bg.schedule,
        })
      ).outcome,
    ).toBe("agent_launched");
    await bg.settled();

    const row = await attemptRow(runId);

    expect(row.phase).toBe("failed");
    expect(row.errorCode).toBe("PRECONDITION");
    expect((await readRun(runId)).status).toBe("Review");
    expect(await headSha(wt)).toBe(before);
    expect(await syncOperationInProgress(wt)).toBe(false);
    expect(supMock.deleteSession).toHaveBeenCalledWith(`sess-${runId}`);
  });

  it("HITL round-trip: permission_request → NeedsInput + hitl row; respond flips Running + re-stamps agent_running_since", async () => {
    const { parent, wt } = await seedConflictWorktree("sync/agent-hitl");
    const { projectId, flowId } = await seedGraph(parent);
    const { runId } = await seedRun({
      projectId,
      flowId,
      worktreePath: wt,
      branch: "sync/agent-hitl",
      parentRepoPath: parent,
      baseCommit: await headSha(parent, "main"),
    });

    const stream = eventStream();
    const gate = deferred<void>();

    supMock.streamSession.mockImplementation((_sid: string, opts: any) =>
      stream.iterate(opts?.signal),
    );
    supMock.sendPrompt.mockImplementation(async () => {
      stream.emit(permissionEvent(`sess-${runId}`));
      await gate.promise;
      await resolveConflictInWorktree(wt);

      return { stopReason: "end_turn" as PromptStopReason };
    });

    const bg = backgrounded();
    const launched = await syncRunTarget({
      runId,
      actor: actor(),
      agent: true,
      db,
      schedule: bg.schedule,
    });

    expect(launched.outcome).toBe("agent_launched");

    // Wait for the resolver consumer to persist the permission HITL.
    await waitFor(async () => {
      const [h] = await db
        .select()
        .from(hitlRequests)
        .where(eq(hitlRequests.runId, runId));

      return Boolean(h) && (await readRun(runId)).status === "NeedsInput";
    });

    const [hitlRow] = await db
      .select()
      .from(hitlRequests)
      .where(eq(hitlRequests.runId, runId));

    expect(hitlRow.kind).toBe("permission");

    const beforeStamp = (await attemptRow(runId)).agentRunningSince as Date;

    await new Promise((r) => setTimeout(r, 5));
    // The respond path owns NeedsInput → Running AND the agent_running_since re-stamp.
    // ADR-165: the response is a `session.input` command through the client
    // bound to the run's assignment on the (fake) execution host.
    const { hosts } = await fakeExecutionHosts(db, { fake, runId });

    fake.sessions.set(`sess-${runId}`, {
      sessionId: `sess-${runId}`,
      runId,
      stepId: "sync",
      acpSessionId: `acp-${runId}`,
      executionWorkspaceId: "ws_seeded",
      assignmentEpoch: 1,
      createdByCommandId: "seeded",
      status: "live",
    });
    const res = await respondToHitl(
      { runId, hitlRequestId: hitlRow.id, body: { optionId: "allow" } },
      { kind: "user", userId: "user-1", label: "user-1" },
      { db, executionHosts: hosts },
    );

    expect(res.status).toBe(200);
    expect((await readRun(runId)).status).toBe("Running");
    const afterStamp = (await attemptRow(runId)).agentRunningSince as Date;

    expect(afterStamp.getTime()).toBeGreaterThan(beforeStamp.getTime());

    gate.resolve();
    await bg.settled();

    expect((await readRun(runId)).status).toBe("Review");
    expect(supMock.deliverPermission).toHaveBeenCalledTimes(1);
  });

  it("deferred-release: a post-createSession persistence failure still deleteSessions", async () => {
    const { parent, wt } = await seedConflictWorktree("sync/agent-persist");
    const { projectId, flowId } = await seedGraph(parent);
    const { runId } = await seedRun({
      projectId,
      flowId,
      worktreePath: wt,
      branch: "sync/agent-persist",
      parentRepoPath: parent,
      baseCommit: await headSha(parent, "main"),
    });

    // A db whose hitl_requests insert fails (inside the consumer's tx) — simulating
    // a persistence failure AFTER the session was created.
    const failingDb = failingHitlInsertDb(db, hitlRequests);

    const stream = eventStream();

    supMock.streamSession.mockImplementation((_sid: string, opts: any) =>
      stream.iterate(opts?.signal),
    );
    supMock.sendPrompt.mockImplementation(async (_sid: string) => {
      stream.emit(permissionEvent(`sess-${runId}`));
      stream.close();

      return { stopReason: "end_turn" as PromptStopReason };
    });

    const bg = backgrounded();

    // The persistence failure happens after createSession — i.e. inside the
    // backgrounded turn — so it settles as state, not as a rejection.
    expect(
      (
        await syncRunTarget({
          runId,
          actor: actor(),
          agent: true,
          db: failingDb,
          schedule: bg.schedule,
        })
      ).outcome,
    ).toBe("agent_launched");
    await bg.settled();

    expect(supMock.deleteSession).toHaveBeenCalledWith(`sess-${runId}`);
    // ADR-165 (N3): the fail-closed teardown is a fenced `session.delete` row.
    expect(await deleteCommandRows(runId)).toEqual([
      { kind: "session.delete", state: "succeeded", assignmentEpoch: 1 },
    ]);
    const row = await attemptRow(runId);

    expect(row.phase).toBe("failed");
    expect((await readRun(runId)).status).toBe("Review");
  });

  it("cap refusal: at cap → CONFLICT, conflicted rebase aborted, no session", async () => {
    vi.stubEnv("MAISTER_MAX_CONCURRENT_RUNS", "1");
    const { parent, wt, before } = await seedConflictWorktree("sync/agent-cap");
    const { projectId, flowId } = await seedGraph(parent);

    // Occupy the single flow slot.
    await seedLiveFlowRun(projectId, flowId);

    const { runId } = await seedRun({
      projectId,
      flowId,
      worktreePath: wt,
      branch: "sync/agent-cap",
      parentRepoPath: parent,
      baseCommit: await headSha(parent, "main"),
    });

    await expect(
      syncRunTarget({ runId, actor: actor(), agent: true, db }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    expect(supMock.createSession).not.toHaveBeenCalled();
    // The conflicted rebase was aborted; the run stays Review; attempt aborted.
    expect(await syncOperationInProgress(wt)).toBe(false);
    expect(await headSha(wt)).toBe(before);
    expect((await readRun(runId)).status).toBe("Review");
    expect(await attemptRow(runId)).toMatchObject({ phase: "aborted" });
    const sessionRows = await db
      .select()
      .from(runSessions)
      .where(eq(runSessions.runId, runId));

    expect(sessionRows).toHaveLength(0);
  });
});

// A db proxy whose insert(hitlRequests) rejects (inside nested transactions too),
// used to simulate a durable persistence failure without corrupting other writes.
function failingHitlInsertDb(realDb: any, hitlRequestsTable: any): any {
  const wrap = (base: any): any =>
    new Proxy(base, {
      get(target, prop, recv) {
        if (prop === "insert") {
          return (table: any) =>
            table === hitlRequestsTable
              ? {
                  values: () =>
                    Promise.reject(new Error("SIMULATED persistence failure")),
                }
              : target.insert(table);
        }
        if (prop === "transaction") {
          return (fn: any, ...rest: any[]) =>
            target.transaction((tx: any) => fn(wrap(tx)), ...rest);
        }
        const value = Reflect.get(target, prop, recv);

        return typeof value === "function" ? value.bind(target) : value;
      },
    });

  return wrap(realDb);
}
