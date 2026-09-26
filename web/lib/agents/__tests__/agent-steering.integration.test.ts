// ADR-182 Phase 3 (T3.0–T3.5): steering a persistent agent's RUNNING turn
// through the production launcher against a REAL supervisor child. The mock
// adapter holds every prompt until SIGUSR1 (`--controlled-prompt`) after
// emitting assistant text (`--pre-hold-text`), and emits its reply to a steer
// only once that prompt is released — so transcript order is the host's
// acceptance order, not a timer's. Steer requests pass through the fault proxy
// so a test can hold one while the parent turn moves on.

import type { Db } from "@/lib/execution-host/db";
import type { AgentTurn, ExecutionCommand } from "@/lib/db/schema";
import type { RealSupervisor } from "@/test-support/real-supervisor";
import type { ProjectionWorker } from "@/lib/execution-host/events/projection-worker";
import type { SupervisorFaultProxy } from "@/test-support/supervisor-fault-proxy";

import { fork, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { and, asc, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  agentTurns,
  executionCommands,
  hitlRequests,
  runMessages,
  runs,
  runSessions,
  users,
} from "@/lib/db/schema";
import { closeDb } from "@/lib/db/client";
import { sendAgentMessage } from "@/lib/agents/launch";
import { startAgentContinuationWorker } from "@/lib/agents/continuation-worker";
import { claimAgentResumeSlot, respondToHitl } from "@/lib/services/hitl";
import { markAbandoned, markCheckpointed } from "@/lib/runs/state-transitions";
import { getAgentRunTranscript } from "@/lib/runs/run-transcript-projector";
import { loadActiveRunSession } from "@/lib/runs/active-run-session";
import {
  PROMPT_BODY_MAX_BYTES,
  PROMPT_TRUNCATION_MARKER,
} from "@/lib/flows/graph/prompt-record";
import { createExecutionHosts } from "@/lib/execution-host/client";
import { defaultTransport } from "@/lib/execution-host/default-transport";
import { recoverExecutionCommands } from "@/lib/execution-host/recovery";
import { resetResolverForTests } from "@/lib/execution-host/resolver";
import { resetRegistrarStateForTests } from "@/lib/execution-host/registrar";
import { canonicalProjectors } from "@/lib/execution-host/events/projection-runtime";
import { startProjectionWorker } from "@/lib/execution-host/events/projection-worker";
import {
  RUNTIME_EVENT_CLAIM_LEASE_MS,
  stopRuntimeEventConsumers,
} from "@/lib/execution-host/events/consumer";
import { seedAgentRun } from "@/test-support/agent-run-seed";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";
import {
  startRealSupervisor,
  useRealSupervisorUrl,
} from "@/test-support/real-supervisor";
import { startSupervisorFaultProxy } from "@/test-support/supervisor-fault-proxy";

const PRE_HOLD = "before the steer";
const USER_ID = "agent-steering-user";

let database: StartedPostgresTestDb;
let db: Db;
let supervisor: RealSupervisor;
let proxy: SupervisorFaultProxy;
let worker: ProjectionWorker;
let restoreUrl: () => void = () => {};
let logDir: string;
let adapterLog: string;
const oldWorktreesRoot = process.env.MAISTER_WORKTREES_ROOT;
const oldRuntimeRoot = process.env.MAISTER_RUNTIME_ROOT;
const oldAgentCap = process.env.MAISTER_MAX_CONCURRENT_AGENTS;
const oldDbUrl = process.env.DB_URL;
const drivers: ChildProcess[] = [];

function fixtureArgs(extra: string[]): string[] {
  return [
    "--hang",
    "--lines",
    "0",
    "--supports-resume",
    "--controlled-prompt",
    "--pre-hold-text",
    PRE_HOLD,
    "--invocation-log",
    adapterLog,
    ...extra,
  ];
}

beforeAll(async () => {
  database = await startMainPostgresTestDb({
    databaseName: "agent_steering",
  });
  db = database.db as unknown as Db;
  await db
    .insert(users)
    .values({ id: USER_ID, email: "agent-steering@test.local" });
  logDir = await mkdtemp(path.join(tmpdir(), "agent-steering-"));
  adapterLog = path.join(logDir, "adapter-invocations.ndjson");
  supervisor = await startRealSupervisor({
    fixtureArgs: fixtureArgs(["--steering", "--steer-echo"]),
  });
  proxy = await startSupervisorFaultProxy(supervisor.url);
  restoreUrl = useRealSupervisorUrl(proxy.url);
  process.env.MAISTER_WORKTREES_ROOT = path.join(
    supervisor.runtimeRoot,
    "worktrees",
  );
  process.env.MAISTER_RUNTIME_ROOT = path.join(
    supervisor.runtimeRoot,
    "manager",
  );
  // Several cases leave a run live (blocked on a permission, or red); the
  // agent pool's default cap of 3 would then defer later cases' resumes.
  process.env.MAISTER_MAX_CONCURRENT_AGENTS = "64";
  // A park releases the slot in THIS process, and the scheduler it wakes
  // promotes the parked run's queued work through `getDb()` — as production
  // does. Without it the promotion claims the run and then cannot drive it.
  process.env.DB_URL = database.databaseUrl;
  resetRegistrarStateForTests();
  resetResolverForTests();
  worker = startProjectionWorker({ db, projectors: canonicalProjectors });
}, 180_000);

afterAll(async () => {
  for (const child of drivers) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    }
  }
  await stopRuntimeEventConsumers();
  await worker?.stop();
  await closeDb();
  restoreUrl();
  await proxy?.close();
  if (oldWorktreesRoot === undefined) delete process.env.MAISTER_WORKTREES_ROOT;
  else process.env.MAISTER_WORKTREES_ROOT = oldWorktreesRoot;
  if (oldRuntimeRoot === undefined) delete process.env.MAISTER_RUNTIME_ROOT;
  else process.env.MAISTER_RUNTIME_ROOT = oldRuntimeRoot;
  if (oldAgentCap === undefined)
    delete process.env.MAISTER_MAX_CONCURRENT_AGENTS;
  else process.env.MAISTER_MAX_CONCURRENT_AGENTS = oldAgentCap;
  if (oldDbUrl === undefined) delete process.env.DB_URL;
  else process.env.DB_URL = oldDbUrl;
  await supervisor?.kill();
  await database?.stop();
  await rm(logDir, { recursive: true, force: true });
});

