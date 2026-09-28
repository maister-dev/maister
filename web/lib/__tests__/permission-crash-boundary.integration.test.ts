// Ownership residuals T3.0 (RED G0, ADR-177 amendment 2026-09-26): what the
// crash boundary does with a run whose session dies while a permission is
// pending — BEFORE any answer is sent. Real Postgres, a REAL supervisor running
// the resumable mock (it raises a permission on its first prompt), the
// production projection worker. Each control records the prompt's receipt,
// the incarnation, the owner application, the run and the HITL row, and pins
// the measured end state: these are the states the respond route must never
// pre-empt (D-G2), and the rows of the ADR-177 boundary table.
//
//   (i)   flow run, the adapter child SIGKILLed under a live host
//   (ii)  flow run, the host restarted (the `turn_lost` class)
//   (iii) scratch and agent variants of (i)

import type { Db } from "@/lib/execution-host/db";
import type { ExecutionHosts } from "@/lib/execution-host/client";
import type { RealSupervisor } from "@/test-support/real-supervisor";
import type { ScratchLaunchInput } from "@/lib/scratch-runs/types";
import type { SupervisorFaultProxy } from "@/test-support/supervisor-fault-proxy";

import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import * as fullSchema from "@/lib/db/schema";
import { testPlatformRunnerRow } from "@/lib/__tests__/runner-fixtures";
import { startAgentContinuationWorker } from "@/lib/agents/continuation-worker";
import { startAgentSession } from "@/lib/agents/launch";
import { createExecutionHosts } from "@/lib/execution-host/client";
import { setDefaultTransportForTests } from "@/lib/execution-host/default-transport";
import { canonicalProjectors } from "@/lib/execution-host/events/projection-runtime";
import { stopRuntimeEventConsumers } from "@/lib/execution-host/events/consumer";
import {
  startProjectionWorker,
  type ProjectionWorker,
} from "@/lib/execution-host/events/projection-worker";
import { mintPlacement } from "@/lib/execution-host/placement";
import { startPromptOwnerWorker } from "@/lib/execution-host/prompt-owner-recovery";
import { recoverExecutionCommands } from "@/lib/execution-host/recovery";
import { resetRegistrarStateForTests } from "@/lib/execution-host/registrar";
import {
  localHost,
  resetResolverForTests,
} from "@/lib/execution-host/resolver";
import { startFlowContinuationWorker } from "@/lib/flows/graph/continuation-worker";
import { runFlow } from "@/lib/flows/runner";
import { isRunRecoverable } from "@/lib/queries/run";
import { resumeCrashedRun } from "@/lib/runs/recover";
import { respondToHitl, type HitlActor } from "@/lib/services/hitl";
import { runReconcileSweep } from "@/lib/reconcile";
import {
  composePromptOwnerRegistry,
  PRODUCTION_PROMPT_OWNER_REGISTRIES,
} from "@/lib/workers/runtime";
import { seedAgentRun } from "@/test-support/agent-run-seed";
import { addWorktree, initRepo } from "@/test-support/git-fixture";
import { seedGraphRun } from "@/test-support/graph-run-seed";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";
import {
  startRealSupervisor,
  useRealSupervisorUrl,
} from "@/test-support/real-supervisor";
import { startSupervisorFaultProxy } from "@/test-support/supervisor-fault-proxy";

// FIXME(any): dual drizzle-orm peer-dep variants.
const schema = fullSchema as unknown as Record<string, any>;
const execFileAsync = promisify(execFile);
const USER_ID = "crash-boundary-user";

let testDatabase: StartedPostgresTestDb;
let projectionWorker: ProjectionWorker;
// The production durable set: a driver that yields to "durable prompt
// continuation" leaves the prompt's receipt to these, exactly as in a server.
let durable: Array<{ stop(): Promise<void> }> = [];
let db: Db;
let sup: RealSupervisor;
let restoreUrl: () => void = () => {};
let proxy: SupervisorFaultProxy;
let hosts: ExecutionHosts;
let scratchProjectId: string;
const savedEnv: Record<string, string | undefined> = {};

