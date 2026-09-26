// ADR-182 Phase 4 (T4.1–T4.4): a scratch dialog accepts a message while its
// agent is busy — steered into the running turn when the session advertised
// steering, queued for the next turn otherwise — against a real Postgres and a
// REAL supervisor. The mock adapter holds every prompt until SIGUSR1
// (`--controlled-prompt`) after emitting assistant text (`--pre-hold-text`),
// so the tests decide when a turn ends; steer requests pass through the fault
// proxy so a test can hold one while the turn moves on.

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
import { defaultTransport } from "@/lib/execution-host/default-transport";
import { recoverExecutionCommands } from "@/lib/execution-host/recovery";
import { appendScratchMessage } from "@/lib/scratch-runs/messages";
import { startProjectionWorker } from "@/lib/execution-host/events/projection-worker";
import { stopRuntimeEventConsumers } from "@/lib/execution-host/events/consumer";
import { resetRegistrarStateForTests } from "@/lib/execution-host/registrar";
import { resetResolverForTests } from "@/lib/execution-host/resolver";
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
const USER_ID = "scratch-steering-user";
const PRE_HOLD = "before the steer";

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
let proxy: SupervisorFaultProxy;
let worker: ProjectionWorker;
let restoreUrl: () => void = () => {};
let projectId: string;
let logDir: string;
let adapterLog: string;
const savedEnv: Record<string, string | undefined> = {};

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

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args]);

  return stdout;
}

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "scratch_steering",
  });
  db = testDatabase.db;
  logDir = await mkdtemp(join(tmpdir(), "scratch-steering-"));
  adapterLog = join(logDir, "adapter-invocations.ndjson");
  supervisor = await startRealSupervisor({
    fixtureArgs: fixtureArgs(["--steering", "--steer-echo"]),
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
  // Every test leaves its dialog open (a live run): the file outgrows the
  // default cap of 6.
  process.env.MAISTER_MAX_CONCURRENT_RUNS = "64";
  process.env.MAISTER_RUNTIME_ROOT = join(supervisor.runtimeRoot, "runtime");
  process.env.MAISTER_WORKTREES_ROOT = join(
    supervisor.runtimeRoot,
    "worktrees",
  );

  const repo = await mkdtemp(join(supervisor.runtimeRoot, "repo-"));
  const runnerId = randomUUID();

  await execFileAsync("git", ["init", "-q", "-b", "main", repo]);
  await git(repo, "config", "user.email", "t@t.local");
  await git(repo, "config", "user.name", "T");
  await git(repo, "config", "commit.gpgsign", "false");
  await writeFile(join(repo, "base.txt"), "base\n");
  await git(repo, "add", "-A");
  await git(repo, "commit", "-q", "-m", "base");

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
    slug: `scratch-${projectId.slice(0, 8)}`,
    name: "Scratch steering",
    repoPath: repo,
    taskKey: "SST",
  });
}, 240_000);

afterAll(async () => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await stopRuntimeEventConsumers();
  restoreUrl();
  await proxy?.close();
  await worker?.stop();
  await supervisor?.kill();
  await testDatabase?.stop();
  await rm(logDir, { recursive: true, force: true });
});

async function restartSupervisor(extra: string[]): Promise<void> {
  supervisor = await supervisor.restart({
    port: supervisor.port,
    fixtureArgs: fixtureArgs(extra),
  });
  resetRegistrarStateForTests();
  resetResolverForTests();
}

function launchBody(prompt: string): ScratchLaunchInput {
  return {
    projectId,
    baseBranch: "main",
    prompt,
    reasoningEffort: "high",
    attachments: [],
  };
}

// The launch awaits its own first turn, which the adapter holds: run it in
// the background and hand back the run id as soon as the run exists.
async function launchHeld(prompt: string): Promise<{
  runId: string;
  done: Promise<unknown>;
}> {
  const staged = service.launchScratchRunStaged({
    body: launchBody(prompt),
    userId: USER_ID,
  });
  let runId: string | null = null;
  const done = (async () => {
    for (;;) {
      const step = await staged.next();

      if (step.done) return step.value;
    }
  })();

  await expect
    .poll(
      async () => {
        const rows = await db
          .select({ id: schema.runs.id })
          .from(schema.runs)
          .where(
            and(
              eq(schema.runs.projectId, projectId),
              eq(schema.runs.runKind, "scratch"),
            ),
          );

        runId =
          rows.map((run) => run.id).find((id) => !launched.has(id)) ?? null;

        return runId;
      },
      { timeout: 30_000, interval: 25 },
    )
    .not.toBeNull();
  launched.add(runId as unknown as string);

  return { runId: runId as unknown as string, done };
}