afterEach(async () => {
  // A barrier a failed test left reached but unreleased is released here; it
  // matched only its own run's steers, so it never captured another test's.
  for (const handle of [...armed])
    if (handle.observations.length > 0) handle.release();
  armed.clear();
  for (const child of drivers) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    const exited = new Promise<void>((resolve) =>
      child.once("exit", () => resolve()),
    );

    if (child.connected) child.send({ state: "stop" });
    try {
      await expect
        .poll(() => child.exitCode !== null || child.signalCode !== null, {
          timeout: 10_000,
          interval: 50,
        })
        .toBe(true);
    } finally {
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
      await exited;
    }
  }
}, 30_000);

// The same host identity, port and state dir with a different adapter
// script: the steering advertisement is read at each create ACK.
async function restartSupervisor(extra: string[]): Promise<void> {
  supervisor = await supervisor.restart({
    port: supervisor.port,
    fixtureArgs: fixtureArgs(extra),
  });
  resetRegistrarStateForTests();
  resetResolverForTests();
}

async function seedPersistentAgent(
  spec: Record<string, unknown> = { bytes: 0, text: " reply" },
  workspace: "none" | "worktree" = "none",
): Promise<string> {
  return seedAgentRun(db, {
    runtimeRoot: supervisor.runtimeRoot,
    definition: `---\nname: Researcher\ndescription: d\nworkspace: ${workspace}\nmode: session\nplatform_mcp: false\ntriggers:\n  - manual\nrisk_tier: read_only\n---\nfixture-output:${JSON.stringify(spec)}\n`,
    workspace,
    resultContract: null,
    persistent: true,
  });
}

type Driver = {
  child: ChildProcess;
  exited: Promise<number | null>;
  output: () => string;
  returned: () => boolean;
};

function startDriver(runId: string): Driver {
  const child = fork(
    path.resolve("test-support", "agent-prompt-owner-process.ts"),
    [runId],
    {
      execArgv: [
        "--import",
        "tsx",
        "--import",
        path.resolve("scripts/_register-shim.mjs"),
      ],
      env: { ...process.env, DB_URL: database.databaseUrl },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    },
  );
  let output = "";
  let returned = false;

  child.on("message", (value: unknown) => {
    if (typeof value !== "object" || value === null || !("state" in value))
      return;
    if (value.state === "prompt_returned") returned = true;
    if (value.state === "error")
      output += `\ndriver error: ${JSON.stringify(value)}`;
  });
  const record = (chunk: Buffer): void => {
    output = (output + chunk.toString("utf8")).slice(-16_384);
  };

  child.stdout?.on("data", record);
  child.stderr?.on("data", record);
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once("exit", resolve);
    child.once("error", reject);
  });

  drivers.push(child);

  return { child, exited, output: () => output, returned: () => returned };
}

type Invocation = {
  pid: number;
  sessionId: string;
  method: string;
  outcome?: string;
};