vi.mock("@/lib/db/client", () => ({
  getDb: () => db,
  closeDb: async () => {},
}));
vi.mock("@/lib/authz", () => ({
  requireProjectAction: vi.fn(async () => {}),
  requireActiveSession: vi.fn(async () => ({ id: USER_ID })),
}));

const AGENT_FLOW = {
  schemaVersion: 1,
  name: "crash-boundary",
  nodes: [
    {
      id: "implement",
      type: "ai_coding",
      action: { prompt: "do thing" },
      transitions: { success: "done" },
    },
  ],
};

// A `worktree` agent: the only workspace axis whose permission requests reach
// the web — read-only sessions are arbitrated inline by the host.
const AGENT_DEFINITION =
  "---\nname: Researcher\ndescription: d\nworkspace: worktree\nmode: session\nplatform_mcp: false\ntriggers:\n  - manual\nrisk_tier: read_only\n---\ndo thing\n";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
        `timed out waiting for ${what}\nsupervisor log:\n${await sup.logTail(4_000)}`,
      );
    await sleep(100);
  }
}

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "permission_crash_boundary",
  });
  db = testDatabase.db as unknown as Db;
  const journalDir = await mkdtemp(join(tmpdir(), "crash-boundary-journal-"));

  sup = await startRealSupervisor({
    fixture: "mock-acp-adapter-resumable.mjs",
    env: {
      MOCK_ACP_REQUEST_PERMISSION: "1",
      MOCK_ACP_STATE_DIR: journalDir,
    },
  });
  proxy = await startSupervisorFaultProxy(sup.url);
  restoreUrl = useRealSupervisorUrl(proxy.url);
  for (const key of [
    "DB_URL",
    "MAISTER_WORKTREES_ROOT",
    "MAISTER_RUNTIME_ROOT",
    "MAISTER_MAX_CONCURRENT_RUNS",
    "MAISTER_MAX_CONCURRENT_AGENTS",
  ])
    savedEnv[key] = process.env[key];
  process.env.DB_URL = testDatabase.container.getConnectionUri();
  process.env.MAISTER_WORKTREES_ROOT = join(sup.runtimeRoot, "worktrees");
  process.env.MAISTER_RUNTIME_ROOT = join(sup.runtimeRoot, "manager");
  process.env.MAISTER_MAX_CONCURRENT_RUNS = "64";
  process.env.MAISTER_MAX_CONCURRENT_AGENTS = "64";
  setDefaultTransportForTests(null);
  resetRegistrarStateForTests();
  resetResolverForTests();
  await db.insert(schema.users).values({
    id: USER_ID,
    email: `${USER_ID}@maister.local`,
    role: "member",
    accountStatus: "active",
  });
  hosts = createExecutionHosts({ db });
  projectionWorker = startProjectionWorker({
    db,
    projectors: canonicalProjectors,
  });
  durable = [
    startPromptOwnerWorker({
      db,
      owners: composePromptOwnerRegistry(PRODUCTION_PROMPT_OWNER_REGISTRIES),
    }),
    startFlowContinuationWorker({ db }),
    startAgentContinuationWorker({ db, executionHosts: hosts }),
  ];

  // The scratch launcher resolves the platform default runner and a project
  // whose repository is a real git checkout.
  const repo = await mkdtemp(join(sup.runtimeRoot, "scratch-repo-"));
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
  await db
    .insert(schema.platformAcpRunners)
    .values(testPlatformRunnerRow(runnerId, "claude") as never);
  await db
    .insert(schema.platformRuntimeSettings)
    .values({ id: "singleton", defaultRunnerId: runnerId });
  scratchProjectId = randomUUID();
  await db.insert(schema.projects).values({
    id: scratchProjectId,
    slug: `boundary-${scratchProjectId.slice(0, 8)}`,
    name: "Crash boundary scratch",
    repoPath: repo,
    taskKey: "CBS",
  });
}, 240_000);