const launched = new Set<string>();

type Invocation = {
  pid: number;
  sessionId: string;
  method: string;
  requestSha256?: string;
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
        const [session] = await db
          .select({ acpSessionId: schema.runSessions.acpSessionId })
          .from(schema.runSessions)
          .where(eq(schema.runSessions.runId, runId));

        acpSessionId = session?.acpSessionId ?? null;

        return acpSessionId;
      },
      { timeout: 30_000, interval: 25 },
    )
    .not.toBeNull();

  return acpSessionId as unknown as string;
}

async function adapterCalls(runId: string, method: string) {
  const acpSessionId = await acpSessionOf(runId);

  return (await invocations()).filter(
    (row) => row.method === method && row.sessionId === acpSessionId,
  );
}

// SIGUSR1 to the adapter holding the run's `n`-th prompt ends that turn.
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

async function dialogStatus(runId: string): Promise<string> {
  const [row] = await db
    .select({ dialogStatus: schema.scratchRuns.dialogStatus })
    .from(schema.scratchRuns)
    .where(eq(schema.scratchRuns.runId, runId));

  return row.dialogStatus;
}

async function awaitDialog(runId: string, status: string): Promise<void> {
  await expect
    .poll(() => dialogStatus(runId), { timeout: 45_000, interval: 50 })
    .toBe(status);
}

async function prompts(runId: string) {
  return db
    .select()
    .from(schema.executionCommands)
    .where(
      and(
        eq(schema.executionCommands.runId, runId),
        eq(schema.executionCommands.kind, "session.prompt"),
      ),
    )
    .orderBy(asc(schema.executionCommands.createdAt));
}

async function steers(runId: string) {
  return db
    .select()
    .from(schema.executionCommands)
    .where(
      and(
        eq(schema.executionCommands.runId, runId),
        eq(schema.executionCommands.kind, "session.steer"),
      ),
    );
}

async function userRows(runId: string) {
  return db
    .select()
    .from(schema.runMessages)
    .where(
      and(
        eq(schema.runMessages.runId, runId),
        eq(schema.runMessages.role, "user"),
      ),
    )
    .orderBy(asc(schema.runMessages.sequence));
}

async function row(messageId: string) {
  const [message] = await db
    .select()
    .from(schema.runMessages)
    .where(eq(schema.runMessages.id, messageId));

  return message;
}

// The first turn is running and its text before the hold is projected: the
// operator has seen it when they type.
async function runningTurn(runId: string): Promise<void> {
  await expect
    .poll(async () => (await prompts(runId)).map((command) => command.state), {
      timeout: 45_000,
      interval: 25,
    })
    .toEqual(["accepted"]);
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
            .select({ id: schema.runMessages.id })
            .from(schema.runMessages)
            .where(
              and(
                eq(schema.runMessages.runId, runId),
                eq(schema.runMessages.role, "assistant"),
                eq(schema.runMessages.content, PRE_HOLD),
              ),
            )
        ).length,
      { timeout: 15_000, interval: 25 },
    )
    .toBe(1);
}

async function dialog(runId: string): Promise<Array<[string, string]>> {
  const rows = await db
    .select()
    .from(schema.runMessages)
    .where(eq(schema.runMessages.runId, runId))
    .orderBy(asc(schema.runMessages.sequence));

  return rows
    .filter(
      (message) => message.role === "user" || message.role === "assistant",
    )
    .map((message) => [message.role, message.content]);
}

function send(runId: string, content: string) {
  return service.sendScratchUserMessage({
    runId,
    body: { content, attachments: [] },
  });
}