async function invocations(): Promise<Invocation[]> {
  try {
    return (await readFile(adapterLog, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Invocation);
  } catch {
    return [];
  }
}

async function acpSessionOf(runId: string): Promise<string> {
  let acpSessionId: string | null = null;

  await expect
    .poll(
      async () => {
        acpSessionId =
          (await loadActiveRunSession(db, runId))?.acpSessionId ?? null;

        return acpSessionId;
      },
      { timeout: 30_000, interval: 25 },
    )
    .not.toBeNull();

  return acpSessionId as unknown as string;
}

async function adapterCalls(
  runId: string,
  method: string,
): Promise<Invocation[]> {
  const acpSessionId = await acpSessionOf(runId);

  return (await invocations()).filter(
    (row) => row.method === method && row.sessionId === acpSessionId,
  );
}

// The adapter holding the run's `n`-th prompt; SIGUSR1 lets that turn finish.
async function releasePrompt(runId: string, n: number): Promise<void> {
  let prompts: Invocation[] = [];

  await expect
    .poll(
      async () => {
        prompts = await adapterCalls(runId, "session/prompt");

        return prompts.length;
      },
      { timeout: 45_000, interval: 25 },
    )
    .toBeGreaterThanOrEqual(n);
  process.kill(prompts[n - 1].pid, "SIGUSR1");
}

async function turnsOf(runId: string): Promise<AgentTurn[]> {
  return db
    .select()
    .from(agentTurns)
    .where(eq(agentTurns.runId, runId))
    .orderBy(asc(agentTurns.ordinal));
}

async function turn(id: string): Promise<AgentTurn> {
  const [row] = await db.select().from(agentTurns).where(eq(agentTurns.id, id));

  return row;
}

async function commandsOf(runId: string, kind: ExecutionCommand["kind"]) {
  return db
    .select()
    .from(executionCommands)
    .where(
      and(eq(executionCommands.runId, runId), eq(executionCommands.kind, kind)),
    )
    .orderBy(asc(executionCommands.createdAt));
}

async function runOf(runId: string) {
  const [row] = await db.select().from(runs).where(eq(runs.id, runId));

  return row;
}

async function awaitRunStatus(
  runId: string,
  status: string,
  timeout = 45_000,
): Promise<void> {
  await expect
    .poll(async () => (await runOf(runId)).status, { timeout, interval: 50 })
    .toBe(status);
}

async function awaitTurnState(
  id: string,
  state: AgentTurn["state"],
  timeout = 45_000,
): Promise<void> {
  await expect
    .poll(async () => (await turn(id)).state, { timeout, interval: 50 })
    .toBe(state);
}

// The run's first turn is running on the host and the operator has seen its
// text: its prompt is accepted, the adapter holds it, the text is projected.
async function runningTurn(runId: string): Promise<AgentTurn> {
  await expect
    .poll(
      async () => {
        const [parent] = await turnsOf(runId);

        if (!parent?.commandId) return null;
        const [command] = await db
          .select({ state: executionCommands.state })
          .from(executionCommands)
          .where(eq(executionCommands.id, parent.commandId));

        return command?.state ?? null;
      },
      { timeout: 45_000, interval: 25 },
    )
    .toBe("accepted");
  await expect
    .poll(async () => (await adapterCalls(runId, "session/prompt")).length, {
      timeout: 15_000,
      interval: 25,
    })
    .toBe(1);
  await expect
    .poll(
      async () =>
        (
          await db
            .select({ id: runMessages.id })
            .from(runMessages)
            .where(
              and(
                eq(runMessages.runId, runId),
                eq(runMessages.role, "assistant"),
                eq(runMessages.content, PRE_HOLD),
              ),
            )
        ).length,
      { timeout: 15_000, interval: 25 },
    )
    .toBe(1);
  const [parent] = await turnsOf(runId);

  return parent;
}

async function userRows(runId: string) {
  return db
    .select()
    .from(runMessages)
    .where(and(eq(runMessages.runId, runId), eq(runMessages.role, "user")))
    .orderBy(asc(runMessages.sequence));
}

async function dialog(runId: string): Promise<Array<[string, string]>> {
  const transcript = await getAgentRunTranscript(runId, {
    client: db as never,
  });

  return transcript.messages
    .filter(
      (message) => message.role === "user" || message.role === "assistant",
    )
    .map((message) => [message.role, message.content]);
}

type HeldSteer = {
  readonly observations: readonly unknown[];
  awaitReached(): Promise<unknown>;
  release(): void;
  cut(): void;
};

const armed = new Set<HeldSteer>();

async function holdSteer(runId: string, caseId: string): Promise<HeldSteer> {
  const [session] = await db
    .select({ hostSessionId: runSessions.hostSessionId })
    .from(runSessions)
    .where(eq(runSessions.runId, runId));
  const barrier = proxy.arm(
    {
      caseId,
      method: "POST",
      path: new RegExp(`^/sessions/${session?.hostSessionId}/steer$`),
    },
    "hold-request",
  );
  const handle: HeldSteer = {
    observations: barrier.observations,
    awaitReached: () => barrier.awaitReached(),
    release: () => {
      armed.delete(handle);
      barrier.release();
    },
    cut: () => {
      armed.delete(handle);
      barrier.cut();
    },
  };

  armed.add(handle);

  return handle;
}

// A manager that dies in its retry backoff: nothing after an unknown outcome
// runs in this process.
function managerDyingInBackoff() {
  return createExecutionHosts({
    db,
    sleep: () => new Promise<void>(() => {}),
  });
}

function steerOf(turns: AgentTurn[]): AgentTurn {
  const steer = turns.find((row) => row.variant === "steer");

  if (!steer) throw new Error("no steer row");

  return steer;
}

describe("steering a persistent agent's running turn (ADR-182)", () => {
  it("S2: injects into the running turn — one steered user row between the text before it and the reply to it", async () => {
    const runId = await seedPersistentAgent();
    const driver = startDriver(runId);
    const parent = await runningTurn(runId);
    const result = await sendAgentMessage(runId, "also check X", {
      db,
      mode: "steer",
      requestKey: "s2",
    });
    const steer = steerOf(await turnsOf(runId));

    expect(result).toEqual({
      childRunId: runId,
      messageId: steer.id,
      status: "Running",
      messageState: "applied",
      delivery: "steered",
    });
    expect(steer).toMatchObject({
      state: "applied",
      parentTurnId: parent.id,
      ordinal: parent.ordinal + 1,
      incarnationId: parent.incarnationId,
    });
    expect(await commandsOf(runId, "session.steer")).toMatchObject([
      { id: steer.commandId, state: "succeeded" },
    ]);
    // D-C6: a same-key retry answers the row it created and issues nothing.
    expect(
      await sendAgentMessage(runId, "also check X", {
        db,
        mode: "steer",
        requestKey: "s2",
      }),
    ).toEqual(result);
    expect(await commandsOf(runId, "session.steer")).toHaveLength(1);

    await releasePrompt(runId, 1);
    await expect
      .poll(driver.returned, { timeout: 45_000, interval: 50 })
      .toBe(true);
    await awaitRunStatus(runId, "NeedsInputIdle");
    // The parent settles once, through its own canonical terminal.
    expect(await commandsOf(runId, "session.prompt")).toMatchObject([
      {
        id: parent.commandId,
        state: "succeeded",
        applicationState: "applied",
        settledFrom: "canonical",
      },
    ]);
    expect((await turn(parent.id)).state).toBe("applied");
    expect(await adapterCalls(runId, "session/prompt")).toHaveLength(1);
    expect(
      (await adapterCalls(runId, "_session/steering")).map(
        (row) => row.outcome,
      ),
    ).toEqual(["injected"]);
    // `--steer-echo` made the adapter echo the steer as a user chunk: still
    // exactly one user row for it — the manager-authored one.
    expect(
      (await userRows(runId)).filter((row) => row.content === "also check X"),
    ).toMatchObject([
      { delivery: "steered", promptDispatchKey: `steer:${steer.commandId}` },
    ]);
    expect(await dialog(runId)).toEqual([
      ["user", expect.stringContaining("fixture-output:")],
      ["assistant", PRE_HOLD],
      ["user", "also check X"],
      ["assistant", expect.stringContaining("steered:also check X")],
    ]);
    // An idle wake repeats the parent's completed input — never the steer,
    // although the steer is the run's highest applied ordinal.
    expect((await claimAgentResumeSlot(db, runId)).outcome).toBe("claimed");
    const resume = (await turnsOf(runId)).find(
      (row) => row.variant === "resume",
    ) as AgentTurn;

    expect(resume.prompt).toBe(parent.prompt);
    startDriver(runId);
    await releasePrompt(runId, 2);
    await awaitTurnState(resume.id, "applied");
    await awaitRunStatus(runId, "NeedsInputIdle");
  }, 120_000);

  it(
    "T3.0(a): a recovering worker re-drives the parent, never the dispatched steer beside it",
    async () => {
      const runId = await seedPersistentAgent();
      const driver = startDriver(runId);
      const parent = await runningTurn(runId);
      const barrier = await holdSteer(runId, `worker-${runId}`);
      const sending = sendAgentMessage(runId, "while unobserved", {
        db,
        mode: "steer",
      });

      await barrier.awaitReached();
      const steer = steerOf(await turnsOf(runId));

      expect(steer.state).toBe("dispatched");
      driver.child.kill("SIGKILL");
      await driver.exited;
      const continuation = startAgentContinuationWorker({ db });

      try {
        barrier.release();
        expect(await sending).toMatchObject({
          messageId: steer.id,
          messageState: "applied",
          delivery: "steered",
        });
        await releasePrompt(runId, 1);
        await awaitTurnState(
          parent.id,
          "applied",
          60_000 + 3 * RUNTIME_EVENT_CLAIM_LEASE_MS,
        );
        await awaitRunStatus(runId, "NeedsInputIdle");
        expect((await turn(steer.id)).state).toBe("applied");
        expect(await commandsOf(runId, "session.prompt")).toMatchObject([
          { id: parent.commandId, applicationState: "applied" },
        ]);
        expect(await adapterCalls(runId, "session/prompt")).toHaveLength(1);
      } finally {
        await continuation.stop();
      }
    },
    120_000 + 3 * RUNTIME_EVENT_CLAIM_LEASE_MS,
  );

  it("T3.0(b): a permission raised beside a dispatched steer binds to the parent, and the idle resume repeats the parent", async () => {
    const runId = await seedPersistentAgent(
      { bytes: 0, permission: true },
      "worktree",
    );
    const driver = startDriver(runId);
    const parent = await runningTurn(runId);
    const barrier = await holdSteer(runId, `permission-${runId}`);
    const sending = sendAgentMessage(runId, "mind the tests", {
      db,
      mode: "steer",
    });

    await barrier.awaitReached();
    const steer = steerOf(await turnsOf(runId));

    await releasePrompt(runId, 1);
    await expect
      .poll(
        async () =>
          (
            await db
              .select()
              .from(hitlRequests)
              .where(eq(hitlRequests.runId, runId))
          ).length,
        { timeout: 30_000, interval: 25 },
      )
      .toBe(1);
    const [hitl] = await db
      .select()
      .from(hitlRequests)
      .where(eq(hitlRequests.runId, runId));

    expect(hitl.schema).toMatchObject({
      agentPrompt: { commandId: parent.commandId, turnId: parent.id },
    });
    expect((await turn(steer.id)).state).toBe("dispatched");
    await awaitRunStatus(runId, "NeedsInput");
    // The parent is still the running turn while it waits on the permission.
    barrier.release();
    expect(await sending).toMatchObject({
      messageId: steer.id,
      messageState: "applied",
      delivery: "steered",
    });

    driver.child.kill("SIGKILL");
    await driver.exited;
    const client = await createExecutionHosts({ db }).forRun(runId);
    const [session] = await db
      .select()
      .from(runSessions)
      .where(eq(runSessions.runId, runId));

    await client.checkpoint(session.hostSessionId!);
    expect((await markCheckpointed(runId, { db })).ok).toBe(true);
    const run = await runOf(runId);

    expect(
      (
        await respondToHitl(
          { runId, hitlRequestId: hitl.id, body: { optionId: "allow" } },
          {
            kind: "user",
            userId: USER_ID,
            label: "Agent steering qualification",
            preauthorizedProjectId: run.projectId!,
          },
          { db },
        )
      ).status,
    ).toBe(202);
    const continuation = startAgentContinuationWorker({ db });

    try {
      await expect
        .poll(
          async () =>
            (await turnsOf(runId)).filter((row) => row.variant === "resume")
              .length,
          { timeout: 60_000 + RUNTIME_EVENT_CLAIM_LEASE_MS, interval: 100 },
        )
        .toBe(1);
      const resume = (await turnsOf(runId)).find(
        (row) => row.variant === "resume",
      ) as AgentTurn;

      // Resume repeats the parent's prompt, never the steer's text.
      expect(resume.prompt).toBe(parent.prompt);
      const [answered] = await db
        .select()
        .from(hitlRequests)
        .where(eq(hitlRequests.id, hitl.id));

      expect(answered.response).toMatchObject({
        _agentResume: { sourceCommandId: parent.commandId },
      });
      await releasePrompt(runId, 2);
      await awaitTurnState(resume.id, "applied", 60_000);
      await awaitRunStatus(runId, "NeedsInputIdle");
    } finally {
      await continuation.stop();
    }
  }, 240_000);

  it("T3.0(c): a steer still in flight never holds the next message back once its parent settled", async () => {
    const runId = await seedPersistentAgent();

    startDriver(runId);
    const parent = await runningTurn(runId);
    const barrier = await holdSteer(runId, `prior-${runId}`);
    const sending = sendAgentMessage(runId, "stuck steer", {
      db,
      mode: "steer",
    });

    await barrier.awaitReached();
    const steer = steerOf(await turnsOf(runId));

    await releasePrompt(runId, 1);
    await awaitTurnState(parent.id, "applied");
    await awaitRunStatus(runId, "NeedsInputIdle");
    const next = sendAgentMessage(runId, "next message", { db });

    await expect
      .poll(
        async () =>
          (await turnsOf(runId)).find((row) => row.prompt === "next message")
            ?.state,
        { timeout: 45_000, interval: 50 },
      )
      .toBe("dispatched");
    expect((await turn(steer.id)).state).toBe("dispatched");
    // The parent's generation is gone: the host refuses the held steer, which
    // becomes a queued message behind the one now running.
    barrier.release();
    const converted = await sending;
    const successor = (await turnsOf(runId)).find(
      (row) => row.logicalKey === `message:requeue:${steer.id}`,
    ) as AgentTurn;

    expect(converted).toMatchObject({
      messageId: successor.id,
      messageState: "queued",
      delivery: "queued",
    });
    expect((await turn(steer.id)).state).toBe("superseded");
    expect(await commandsOf(runId, "session.steer")).toMatchObject([
      {
        id: steer.commandId,
        state: "fenced",
        lastError: { details: { reason: "assignment_fenced" } },
      },
    ]);
    await releasePrompt(runId, 2);
    expect(await next).toMatchObject({
      messageState: "applied",
      delivery: "queued",
    });
    const continuation = startAgentContinuationWorker({ db });

    try {
      await releasePrompt(runId, 3);
      await awaitTurnState(successor.id, "applied", 60_000);
      await awaitRunStatus(runId, "NeedsInputIdle");
    } finally {
      await continuation.stop();
    }
    // The steer reached the agent once — as the successor's prompt.
    expect(await adapterCalls(runId, "session/prompt")).toHaveLength(3);
    expect(await adapterCalls(runId, "_session/steering")).toHaveLength(0);
  }, 150_000);

  it("S5: a refusal converts the steer into ONE queued successor, delivered exactly once", async () => {
    const runId = await seedPersistentAgent();
    const driver = startDriver(runId);
    const parent = await runningTurn(runId);
    const barrier = await holdSteer(runId, `refusal-${runId}`);
    const sending = sendAgentMessage(runId, "late steer", {
      db,
      mode: "steer",
      requestKey: "late",
    });

    await barrier.awaitReached();
    const steer = steerOf(await turnsOf(runId));

    // D-C6 while the outcome is unknown: the steer row, and nothing issued.
    expect(
      await sendAgentMessage(runId, "late steer", {
        db,
        mode: "steer",
        requestKey: "late",
      }),
    ).toMatchObject({
      messageId: steer.id,
      messageState: "dispatched",
      delivery: "steered",
    });
    expect(await commandsOf(runId, "session.steer")).toHaveLength(1);
    await releasePrompt(runId, 1);
    await expect
      .poll(driver.returned, { timeout: 45_000, interval: 50 })
      .toBe(true);
    await awaitRunStatus(runId, "NeedsInputIdle");
    expect((await turn(parent.id)).state).toBe("applied");
    barrier.release();
    await releasePrompt(runId, 2);
    const result = await sending;
    const successor = (await turnsOf(runId)).find(
      (row) => row.logicalKey === `message:requeue:${steer.id}`,
    ) as AgentTurn;

    expect(result).toEqual({
      childRunId: runId,
      messageId: successor.id,
      status: "NeedsInputIdle",
      messageState: "applied",
      delivery: "queued",
    });
    expect(successor).toMatchObject({
      prompt: "late steer",
      ordinal: steer.ordinal + 1,
      state: "applied",
    });
    expect((await turn(steer.id)).state).toBe("superseded");
    expect(await commandsOf(runId, "session.steer")).toMatchObject([
      {
        id: steer.commandId,
        state: "failed",
        // The run parked (checkpointed) before the steer arrived: the host
        // session is no longer live, a definitive refusal before any ACP call.
        lastError: {
          code: "PRECONDITION",
          message: expect.stringMatching(/not live/),
        },
      },
    ]);
    // Exactly one delivery: the successor's prompt; the adapter never saw the
    // steer (the host refused it before any ACP call).
    expect(await adapterCalls(runId, "session/prompt")).toHaveLength(2);
    expect(await adapterCalls(runId, "_session/steering")).toHaveLength(0);
    // D-C6 after conversion: the successor.
    expect(
      await sendAgentMessage(runId, "late steer", {
        db,
        mode: "steer",
        requestKey: "late",
      }),
    ).toMatchObject({ messageId: successor.id, delivery: "queued" });
    // One transcript row for the message, now delivered as a prompt.
    expect(
      (await userRows(runId)).filter((row) => row.content === "late steer"),
    ).toMatchObject([
      { delivery: "prompted", promptDispatchKey: `steer:${steer.commandId}` },
    ]);
  }, 150_000);

  it("T3.4: two concurrent steers serialize on the run row — consecutive ordinals, both injected, rows in order", async () => {
    const runId = await seedPersistentAgent();

    startDriver(runId);
    const parent = await runningTurn(runId);
    const trigger = `steer_race_${runId.replaceAll("-", "")}`;
    const lockKey = Math.floor(Math.random() * 2_000_000_000) + 1;
    const lock = await database.pool.connect();

    try {
      await lock.query("SELECT pg_advisory_lock(260925, $1)", [lockKey]);
      await database.pool.query(
        `CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.run_id = '${runId}' AND NEW.variant = 'steer' THEN PERFORM pg_advisory_xact_lock(260925, ${lockKey}); END IF; RETURN NEW; END $$`,
      );
      await database.pool.query(
        `CREATE TRIGGER ${trigger} BEFORE INSERT ON agent_turns FOR EACH ROW EXECUTE FUNCTION ${trigger}()`,
      );
      const racers = ["race one", "race two"].map((text) =>
        sendAgentMessage(runId, text, { db, mode: "steer" }),
      );

      // The winner allocated its ordinal and waits inside its transaction;
      // the loser waits for the run row it locks first (its full-row
      // `SELECT … FOR UPDATE`, blocked by the winner) — not for the ordinal's
      // unique index. The select list outgrows `track_activity_query_size`,
      // so the statement is matched by its head and its blocker.
      await expect
        .poll(
          async () => {
            const waits = await database.pool.query<{
              advisory: number;
              run_row: number;
            }>(
              `SELECT
                 (SELECT count(*)::int FROM pg_locks WHERE locktype = 'advisory' AND classid = 260925 AND objid = $1 AND NOT granted) AS advisory,
                 (SELECT count(*)::int FROM pg_stat_activity loser
                   WHERE loser.wait_event_type = 'Lock'
                     AND loser.query ILIKE 'select "id", "run_kind"%'
                     AND EXISTS (SELECT 1 FROM pg_locks winner
                       WHERE winner.locktype = 'advisory' AND winner.classid = 260925
                         AND winner.objid = $1 AND NOT winner.granted
                         AND winner.pid = ANY (pg_blocking_pids(loser.pid)))) AS run_row`,
              [lockKey],
            );

            return waits.rows[0];
          },
          { timeout: 30_000, interval: 25 },
        )
        .toEqual({ advisory: 1, run_row: 1 });
      await lock.query("SELECT pg_advisory_unlock_all()");
      const results = await Promise.all(racers);

      expect(results.map((result) => result.delivery)).toEqual([
        "steered",
        "steered",
      ]);
      const steers = (await turnsOf(runId)).filter(
        (row) => row.variant === "steer",
      );

      expect(steers.map((row) => row.ordinal)).toEqual([
        parent.ordinal + 1,
        parent.ordinal + 2,
      ]);
      expect(steers.map((row) => row.state)).toEqual(["applied", "applied"]);
      expect(
        (await userRows(runId))
          .filter((row) => row.delivery === "steered")
          .map((row) => row.content),
      ).toEqual(steers.map((row) => row.prompt));
    } finally {
      await lock.query("SELECT pg_advisory_unlock_all()");
      lock.release();
      await database.pool.query(
        `DROP TRIGGER IF EXISTS ${trigger} ON agent_turns`,
      );
      await database.pool.query(`DROP FUNCTION IF EXISTS ${trigger}()`);
    }
    await releasePrompt(runId, 1);
    await awaitRunStatus(runId, "NeedsInputIdle");
  }, 120_000);

  it("T3.4: a steer racing a queued message serializes on the run row — consecutive ordinals, each delivered once", async () => {
    const runId = await seedPersistentAgent();

    startDriver(runId);
    const parent = await runningTurn(runId);
    const trigger = `mixed_race_${runId.replaceAll("-", "")}`;
    const lockKey = Math.floor(Math.random() * 2_000_000_000) + 1;
    const lock = await database.pool.connect();
    let steered: Awaited<ReturnType<typeof sendAgentMessage>>;
    let queued: Awaited<ReturnType<typeof sendAgentMessage>>;

    try {
      await lock.query("SELECT pg_advisory_lock(260927, $1)", [lockKey]);
      // The steer takes the run row and parks while inserting its turn; the
      // queued message must wait for that row, not race it for an ordinal.
      await database.pool.query(
        `CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.run_id = '${runId}' AND NEW.variant = 'steer' THEN PERFORM pg_advisory_xact_lock(260927, ${lockKey}); END IF; RETURN NEW; END $$`,
      );
      await database.pool.query(
        `CREATE TRIGGER ${trigger} BEFORE INSERT ON agent_turns FOR EACH ROW EXECUTE FUNCTION ${trigger}()`,
      );
      const steering = sendAgentMessage(runId, "race steer", {
        db,
        mode: "steer",
      });

      await expect
        .poll(
          async () =>
            (
              await database.pool.query<{ count: number }>(
                "SELECT count(*)::int AS count FROM pg_locks WHERE locktype = 'advisory' AND classid = 260927 AND objid = $1 AND NOT granted",
                [lockKey],
              )
            ).rows[0].count,
          { timeout: 30_000, interval: 25 },
        )
        .toBe(1);
      const queueing = sendAgentMessage(runId, "race queue", {
        db,
        mode: "queue",
      });

      await expect
        .poll(
          async () =>
            (
              await database.pool.query<{ count: number }>(
                `SELECT count(*)::int AS count FROM pg_stat_activity loser
                 WHERE loser.wait_event_type = 'Lock'
                   AND EXISTS (SELECT 1 FROM pg_locks winner
                     WHERE winner.locktype = 'advisory' AND winner.classid = 260927
                       AND winner.objid = $1 AND NOT winner.granted
                       AND winner.pid = ANY (pg_blocking_pids(loser.pid)))`,
                [lockKey],
              )
            ).rows[0].count,
          { timeout: 30_000, interval: 25 },
        )
        .toBe(1);
      await lock.query("SELECT pg_advisory_unlock_all()");
      [steered, queued] = await Promise.all([steering, queueing]);
    } finally {
      await lock.query("SELECT pg_advisory_unlock_all()");
      lock.release();
      await database.pool.query(
        `DROP TRIGGER IF EXISTS ${trigger} ON agent_turns`,
      );
      await database.pool.query(`DROP FUNCTION IF EXISTS ${trigger}()`);
    }
    expect(steered).toMatchObject({
      messageState: "applied",
      delivery: "steered",
    });
    expect(queued).toMatchObject({
      messageState: "queued",
      delivery: "queued",
    });
    expect(
      (await turnsOf(runId)).slice(1).map((row) => [row.variant, row.ordinal]),
    ).toEqual([
      ["steer", parent.ordinal + 1],
      ["live_message", parent.ordinal + 2],
    ]);
    await releasePrompt(runId, 1);
    await awaitTurnState(parent.id, "applied");
    const continuation = startAgentContinuationWorker({ db });

    try {
      await releasePrompt(runId, 2);
      await awaitTurnState(queued.messageId, "applied", 60_000);
      await awaitRunStatus(runId, "NeedsInputIdle");
    } finally {
      await continuation.stop();
    }
    expect(await adapterCalls(runId, "session/prompt")).toHaveLength(2);
    expect(await adapterCalls(runId, "_session/steering")).toHaveLength(1);
  }, 150_000);

  it("T3.5: every agent prompt is recorded once at dispatch, bounded, ahead of its turn's reply", async () => {
    const runId = await seedPersistentAgent();
    const initialDriver = startDriver(runId);

    await runningTurn(runId);
    await releasePrompt(runId, 1);
    await expect
      .poll(initialDriver.returned, { timeout: 45_000, interval: 50 })
      .toBe(true);
    await awaitRunStatus(runId, "NeedsInputIdle");

    const message = sendAgentMessage(runId, "message one", {
      db,
      requestKey: "record-1",
    });

    await releasePrompt(runId, 2);
    expect(await message).toMatchObject({ messageState: "applied" });
    // The same key again: the same row, no second dispatch.
    expect(
      await sendAgentMessage(runId, "message one", {
        db,
        requestKey: "record-1",
      }),
    ).toMatchObject({ messageState: "applied" });

    expect((await claimAgentResumeSlot(db, runId)).outcome).toBe("claimed");
    const resumeDriver = startDriver(runId);

    await releasePrompt(runId, 3);
    await expect
      .poll(resumeDriver.returned, { timeout: 45_000, interval: 50 })
      .toBe(true);
    await awaitRunStatus(runId, "NeedsInputIdle");

    const large = sendAgentMessage(runId, "y".repeat(1_000_000), { db });

    await releasePrompt(runId, 4);
    expect(await large).toMatchObject({ messageState: "applied" });

    const turns = await turnsOf(runId);

    expect(turns.map((row) => row.variant)).toEqual([
      "initial",
      "persistent_message",
      "resume",
      "persistent_message",
    ]);
    const rows = await userRows(runId);

    expect(rows.map((row) => [row.promptDispatchKey, row.delivery])).toEqual(
      turns.map((row) => [
        `agent_turn:${row.variant}:${row.id}:${row.ordinal}`,
        "prompted",
      ]),
    );
    const bounded = rows[3].content;

    expect(bounded.endsWith(PROMPT_TRUNCATION_MARKER)).toBe(true);
    expect(Buffer.byteLength(bounded, "utf8")).toBeLessThanOrEqual(
      PROMPT_BODY_MAX_BYTES,
    );
    // Each prompt precedes the reply of its own turn.
    expect((await dialog(runId)).map(([role]) => role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
  }, 180_000);

  it("an intent orphaned by recovery converts into ONE successor, delivered exactly once", async () => {
    const runId = await seedPersistentAgent();

    startDriver(runId);
    const parent = await runningTurn(runId);
    const barrier = await holdSteer(runId, `orphan-${runId}`);

    // The issuing manager dies with its request still on the wire: the host
    // never sees it.
    void sendAgentMessage(runId, "orphaned steer", {
      db,
      mode: "steer",
      executionHosts: managerDyingInBackoff(),
    }).catch(() => undefined);
    await barrier.awaitReached();
    const steer = steerOf(await turnsOf(runId));

    await recoverExecutionCommands({
      db,
      transport: defaultTransport(),
      graceMs: 0,
    });
    barrier.cut();
    const successor = (await turnsOf(runId)).find(
      (row) => row.logicalKey === `message:requeue:${steer.id}`,
    ) as AgentTurn;

    expect((await turn(steer.id)).state).toBe("superseded");
    expect(successor).toMatchObject({
      prompt: "orphaned steer",
      state: "queued",
    });
    expect(await commandsOf(runId, "session.steer")).toMatchObject([
      {
        id: steer.commandId,
        state: "failed",
        lastError: { code: "CRASH", reason: "ORPHANED" },
      },
    ]);
    await releasePrompt(runId, 1);
    await awaitTurnState(parent.id, "applied");
    const continuation = startAgentContinuationWorker({ db });

    try {
      await releasePrompt(runId, 2);
      await awaitTurnState(successor.id, "applied", 60_000);
    } finally {
      await continuation.stop();
    }
    expect(await adapterCalls(runId, "session/prompt")).toHaveLength(2);
    expect(await adapterCalls(runId, "_session/steering")).toHaveLength(0);
  }, 150_000);

  it("a steer converted after its run closed leaves no queued successor behind", async () => {
    const runId = await seedPersistentAgent();

    startDriver(runId);
    await runningTurn(runId);
    const barrier = await holdSteer(runId, `closed-${runId}`);

    void sendAgentMessage(runId, "too late", {
      db,
      mode: "steer",
      executionHosts: managerDyingInBackoff(),
    }).catch(() => undefined);
    await barrier.awaitReached();
    const steer = steerOf(await turnsOf(runId));

    expect(await markAbandoned(runId, { db })).toMatchObject({ ok: true });
    await recoverExecutionCommands({
      db,
      transport: defaultTransport(),
      graceMs: 0,
    });
    barrier.cut();
    const successor = (await turnsOf(runId)).find(
      (row) => row.logicalKey === `message:requeue:${steer.id}`,
    ) as AgentTurn;

    expect((await turn(steer.id)).state).toBe("superseded");
    expect(successor.state).toBe("superseded");
    expect((await runOf(runId)).resumeRequestedAt).toBeNull();
  }, 150_000);
});

describe("steer outcome startedNewTurn (ADR-182 S5b)", () => {
  beforeAll(async () => {
    await restartSupervisor([
      "--steering",
      "--steer-outcome",
      "startedNewTurn",
    ]);
  }, 120_000);

  it("converts once: the successor waits for the parent and is delivered exactly once", async () => {
    const runId = await seedPersistentAgent();

    startDriver(runId);
    const parent = await runningTurn(runId);
    const result = await sendAgentMessage(runId, "new turn steer", {
      db,
      mode: "steer",
      requestKey: "started",
    });
    const steer = steerOf(await turnsOf(runId));
    const successor = (await turnsOf(runId)).find(
      (row) => row.logicalKey === `message:requeue:${steer.id}`,
    ) as AgentTurn;

    expect(result).toEqual({
      childRunId: runId,
      messageId: successor.id,
      status: "Running",
      messageState: "queued",
      delivery: "queued",
    });
    expect(steer.state).toBe("superseded");
    expect(successor).toMatchObject({
      variant: "live_message",
      ordinal: steer.ordinal + 1,
      state: "queued",
    });
    expect((await runOf(runId)).resumeRequestedAt).not.toBeNull();
    expect(
      await sendAgentMessage(runId, "new turn steer", {
        db,
        mode: "steer",
        requestKey: "started",
      }),
    ).toMatchObject({ messageId: successor.id, delivery: "queued" });

    await releasePrompt(runId, 1);
    await awaitTurnState(parent.id, "applied");
    const continuation = startAgentContinuationWorker({ db });

    try {
      await releasePrompt(runId, 2);
      await awaitTurnState(successor.id, "applied", 60_000);
      await awaitRunStatus(runId, "NeedsInputIdle");
    } finally {
      await continuation.stop();
    }
    expect(await adapterCalls(runId, "session/prompt")).toHaveLength(2);
    expect(
      (await adapterCalls(runId, "_session/steering")).map(
        (row) => row.outcome,
      ),
    ).toEqual(["startedNewTurn"]);
    // One transcript row for the message, now delivered as a prompt.
    expect(
      (await userRows(runId))
        .filter((row) => row.content === "new turn steer")
        .map((row) => ({
          delivery: row.delivery,
          promptDispatchKey: row.promptDispatchKey,
        })),
    ).toEqual([
      { delivery: "prompted", promptDispatchKey: `steer:${steer.commandId}` },
    ]);
  }, 150_000);
});

describe("a session without steering (ADR-182 S3)", () => {
  beforeAll(async () => {
    await restartSupervisor([]);
  }, 120_000);

  it("falls back to an ordinary queued message and never issues session.steer", async () => {
    const runId = await seedPersistentAgent();

    startDriver(runId);
    const parent = await runningTurn(runId);
    const steered = await sendAgentMessage(runId, "fallback one", {
      db,
      mode: "steer",
    });
    const queued = await sendAgentMessage(runId, "fallback two", {
      db,
      mode: "queue",
    });
    const turns = await turnsOf(runId);

    expect(turns.slice(1)).toMatchObject([
      {
        id: steered.messageId,
        variant: "live_message",
        ordinal: parent.ordinal + 1,
        state: "queued",
      },
      {
        id: queued.messageId,
        variant: "live_message",
        ordinal: parent.ordinal + 2,
        state: "queued",
      },
    ]);
    expect(steered).toMatchObject({
      messageState: "queued",
      delivery: "queued",
    });
    expect(queued).toMatchObject({
      messageState: "queued",
      delivery: "queued",
    });
    expect(await commandsOf(runId, "session.steer")).toHaveLength(0);

    await releasePrompt(runId, 1);
    await awaitTurnState(parent.id, "applied");
    const continuation = startAgentContinuationWorker({ db });

    try {
      await releasePrompt(runId, 2);
      await awaitTurnState(steered.messageId, "applied", 60_000);
      await releasePrompt(runId, 3);
      await awaitTurnState(queued.messageId, "applied", 60_000);
      await awaitRunStatus(runId, "NeedsInputIdle");
    } finally {
      await continuation.stop();
    }
    expect(await adapterCalls(runId, "_session/steering")).toHaveLength(0);
    expect(await commandsOf(runId, "session.steer")).toHaveLength(0);
  }, 180_000);

  it("D-C2: a run blocked on a permission accepts the message and defers it (run_state)", async () => {
    const runId = await seedPersistentAgent(
      { bytes: 0, permission: true },
      "worktree",
    );

    startDriver(runId);
    await runningTurn(runId);
    await releasePrompt(runId, 1);
    await awaitRunStatus(runId, "NeedsInput");
    const result = await sendAgentMessage(runId, "while blocked", {
      db,
      mode: "steer",
    });

    expect(result).toMatchObject({
      status: "NeedsInput",
      messageState: "queued",
      delivery: "queued",
    });
    expect((await runOf(runId)).resumeRequestedAt).toBeNull();
    expect(await commandsOf(runId, "session.steer")).toHaveLength(0);
  }, 120_000);
});