afterAll(async () => {
  restoreUrl();
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await stopRuntimeEventConsumers();
  for (const worker of durable) await worker.stop();
  await projectionWorker?.stop();
  await proxy?.close();
  await sup?.kill();
  await testDatabase?.stop();
});

async function runRow(runId: string) {
  const [row] = (await db
    .select()
    .from(schema.runs)
    .where(eq(schema.runs.id, runId))) as Array<Record<string, any>>;

  return row;
}

async function hitlRows(runId: string) {
  return (await db
    .select()
    .from(schema.hitlRequests)
    .where(eq(schema.hitlRequests.runId, runId))
    .orderBy(asc(schema.hitlRequests.createdAt))) as Array<Record<string, any>>;
}

async function sessionRow(runId: string) {
  const [row] = (await db
    .select()
    .from(schema.runSessions)
    .where(eq(schema.runSessions.runId, runId))) as Array<Record<string, any>>;

  return row;
}

// The adapter child of the run's host session, from the host's own registry.
async function adapterPid(runId: string): Promise<number> {
  const { hostSessionId } = await sessionRow(runId);
  const rows = (await (await fetch(`${sup.url}/sessions`)).json()) as Array<{
    sessionId: string;
    pid: number;
  }>;
  const record = rows.find((row) => row.sessionId === hostSessionId);

  if (!record) throw new Error(`no host session ${hostSessionId}`);

  return record.pid;
}

async function pendingPermission(runId: string, what: string) {
  return waitFor(async () => {
    const [row] = await hitlRows(runId);

    return row && (await runRow(runId)).status === "NeedsInput" ? row : null;
  }, `${what}: NeedsInput + permission HITL row`);
}

const SETTLED_RUN = ["Failed", "Crashed", "Done", "Review", "Abandoned"];

async function settled(runId: string, what: string) {
  return waitFor(
    async () => SETTLED_RUN.includes((await runRow(runId)).status),
    `${what}: the run leaves NeedsInput`,
    90_000,
  );
}

type BoundaryState = {
  runStatus: string;
  recoverable: boolean;
  resumeTargetStepId: string | null;
  prompt: {
    state: string;
    errorCode: string | null;
    reason: string | null;
    application: string;
  };
  incarnations: string[];
  hitlClosed: boolean;
  hitlRows: number;
  terminalEvents: string[];
  dialogStatus?: string;
};