// A proxy rule that matches only this run's steers, so a rule a failed test
// left armed cannot capture the next test's steer.
async function steerPath(runId: string): Promise<RegExp> {
  let hostSessionId: string | null = null;

  await expect
    .poll(
      async () => {
        const [session] = await db
          .select({ hostSessionId: schema.runSessions.hostSessionId })
          .from(schema.runSessions)
          .where(eq(schema.runSessions.runId, runId));

        hostSessionId = session?.hostSessionId ?? null;

        return hostSessionId;
      },
      { timeout: 30_000, interval: 25 },
    )
    .not.toBeNull();

  return new RegExp(`^/sessions/${hostSessionId}/steer$`);
}

// A manager that dies in its retry backoff: the wait never ends, so nothing
// after an unknown outcome runs in this process.
function managerDyingInBackoff() {
  return createExecutionHosts({
    db: db as unknown as Db,
    sleep: () => new Promise<void>(() => {}),
  });
}

function recover() {
  return recoverExecutionCommands({
    db: db as unknown as Db,
    transport: defaultTransport(),
    graceMs: 0,
  });
}

describe("scratch message while the agent is busy — steering session (ADR-182)", () => {
  it("S4a: steers into the running turn; the dialog stays Running; the reply follows the steered row", async () => {
    const { runId, done } = await launchHeld("message one");

    await runningTurn(runId);
    const response = await send(runId, "message two");

    expect(response).toMatchObject({
      ok: true,
      delivery: "steered",
      dialogStatus: "Running",
    });
    expect(response.stopReason).toBeUndefined();
    const steered = await row(response.messageId);
    const [steer] = await steers(runId);

    expect(steered).toMatchObject({
      delivery: "steered",
      steerCommandId: steer.id,
    });
    expect(steer.state).toBe("succeeded");
    expect(await dialogStatus(runId)).toBe("Running");

    await releasePrompt(runId, 1);
    await done;
    await awaitDialog(runId, "WaitingForUser");
    expect(await dialog(runId)).toEqual([
      ["user", "message one"],
      ["assistant", PRE_HOLD],
      ["user", "message two"],
      ["assistant", expect.stringContaining("steered:message two")],
    ]);
    // `--steer-echo` echoed the steer as a user chunk: still one user row.
    expect(
      (await userRows(runId)).filter(
        (message) => message.content === "message two",
      ),
    ).toHaveLength(1);
    expect(await adapterCalls(runId, "session/prompt")).toHaveLength(1);
  }, 120_000);

  it("S5-scratch: a refused steer flips back to queued and is dispatched exactly once", async () => {
    const { runId, done } = await launchHeld("message one");

    await runningTurn(runId);
    const barrier = proxy.arm(
      {
        caseId: `scratch-refusal-${runId}`,
        method: "POST",
        path: await steerPath(runId),
      },
      "hold-request",
    );
    const sending = send(runId, "late message");

    try {
      await barrier.awaitReached();
      // The turn ends while the steer is in flight: the WaitingForUser
      // commit's dispatcher finds nothing queued (the row is still `steered`).
      await releasePrompt(runId, 1);
      await done;
      await awaitDialog(runId, "WaitingForUser");
    } finally {
      barrier.release();
    }
    const response = await sending;

    expect(response).toMatchObject({ delivery: "queued" });
    // The conversion wakes the dispatcher: the row becomes the next prompt.
    await releasePrompt(runId, 2);
    await expect
      .poll(async () => (await row(response.messageId)).delivery, {
        timeout: 45_000,
        interval: 50,
      })
      .toBe("prompted");
    await awaitDialog(runId, "WaitingForUser");
    expect(await adapterCalls(runId, "session/prompt")).toHaveLength(2);
    expect(await adapterCalls(runId, "_session/steering")).toHaveLength(0);
    const [refused] = await steers(runId);

    expect(refused.state).toBe("failed");
    expect(refused.lastError).toMatchObject({
      details: { reason: "steer_no_active_turn" },
    });
    expect(
      (await prompts(runId)).map((command) => command.applicationState),
    ).toEqual(["applied", "applied"]);
  }, 150_000);

  it("T4.4: two concurrent sends while running serialize on the run row — consecutive rows, both steered", async () => {
    const { runId, done } = await launchHeld("message one");

    await runningTurn(runId);
    const trigger = `scratch_send_race_${runId.replaceAll("-", "")}`;
    const lockKey = Math.floor(Math.random() * 2_000_000_000) + 1;
    const lock = await testDatabase.pool.connect();
    let results: Array<Awaited<ReturnType<typeof send>>> = [];

    try {
      await lock.query("SELECT pg_advisory_lock(260928, $1)", [lockKey]);
      // The first sender parks while inserting its row, holding the run and
      // scratch rows; the second must wait for them, not race the sequence.
      await testDatabase.pool.query(
        `CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.run_id = '${runId}' AND NEW.role = 'user' AND NEW.delivery = 'steered' THEN PERFORM pg_advisory_xact_lock(260928, ${lockKey}); END IF; RETURN NEW; END $$`,
      );
      await testDatabase.pool.query(
        `CREATE TRIGGER ${trigger} BEFORE INSERT ON run_messages FOR EACH ROW EXECUTE FUNCTION ${trigger}()`,
      );
      const first = send(runId, "race one");

      await expect
        .poll(
          async () =>
            (
              await testDatabase.pool.query<{ count: number }>(
                "SELECT count(*)::int AS count FROM pg_locks WHERE locktype = 'advisory' AND classid = 260928 AND objid = $1 AND NOT granted",
                [lockKey],
              )
            ).rows[0].count,
          { timeout: 30_000, interval: 25 },
        )
        .toBe(1);
      const second = send(runId, "race two");

      await expect
        .poll(
          async () =>
            (
              await testDatabase.pool.query<{ count: number }>(
                `SELECT count(*)::int AS count FROM pg_stat_activity loser
                 WHERE loser.wait_event_type = 'Lock'
                   AND EXISTS (SELECT 1 FROM pg_locks winner
                     WHERE winner.locktype = 'advisory' AND winner.classid = 260928
                       AND winner.objid = $1 AND NOT winner.granted
                       AND winner.pid = ANY (pg_blocking_pids(loser.pid)))`,
                [lockKey],
              )
            ).rows[0].count,
          { timeout: 30_000, interval: 25 },
        )
        .toBe(1);
      await lock.query("SELECT pg_advisory_unlock_all()");
      results = await Promise.all([first, second]);
    } finally {
      await lock.query("SELECT pg_advisory_unlock_all()");
      lock.release();
      await testDatabase.pool.query(
        `DROP TRIGGER IF EXISTS ${trigger} ON run_messages`,
      );
      await testDatabase.pool.query(`DROP FUNCTION IF EXISTS ${trigger}()`);
    }

    expect(results.map((result) => result.delivery)).toEqual([
      "steered",
      "steered",
    ]);
    expect(results[1].sequence).toBe(results[0].sequence + 1);
    await releasePrompt(runId, 1);
    await done;
    await awaitDialog(runId, "WaitingForUser");
    expect(
      (await adapterCalls(runId, "_session/steering")).map(
        (call) => call.outcome,
      ),
    ).toEqual(["injected", "injected"]);
  }, 120_000);
});