// The measured end state of a class — counts and tokens, not adjectives.
async function boundaryState(runId: string): Promise<BoundaryState> {
  const run = await runRow(runId);
  const session = await sessionRow(runId);
  const [prompt] = (await db
    .select()
    .from(schema.executionCommands)
    .where(
      and(
        eq(schema.executionCommands.runId, runId),
        eq(schema.executionCommands.kind, "session.prompt"),
      ),
    )
    .orderBy(desc(schema.executionCommands.createdAt))
    .limit(1)) as Array<Record<string, any>>;
  const incarnations = (await db
    .select({ state: schema.runSessionIncarnations.state })
    .from(schema.runSessionIncarnations)
    .where(eq(schema.runSessionIncarnations.runId, runId))
    .orderBy(asc(schema.runSessionIncarnations.createdAt))) as Array<{
    state: string;
  }>;
  const rows = await hitlRows(runId);
  const events = (await db
    .select({ kind: schema.domainEvents.kind })
    .from(schema.domainEvents)
    .where(
      and(
        eq(schema.domainEvents.runId, runId),
        inArray(schema.domainEvents.kind, [
          "run.failed",
          "run.crashed",
          "run.abandoned",
        ]),
      ),
    )) as Array<{ kind: string }>;
  const [scratch] = (await db
    .select({ dialogStatus: schema.scratchRuns.dialogStatus })
    .from(schema.scratchRuns)
    .where(eq(schema.scratchRuns.runId, runId))) as Array<{
    dialogStatus: string;
  }>;
  const error = (prompt?.lastError ?? null) as {
    code?: string;
    details?: { reason?: string };
    reason?: string;
  } | null;

  return {
    runStatus: run.status,
    // What the page offers: a flow run by its node's recover class, a scratch
    // dialog when run and dialog are both Crashed; an agent run never.
    recoverable:
      run.runKind === "scratch"
        ? run.status === "Crashed" && scratch?.dialogStatus === "Crashed"
        : run.runKind === "flow" &&
          isRunRecoverable({
            status: run.status,
            acpSessionId: session?.acpSessionId ?? null,
            currentNodeKind: "ai_coding",
            retrySafe: false,
            consensusEvidence: null,
          }),
    resumeTargetStepId: run.resumeTargetStepId ?? null,
    prompt: {
      state: prompt?.state ?? "none",
      errorCode: error?.code ?? null,
      reason: error?.details?.reason ?? error?.reason ?? null,
      application: prompt?.applicationState ?? "none",
    },
    incarnations: incarnations.map((row) => row.state),
    hitlClosed:
      rows.length > 0 && rows.every((row) => row.respondedAt !== null),
    hitlRows: rows.length,
    terminalEvents: events.map((row) => row.kind).sort(),
    ...(scratch ? { dialogStatus: scratch.dialogStatus } : {}),
  };
}

async function seedFlowRun(name: string) {
  const repoPath = await initRepo(`${sup.runtimeRoot}/repo-${name}`);
  const worktreePath = await addWorktree(
    repoPath,
    `${sup.runtimeRoot}/wt-${name}`,
    `maister/${name}`,
  );
  const seeded = await seedGraphRun(testDatabase.db, AGENT_FLOW, {
    repoPath,
    workspace: { worktreePath, parentRepoPath: repoPath },
  });
  const placementHost = await localHost({ db });

  await db.transaction((tx) =>
    mintPlacement(tx as unknown as Db, {
      runId: seeded.runId,
      reason: "launch",
      host: placementHost,
    }),
  );

  return seeded.runId;
}

async function flowOnPermission(name: string) {
  const runId = await seedFlowRun(name);
  const flow = runFlow(runId, {
    db,
    runtimeRoot: sup.runtimeRoot,
    executionHosts: hosts,
  }).catch(() => undefined);
  const hitl = await pendingPermission(runId, name);

  return { runId, hitl, flow };
}

const actor: HitlActor = {
  kind: "user",
  userId: USER_ID,
  label: "Crash boundary operator",
};

function answer(runId: string, hitlRequestId: string) {
  return respondToHitl(
    { runId, hitlRequestId, body: { optionId: "allow" } },
    actor,
    { db, executionHosts: hosts },
  );
}

async function launchScratchOnPermission(what: string) {
  const { launchScratchRunStaged } = await import("@/lib/scratch-runs/service");
  const body: ScratchLaunchInput = {
    projectId: scratchProjectId,
    baseBranch: "main",
    prompt: "needs a permission",
    reasoningEffort: "high",
    attachments: [],
  };
  const staged = launchScratchRunStaged({ body, userId: USER_ID });
  let runId: string | null = null;
  const driver = (async () => {
    for (;;) {
      const step = await staged.next();

      if (step.done) return;
      const value = step.value as { runId?: string };

      if (value.runId) runId = value.runId;
    }
  })().catch(() => undefined);
  const id = await waitFor(async () => runId, `${what}: the scratch run row`);
  const hitl = await pendingPermission(id, what);

  return { runId: id, hitl, driver };
}