describe("scratch steer with a lost answer (ADR-182 exactly-once)", () => {
  it("answers an unknown steer outcome as steered, converts nothing, and the receipt fold applies it once", async () => {
    const { runId, done } = await launchHeld("message one");

    await runningTurn(runId);
    const lost = proxy.arm(
      {
        caseId: `scratch-lost-answers-${runId}`,
        method: "POST",
        path: await steerPath(runId),
      },
      "drop-responses",
    );
    let response: Awaited<ReturnType<typeof send>>;

    try {
      // Every attempt reaches the host; every answer is lost.
      response = await send(runId, "message two");
      expect(lost.observations).toHaveLength(3);
    } finally {
      lost.release();
    }
    expect(response).toMatchObject({
      delivery: "steered",
      dialogStatus: "Running",
    });
    const [pending] = await steers(runId);

    expect(pending.state).toBe("delivering");
    expect((await row(response.messageId)).delivery).toBe("steered");

    await recover();
    const [folded] = await steers(runId);

    expect(folded.state).toBe("succeeded");
    expect((await row(response.messageId)).delivery).toBe("steered");
    await releasePrompt(runId, 1);
    await done;
    await awaitDialog(runId, "WaitingForUser");
    expect(await adapterCalls(runId, "_session/steering")).toHaveLength(1);
    expect(await adapterCalls(runId, "session/prompt")).toHaveLength(1);
  }, 150_000);

  it("reconciles a steer whose answer was lost and whose manager died before the retry from its receipt — never re-queued", async () => {
    const { runId, done } = await launchHeld("message one");

    await runningTurn(runId);
    const lost = proxy.arm(
      {
        caseId: `scratch-dead-manager-${runId}`,
        method: "POST",
        path: await steerPath(runId),
      },
      "hold-response",
    );

    void service
      .sendScratchUserMessage({
        runId,
        body: { content: "message two", attachments: [] },
        executionHosts: managerDyingInBackoff(),
      })
      .catch(() => undefined);
    try {
      await lost.awaitReached();
    } finally {
      if (lost.observations.length > 0) lost.cut();
    }
    // The first attempt injected; its answer is gone and the manager is dead
    // in the backoff, leaving the command re-queued with one attempt.
    await expect
      .poll(async () => (await steers(runId))[0]?.state, {
        timeout: 30_000,
        interval: 25,
      })
      .toBe("queued");
    expect((await steers(runId))[0].attempts).toBe(1);

    await recover();
    const [settled] = await steers(runId);
    const [steered] = (await userRows(runId)).filter(
      (message) => message.content === "message two",
    );

    expect(settled.state).toBe("succeeded");
    expect(steered.delivery).toBe("steered");
    await releasePrompt(runId, 1);
    await done;
    await awaitDialog(runId, "WaitingForUser");
    expect(await adapterCalls(runId, "_session/steering")).toHaveLength(1);
    expect(await adapterCalls(runId, "session/prompt")).toHaveLength(1);
  }, 150_000);

  it("a refusal folded by recovery re-queues the message and wakes the queue although the dialog is already waiting", async () => {
    const { runId, done } = await launchHeld("message one");

    await runningTurn(runId);
    const path = await steerPath(runId);
    const held = proxy.arm(
      { caseId: `scratch-held-${runId}`, method: "POST", path },
      "hold-request",
    );
    const lost = proxy.arm(
      { caseId: `scratch-refusal-lost-${runId}`, method: "POST", path },
      "drop-responses",
    );

    void service
      .sendScratchUserMessage({
        runId,
        body: { content: "late message", attachments: [] },
        executionHosts: managerDyingInBackoff(),
      })
      .catch(() => undefined);
    let released = false;

    try {
      await held.awaitReached();
      // The turn ends first: its completion finds nothing queued.
      await releasePrompt(runId, 1);
      await done;
      await awaitDialog(runId, "WaitingForUser");
      held.release();
      released = true;
      // The host refuses (the parent is over); the answer is lost and the
      // manager dies in the backoff.
      await expect
        .poll(() => lost.observations.length, { timeout: 30_000 })
        .toBe(1);
    } finally {
      // Only a reached rule can be disposed; an unreached one fails the
      // drain check, which is the point.
      if (!released && held.observations.length > 0) held.cut();
      if (lost.observations.length > 0) lost.release();
    }
    await expect
      .poll(async () => (await steers(runId))[0]?.state, {
        timeout: 30_000,
        interval: 25,
      })
      .toBe("queued");

    await recover();
    const [refused] = await steers(runId);
    const [late] = (await userRows(runId)).filter(
      (message) => message.content === "late message",
    );

    expect(refused.state).toBe("failed");
    await expect
      .poll(async () => (await row(late.id)).delivery, {
        timeout: 45_000,
        interval: 50,
      })
      .toBe("prompted");
    await releasePrompt(runId, 2);
    await awaitDialog(runId, "WaitingForUser");
    expect(await adapterCalls(runId, "session/prompt")).toHaveLength(2);
    expect(await adapterCalls(runId, "_session/steering")).toHaveLength(0);
  }, 180_000);
});