async function agentOnPermission(what: string) {
  const runId = await seedAgentRun(db, {
    runtimeRoot: sup.runtimeRoot,
    definition: AGENT_DEFINITION,
    workspace: "worktree",
    resultContract: null,
  });
  const driver = startAgentSession(runId, {
    db,
    executionHosts: hosts,
  }).catch(() => undefined);
  const hitl = await pendingPermission(runId, what);

  return { runId, hitl, driver };
}

async function crashReason(runId: string): Promise<unknown> {
  const [event] = (await db
    .select({ payload: schema.domainEvents.payload })
    .from(schema.domainEvents)
    .where(
      and(
        eq(schema.domainEvents.runId, runId),
        eq(schema.domainEvents.kind, "run.crashed"),
      ),
    )) as Array<{ payload: Record<string, unknown> }>;

  return event?.payload.reason;
}

// The end state each class reaches with no answer sent: the rows of the
// ADR-177 amendment's boundary table. Counts and tokens, never adjectives.
const FLOW_SESSION_CRASHED = {
  runStatus: "Crashed",
  recoverable: true,
  resumeTargetStepId: "implement",
  prompt: {
    state: "failed",
    errorCode: "ACP_PROTOCOL",
    reason: "required_output_incomplete",
    application: "applied",
  },
  incarnations: ["crashed"],
  hitlClosed: true,
  hitlRows: 1,
  terminalEvents: ["run.crashed"],
};
const SCRATCH_CHILD_KILLED = {
  runStatus: "Crashed",
  recoverable: true,
  resumeTargetStepId: null,
  prompt: {
    state: "failed",
    errorCode: "ACP_PROTOCOL",
    reason: "required_output_incomplete",
    application: "superseded",
  },
  incarnations: ["crashed"],
  hitlClosed: true,
  hitlRows: 1,
  terminalEvents: ["run.crashed"],
  dialogStatus: "Crashed",
};
const AGENT_CHILD_KILLED = {
  runStatus: "Failed",
  recoverable: false,
  resumeTargetStepId: null,
  prompt: {
    state: "failed",
    errorCode: "ACP_PROTOCOL",
    reason: "required_output_incomplete",
    application: "applied",
  },
  incarnations: ["crashed"],
  hitlClosed: true,
  hitlRows: 1,
  terminalEvents: ["run.failed"],
};

describe("the crash boundary with a permission pending (G0, no answer sent)", () => {
  // T3.2b: the kill fails the prompt (the purge rejects the pending
  // permission) and its owner applies that failure while the run waits in
  // NeedsInput. Before the `session_crashed` class nothing ever moved the run
  // again; now the node's re-entry reads the crashed incarnation and closes
  // it like a lost turn — and Recover asks again.
  it("(i) flow: the adapter child dies under a live host → Crashed (session-crashed), recoverable, row closed; Recover asks again", async () => {
    const { runId, hitl, flow } = await flowOnPermission("flow-sigkill");

    process.kill(await adapterPid(runId), "SIGKILL");
    await settled(runId, "flow-sigkill");
    await flow;
    expect(await boundaryState(runId)).toEqual(FLOW_SESSION_CRASHED);
    expect(await crashReason(runId)).toBe("session-crashed");

    const recovered = await resumeCrashedRun(runId, {
      db,
      executionHosts: hosts,
      runFlow: (id, runOpts) =>
        void runFlow(id, {
          db,
          runtimeRoot: sup.runtimeRoot,
          executionHosts: hosts,
          ...runOpts,
        }).catch(() => undefined),
    });

    expect(recovered).toEqual({ state: "resumed" });
    // The resumed session raises the permission again: a fresh row, while
    // the dead session's row stays closed.
    const rows = await waitFor(async () => {
      const current = await hitlRows(runId);

      return current.length === 2 &&
        (await runRow(runId)).status === "NeedsInput"
        ? current
        : null;
    }, "flow-sigkill: Recover raises a fresh permission");

    expect(rows.find((row) => row.id === hitl.id)?.respondedAt).not.toBeNull();
    expect(rows.find((row) => row.id !== hitl.id)?.respondedAt).toBeNull();
  }, 240_000);

  it("(iii-a) scratch: the adapter child dies under a live host → dialog and run Crashed, row closed", async () => {
    const { runId, driver } =
      await launchScratchOnPermission("scratch-sigkill");

    process.kill(await adapterPid(runId), "SIGKILL");
    await settled(runId, "scratch-sigkill");
    await driver;
    // The scratch consumer settles the run from the session stream, ahead of
    // the canonical lifecycle projection of the same crash.
    await waitFor(
      async () =>
        (await boundaryState(runId)).incarnations.every(
          (state) => state === "crashed",
        ),
      "scratch-sigkill: the incarnation projects crashed",
    );
    expect(await boundaryState(runId)).toEqual(SCRATCH_CHILD_KILLED);
  }, 180_000);

  it("(iii-b) agent: the adapter child dies under a live host → Failed, row closed (D-G3)", async () => {
    const { runId, driver } = await agentOnPermission("agent-sigkill");

    process.kill(await adapterPid(runId), "SIGKILL");
    await settled(runId, "agent-sigkill");
    await driver;
    expect(await boundaryState(runId)).toEqual(AGENT_CHILD_KILLED);
  }, 180_000);
});