describe("scratch message while the agent is busy — no steering (ADR-182 S4b)", () => {
  beforeAll(async () => {
    await restartSupervisor([]);
  }, 120_000);

  it("S4b: queues while running and dispatches FIFO when each turn ends, detached from the ending turn", async () => {
    const { runId, done } = await launchHeld("message one");

    await runningTurn(runId);
    const second = await send(runId, "message two");

    expect(second).toMatchObject({
      delivery: "queued",
      dialogStatus: "Running",
    });
    expect((await row(second.messageId)).delivery).toBe("queued");
    expect(await steers(runId)).toHaveLength(0);

    await releasePrompt(runId, 1);
    await done;
    // Turn 1's application committed and returned while turn 2 — dispatched
    // from its afterCommit — is still running on the host (C27).
    await expect
      .poll(
        async () =>
          (await prompts(runId)).map((command) => [
            command.state,
            command.applicationState,
          ]),
        { timeout: 45_000, interval: 50 },
      )
      .toEqual([
        ["succeeded", "applied"],
        ["accepted", "pending"],
      ]);
    expect((await prompts(runId))[0].completionAppliedAt).not.toBeNull();
    expect((await row(second.messageId)).delivery).toBe("prompted");
    expect(await dialogStatus(runId)).toBe("Running");

    const third = await send(runId, "message three");

    expect(third).toMatchObject({ delivery: "queued" });
    await releasePrompt(runId, 2);
    await expect
      .poll(async () => (await row(third.messageId)).delivery, {
        timeout: 45_000,
        interval: 50,
      })
      .toBe("prompted");
    await releasePrompt(runId, 3);
    await awaitDialog(runId, "WaitingForUser");
    expect(
      (await prompts(runId)).map((command) => command.applicationState),
    ).toEqual(["applied", "applied", "applied"]);
    expect(
      (await userRows(runId)).map((message) => [
        message.content,
        message.delivery,
      ]),
    ).toEqual([
      ["message one", null],
      ["message two", "prompted"],
      ["message three", "prompted"],
    ]);
  }, 180_000);

  it("Stop while running: the interrupted turn ends and the queued message is dispatched", async () => {
    const { runId, done } = await launchHeld("message one");

    await runningTurn(runId);
    const queued = await send(runId, "after the stop");

    expect(queued).toMatchObject({ delivery: "queued" });
    expect(await service.interruptScratchRun(runId, { db })).toMatchObject({
      cancelled: true,
    });
    await done.catch(() => undefined);
    await expect
      .poll(async () => (await row(queued.messageId)).delivery, {
        timeout: 45_000,
        interval: 50,
      })
      .toBe("prompted");
    await releasePrompt(runId, 2);
    await awaitDialog(runId, "WaitingForUser");
    expect(await adapterCalls(runId, "session/prompt")).toHaveLength(2);
  }, 150_000);

  it("T4.4: concurrent dispatchers serialize on the run row; exactly one sends", async () => {
    const { runId, done } = await launchHeld("message one");

    await runningTurn(runId);
    const queued = await send(runId, "one dispatch only");
    const trigger = `scratch_dispatch_${runId.replaceAll("-", "")}`;
    const lockKey = Math.floor(Math.random() * 2_000_000_000) + 1;
    const lock = await testDatabase.pool.connect();
    const racers: Array<Promise<{ dispatched: boolean }>> = [];

    try {
      await lock.query("SELECT pg_advisory_lock(260926, $1)", [lockKey]);
      // The winner blocks inside its transaction at the CAS, holding the run
      // and scratch rows; every other dispatcher waits for the run row.
      await testDatabase.pool.query(
        `CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.run_id = '${runId}' AND OLD.delivery = 'queued' AND NEW.delivery = 'prompted' THEN PERFORM pg_advisory_xact_lock(260926, ${lockKey}); END IF; RETURN NEW; END $$`,
      );
      await testDatabase.pool.query(
        `CREATE TRIGGER ${trigger} BEFORE UPDATE ON run_messages FOR EACH ROW EXECUTE FUNCTION ${trigger}()`,
      );
      // Ending turn 1 wakes its afterCommit dispatcher; two more race it.
      await releasePrompt(runId, 1);
      await done;
      await expect
        .poll(
          async () =>
            (
              await testDatabase.pool.query<{ count: number }>(
                "SELECT count(*)::int AS count FROM pg_locks WHERE locktype = 'advisory' AND classid = 260926 AND objid = $1 AND NOT granted",
                [lockKey],
              )
            ).rows[0].count,
          { timeout: 30_000, interval: 25 },
        )
        .toBe(1);
      racers.push(
        service.dispatchQueuedScratchMessages(db, runId),
        service.dispatchQueuedScratchMessages(db, runId),
      );
      await expect
        .poll(
          async () =>
            (
              await testDatabase.pool.query<{ count: number }>(
                `SELECT count(*)::int AS count FROM pg_stat_activity
                 WHERE wait_event_type = 'Lock'
                   AND query ILIKE 'SELECT id FROM runs WHERE id = %FOR UPDATE'`,
              )
            ).rows[0].count,
          { timeout: 30_000, interval: 25 },
        )
        .toBe(2);
      await lock.query("SELECT pg_advisory_unlock_all()");
      expect(await Promise.all(racers)).toEqual([
        { dispatched: false },
        { dispatched: false },
      ]);
    } finally {
      await lock.query("SELECT pg_advisory_unlock_all()");
      lock.release();
      await testDatabase.pool.query(
        `DROP TRIGGER IF EXISTS ${trigger} ON run_messages`,
      );
      await testDatabase.pool.query(`DROP FUNCTION IF EXISTS ${trigger}()`);
    }
    await releasePrompt(runId, 2);
    await awaitDialog(runId, "WaitingForUser");
    expect((await row(queued.messageId)).delivery).toBe("prompted");
    expect(await adapterCalls(runId, "session/prompt")).toHaveLength(2);
  }, 150_000);

  it("dispatches several queued messages oldest first, one per turn", async () => {
    const { runId, done } = await launchHeld("message one");

    await runningTurn(runId);
    const second = await send(runId, "message two");
    const third = await send(runId, "message three");

    expect([second.delivery, third.delivery]).toEqual(["queued", "queued"]);
    await releasePrompt(runId, 1);
    await done;
    await expect
      .poll(async () => (await row(second.messageId)).delivery, {
        timeout: 45_000,
        interval: 50,
      })
      .toBe("prompted");
    expect((await row(third.messageId)).delivery).toBe("queued");
    await releasePrompt(runId, 2);
    await expect
      .poll(async () => (await row(third.messageId)).delivery, {
        timeout: 45_000,
        interval: 50,
      })
      .toBe("prompted");
    await releasePrompt(runId, 3);
    await awaitDialog(runId, "WaitingForUser");
    // Prompt 1 is the launch turn; the queued messages follow oldest first.
    expect(
      (await prompts(runId))
        .slice(1)
        .map(
          (command) => (command.ownerRef as { messageId?: string }).messageId,
        ),
    ).toEqual([second.messageId, third.messageId]);
  }, 180_000);

  it("A4 state: a send from WaitingForUser joins the queue behind a message stranded there and sends it first", async () => {
    const { runId, done } = await launchHeld("message one");

    await runningTurn(runId);
    await releasePrompt(runId, 1);
    await done;
    await awaitDialog(runId, "WaitingForUser");
    // The state a process death between a turn's completion commit and its
    // detached dispatch leaves behind (ADR-182 open item A4).
    const strandedId = randomUUID();

    await db.transaction((tx) =>
      appendScratchMessage(tx as never, {
        id: strandedId,
        runId,
        role: "user",
        content: "stranded",
        delivery: "queued",
      }),
    );
    const next = await send(runId, "next");

    expect(next).toMatchObject({ delivery: "queued" });
    await releasePrompt(runId, 2);
    await releasePrompt(runId, 3);
    await awaitDialog(runId, "WaitingForUser");
    expect(
      (await userRows(runId)).map((message) => [
        message.content,
        message.delivery,
      ]),
    ).toEqual([
      ["message one", null],
      ["stranded", "prompted"],
      ["next", "prompted"],
    ]);
    expect(
      (await prompts(runId))
        .slice(1)
        .map(
          (command) => (command.ownerRef as { messageId?: string }).messageId,
        ),
    ).toEqual([strandedId, next.messageId]);
  }, 180_000);
});