describe("an answer to a dead session never fails the run (G1, D-G2)", () => {
  // The crash's canonical event is held, so the answer lands while the run
  // still reads NeedsInput and the host's registry already says the child is
  // gone: the host names `session_ended`, the route answers 409 and writes
  // nothing, and the boundary settles the run once the event flows.
  it("(i) flow: 409 session_ended, no run write; the boundary then crashes it recoverably", async () => {
    const { runId, hitl, flow } = await flowOnPermission("flow-answer");
    const held = proxy.arm(
      {
        caseId: `crashed-event-${runId}`,
        method: "GET",
        path: /^\/runtime-events$/,
        eventType: "session.crashed",
      },
      "hold-events",
    );
    let released = false;

    try {
      process.kill(await adapterPid(runId), "SIGKILL");
      await held.awaitReached();
      const response = await answer(runId, hitl.id);

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({
        code: "CONFLICT",
        details: { reason: "session_ended" },
      });
      expect((await runRow(runId)).status).toBe("NeedsInput");
      const [row] = await hitlRows(runId);

      expect(row).toMatchObject({ respondedAt: null });
      expect(row.response).toMatchObject({ optionId: "allow" });
      held.release();
      released = true;
    } finally {
      if (!released) held.release();
    }
    await settled(runId, "flow-answer");
    await flow;
    expect(await boundaryState(runId)).toEqual(FLOW_SESSION_CRASHED);
    // On master the answer won the CAS and failed the run HITL_TIMEOUT.
    expect(
      (await boundaryState(runId)).terminalEvents.includes("run.failed"),
    ).toBe(false);
  }, 240_000);

  // The crash's canonical event is held, as in (i): the scratch and agent
  // drivers read the same event plane, so the answer lands while nothing has
  // settled — the host names `session_ended` and the route answers 409 and
  // writes nothing. (Unheld, the boundary could win and a `not_awaiting_input`
  // 409 would pass on master too.)
  async function answerHeldCrash(runId: string, hitlId: string, what: string) {
    const held = proxy.arm(
      {
        caseId: `crashed-event-${runId}`,
        method: "GET",
        path: /^\/runtime-events$/,
        eventType: "session.crashed",
      },
      "hold-events",
    );
    let released = false;

    try {
      process.kill(await adapterPid(runId), "SIGKILL");
      await held.awaitReached();
      const response = await answer(runId, hitlId);

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({
        code: "CONFLICT",
        details: { reason: "session_ended" },
      });
      expect((await runRow(runId)).status).toBe("NeedsInput");
      const [row] = await hitlRows(runId);

      expect(row).toMatchObject({ respondedAt: null });
      expect(row.response).toMatchObject({ optionId: "allow" });
      held.release();
      released = true;
    } finally {
      // A reached barrier must be released even when an assertion failed, or
      // it parks the next case's events.
      if (!released && held.observations.length > 0) held.release();
    }
    await settled(runId, what);
  }

  it("(iii-a) scratch: the answer writes nothing; the boundary settles the dialog", async () => {
    const { runId, hitl, driver } =
      await launchScratchOnPermission("scratch-answer");

    await answerHeldCrash(runId, hitl.id, "scratch-answer");
    await driver;
    // The scratch consumer settles the run from the session stream, ahead of
    // the canonical lifecycle projection of the same crash.
    await waitFor(
      async () =>
        (await boundaryState(runId)).incarnations.every(
          (state) => state === "crashed",
        ),
      "scratch-answer: the incarnation projects crashed",
    );
    expect(await boundaryState(runId)).toEqual(SCRATCH_CHILD_KILLED);
  }, 180_000);

  // T3.3 on the real host: the session is live but no longer holds the
  // request the row names (answered or cancelled on another path). The host
  // answers `permission_not_pending`; the route closes the row — marked as
  // never delivered, so a retry is refused the same way — and moves nothing.
  it("(iv) live session, request no longer pending: 410 permission_not_pending, row closed undelivered, run untouched", async () => {
    const { runId, hitl, driver } = await launchScratchOnPermission(
      "scratch-not-pending",
    );

    await db
      .update(schema.hitlRequests)
      .set({
        schema: sql`jsonb_set(${schema.hitlRequests.schema}, '{requestId}', to_jsonb(${randomUUID()}::text))`,
      })
      .where(eq(schema.hitlRequests.id, hitl.id));
    const response = await answer(runId, hitl.id);

    expect(response.status).toBe(410);
    await expect(response.json()).resolves.toMatchObject({
      code: "HITL_TIMEOUT",
      details: { reason: "permission_not_pending" },
    });
    const [row] = await hitlRows(runId);

    expect(row.respondedAt).not.toBeNull();
    expect(row.response).toMatchObject({
      optionId: "allow",
      _closed: { reason: "permission_not_pending" },
    });
    expect((await runRow(runId)).status).toBe("NeedsInput");
    expect((await answer(runId, hitl.id)).status).toBe(410);
    // End the dialog so the next case starts clean.
    process.kill(await adapterPid(runId), "SIGKILL");
    await settled(runId, "scratch-not-pending");
    await driver;
  }, 180_000);

  it("(iii-b) agent: the answer writes nothing; finalization settles the run and closes the row", async () => {
    const { runId, hitl, driver } = await agentOnPermission("agent-answer");

    await answerHeldCrash(runId, hitl.id, "agent-answer");
    await driver;
    expect(await boundaryState(runId)).toEqual(AGENT_CHILD_KILLED);
  }, 180_000);
});

describe("the host restarts under a pending permission (G0 (ii), last: it recycles the host)", () => {
  it("(ii) flow: turn_lost → Crashed, recoverable, row closed by crashRunningRun", async () => {
    const { runId, flow } = await flowOnPermission("flow-restart");

    sup = await sup.restart();
    resetRegistrarStateForTests();
    resetResolverForTests();
    await recoverExecutionCommands({ db, graceMs: 0 });
    await runReconcileSweep({ db });
    await settled(runId, "flow-restart");
    await flow;
    const state = await boundaryState(runId);

    // The incarnation's projected state races the restart's own lifecycle
    // events; every other column is the pin.
    expect({ ...state, incarnations: undefined }).toEqual({
      ...FLOW_SESSION_CRASHED,
      incarnations: undefined,
      prompt: {
        state: "failed",
        errorCode: "PRECONDITION",
        reason: "turn_lost",
        application: "applied",
      },
    });
    expect(await crashReason(runId)).toBe("turn-lost");
  }, 240_000);
});
