// ADR-182 open item A4 closed (ownership residuals T1.1 / T1.3): a scratch row
// left `queued` behind a `WaitingForUser` dialog — a process death between a
// turn's completion commit and its detached dispatch — is re-driven by the
// agent continuation worker's scratch arm; a dead session is never dispatched
// into (the reconcile sweep owns it, then Recover sends the row first); and a
// scratch dialog whose session create is still binding is inside the grace
// window, not crashed. Real Postgres, a REAL supervisor behind the fault proxy,
// the production projection and continuation workers. The mock adapter holds
// every prompt until SIGUSR1 (`--controlled-prompt`) and advertises steering
// (`--steering`), which only the W6 case uses: no other case sends while busy.

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
import { NextRequest } from "next/server";
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
import { startAgentContinuationWorker } from "@/lib/agents/continuation-worker";
import { runReconcileSweep } from "@/lib/reconcile";
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
const USER_ID = "scratch-redrive-user";

vi.mock("@/lib/db/client", () => ({
  getDb: () => db,
  closeDb: async () => {},
}));
// A process death between a queue conversion's commit and its detached wake.
// Only a wake reached through this module from outside it can be dropped — the
// recovery fold's. A live refusal's own call is internal, and the prompt
// owner's `afterCommit` loads the module from inside `importOriginal`'s graph.
const { wake } = vi.hoisted(() => ({
  wake: { suppressed: false, dropped: [] as string[] },
}));

vi.mock("@/lib/scratch-runs/service", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/scratch-runs/service")>();

  return {
    ...actual,
    wakeQueuedScratchDispatch: (
      ...args: Parameters<typeof actual.wakeQueuedScratchDispatch>
    ) => {
      if (wake.suppressed) {
        wake.dropped.push(args[1]);

        return;
      }
      actual.wakeQueuedScratchDispatch(...args);
    },
  };
});
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
let recoverRoute: typeof import("@/app/api/scratch-runs/[runId]/recover/route").POST;
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

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "scratch_redrive",
  });
  db = testDatabase.db;
  logDir = await mkdtemp(join(tmpdir(), "scratch-redrive-"));
  adapterLog = join(logDir, "adapter-invocations.ndjson");
  supervisor = await startRealSupervisor({
    fixtureArgs: [
      "--hang",
      "--lines",
      "0",
      "--supports-resume",
      "--controlled-prompt",
      "--steering",
      "--invocation-log",
      adapterLog,
    ],
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
  ({ POST: recoverRoute } = await import(
    "@/app/api/scratch-runs/[runId]/recover/route"
  ));
  for (const key of [
    "DB_URL",
    "MAISTER_RUNTIME_ROOT",
    "MAISTER_WORKTREES_ROOT",
    "MAISTER_MAX_CONCURRENT_RUNS",
    "MAISTER_RECONCILE_GRACE_SECONDS",
  ])
    savedEnv[key] = process.env[key];
  process.env.DB_URL = testDatabase.container.getConnectionUri();
  // Every test leaves a dialog open (a live run): the file outgrows the
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
    slug: `redrive-${projectId.slice(0, 8)}`,
    name: "Scratch redrive",
    repoPath: repo,
    taskKey: "SRD",
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

function launchBody(prompt: string): ScratchLaunchInput {
  return {
    projectId,
    baseBranch: "main",
    prompt,
    reasoningEffort: "high",
    attachments: [],
  };
}

const launched = new Set<string>();

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

type Invocation = { pid: number; sessionId: string; method: string };

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

async function session(runId: string) {
  const [row] = await db
    .select()
    .from(schema.runSessions)
    .where(eq(schema.runSessions.runId, runId));

  return row;
}

// Every ACP session the run has bound, so a respawn that restores the
// conversation under a new handle keeps counting the earlier prompts.
const knownAcpSessions = new Map<string, Set<string>>();

async function promptCalls(runId: string): Promise<Invocation[]> {
  const sessions = await db
    .select({ acpSessionId: schema.runSessions.acpSessionId })
    .from(schema.runSessions)
    .where(eq(schema.runSessions.runId, runId));
  const ids = knownAcpSessions.get(runId) ?? new Set<string>();

  for (const row of sessions) if (row.acpSessionId) ids.add(row.acpSessionId);
  knownAcpSessions.set(runId, ids);

  return (await invocations()).filter(
    (row) => row.method === "session/prompt" && ids.has(row.sessionId),
  );
}

// SIGUSR1 to the adapter holding the run's `n`-th prompt ends that turn.
async function releasePrompt(runId: string, n: number): Promise<void> {
  let prompts: Invocation[] = [];

  await expect
    .poll(
      async () => {
        prompts = await promptCalls(runId);

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

async function runStatus(runId: string): Promise<string> {
  const [row] = await db
    .select({ status: schema.runs.status })
    .from(schema.runs)
    .where(eq(schema.runs.id, runId));

  return row.status;
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

// The state a process death between a turn's completion commit and its
// detached dispatch leaves behind: rows queued behind an idle dialog, and no
// live wake left to send them.
async function strand(runId: string, content: string): Promise<string> {
  const id = randomUUID();

  await db.transaction((tx) =>
    appendScratchMessage(tx as never, {
      id,
      runId,
      role: "user",
      content,
      delivery: "queued",
    }),
  );

  return id;
}

async function idleDialog(prompt: string): Promise<string> {
  const { runId, done } = await launchHeld(prompt);

  await releasePrompt(runId, 1);
  await done;
  await awaitDialog(runId, "WaitingForUser");

  return runId;
}

async function row(messageId: string) {
  const [message] = await db
    .select()
    .from(schema.runMessages)
    .where(eq(schema.runMessages.id, messageId));

  return message;
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

async function steerPath(runId: string): Promise<RegExp> {
  const { hostSessionId } = await session(runId);

  return new RegExp(`^/sessions/${hostSessionId}/steer$`);
}

// A manager that dies in its retry backoff: the wait never ends, so nothing
// it started settles.
function managerDyingInBackoff() {
  return createExecutionHosts({
    db: db as unknown as Db,
    sleep: () => new Promise<void>(() => {}),
  });
}

function startWorker() {
  return startAgentContinuationWorker({
    db: db as unknown as Db,
    executionHosts: createExecutionHosts({ db: db as unknown as Db }),
  });
}

describe("scratch re-drive — the agent continuation worker's scratch arm (ADR-182 A4)", () => {
  it("T1.3 (a): a row stranded behind an idle dialog is re-driven, and the next follows FIFO", async () => {
    const runId = await idleDialog("message one");
    const first = await strand(runId, "stranded one");
    const second = await strand(runId, "stranded two");
    const continuation = startWorker();

    try {
      // Within the settle window plus a pass: the worker sends the OLDEST.
      await expect
        .poll(async () => (await userRows(runId)).map((row) => row.delivery), {
          timeout: 30_000,
          interval: 100,
        })
        .toEqual([null, "prompted", "queued"]);
      expect(
        (await userRows(runId)).find((row) => row.id === first)?.delivery,
      ).toBe("prompted");
      await releasePrompt(runId, 2);
      // The second follows by the previous turn's own dispatch or the arm.
      await expect
        .poll(
          async () =>
            (await userRows(runId)).find((row) => row.id === second)?.delivery,
          { timeout: 30_000, interval: 100 },
        )
        .toBe("prompted");
      await releasePrompt(runId, 3);
      await awaitDialog(runId, "WaitingForUser");
      const prompts = await db
        .select({ ownerRef: schema.executionCommands.ownerRef })
        .from(schema.executionCommands)
        .where(
          and(
            eq(schema.executionCommands.runId, runId),
            eq(schema.executionCommands.kind, "session.prompt"),
          ),
        )
        .orderBy(asc(schema.executionCommands.createdAt));

      expect(
        prompts
          .slice(1)
          .map(
            (command) => (command.ownerRef as { messageId?: string }).messageId,
          ),
      ).toEqual([first, second]);
      expect(await promptCalls(runId)).toHaveLength(3);
    } finally {
      await continuation.stop();
    }
  }, 180_000);

  it("T1.3 (b): a row a refused steer returned to the queue, its wake lost, is re-driven as an ordinary prompt", async () => {
    const { runId, done } = await launchHeld("message one");

    await expect
      .poll(async () => (await promptCalls(runId)).length, {
        timeout: 45_000,
        interval: 25,
      })
      .toBe(1);
    const path = await steerPath(runId);
    const held = proxy.arm(
      { caseId: `redrive-steer-held-${runId}`, method: "POST", path },
      "hold-request",
    );
    const lost = proxy.arm(
      { caseId: `redrive-steer-lost-${runId}`, method: "POST", path },
      "drop-responses",
    );

    // Busy: the message is steered into the running turn.
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
      // The turn ends first: its completion finds the row still `steered`.
      await releasePrompt(runId, 1);
      await done;
      await awaitDialog(runId, "WaitingForUser");
      held.release();
      released = true;
      // The host refuses (no active turn); the answer is lost and the manager
      // dies in its backoff.
      await expect
        .poll(() => lost.observations.length, { timeout: 30_000 })
        .toBe(1);
    } finally {
      if (!released && held.observations.length > 0) held.cut();
      if (lost.observations.length > 0) lost.release();
    }
    await expect
      .poll(async () => (await steers(runId))[0]?.state, {
        timeout: 30_000,
        interval: 25,
      })
      .toBe("queued");
    const [late] = (await userRows(runId)).filter(
      (message) => message.content === "late message",
    );

    // Recovery folds the refusal (`steered -> queued`) and the process dies
    // before its wake: nothing live will send the row.
    wake.suppressed = true;
    try {
      await recoverExecutionCommands({
        db: db as unknown as Db,
        transport: defaultTransport(),
        graceMs: 0,
      });
    } finally {
      wake.suppressed = false;
    }
    expect(wake.dropped).toContain(runId);
    expect((await row(late.id)).delivery).toBe("queued");
    expect(await dialogStatus(runId)).toBe("WaitingForUser");
    const continuation = startWorker();

    try {
      await expect
        .poll(async () => (await row(late.id)).delivery, {
          timeout: 30_000,
          interval: 100,
        })
        .toBe("prompted");
      await releasePrompt(runId, 2);
      await awaitDialog(runId, "WaitingForUser");
    } finally {
      await continuation.stop();
    }
    const [refused] = await steers(runId);

    expect(refused.state).toBe("failed");
    // An ordinary prompt carried it: two prompts, and no steer reached the
    // adapter.
    const { acpSessionId } = await session(runId);

    expect(await promptCalls(runId)).toHaveLength(2);
    expect(
      (await invocations()).filter(
        (call) =>
          call.method === "_session/steering" &&
          call.sessionId === acpSessionId,
      ),
    ).toHaveLength(0);
  }, 180_000);

  it("T1.3 (c): with no admissible incarnation nothing is dispatched; the sweep crashes past grace and Recover sends the row first", async () => {
    const runId = await idleDialog("message one");
    const { hostSessionId } = await session(runId);
    const [record] = (
      await (await fetch(`${supervisor.url}/sessions`)).json()
    ).filter(
      (row: { sessionId: string }) => row.sessionId === hostSessionId,
    ) as Array<{ pid: number }>;

    // The adapter dies while the dialog is idle: no scratch consumer is
    // listening between turns, so the dialog still reads WaitingForUser — only
    // the canonical projection sees the incarnation end.
    process.kill(record.pid, "SIGKILL");
    await expect
      .poll(
        async () => {
          const [incarnation] = await db
            .select({ state: schema.runSessionIncarnations.state })
            .from(schema.runSessionIncarnations)
            .where(
              eq(schema.runSessionIncarnations.hostSessionId, hostSessionId!),
            );

          return incarnation?.state;
        },
        { timeout: 45_000, interval: 100 },
      )
      .not.toMatch(/^(created|active)$/);
    expect(await dialogStatus(runId)).toBe("WaitingForUser");
    // Stranded once the session is dead: the finished turn's own detached
    // `afterCommit` wake can land late (measured ~120 ms under load) and, with
    // a live session, would send a row stranded earlier itself. The state is
    // the one a process death leaves either way — a queued row, an idle
    // dialog, a dead session.
    const stranded = await strand(runId, "stranded before the death");
    const before = (await promptCalls(runId)).length;
    const continuation = startWorker();

    try {
      // Well past the settle window: the arm never selects the run.
      await new Promise((resolve) => setTimeout(resolve, 8_000));
      expect(
        (await userRows(runId)).find((row) => row.id === stranded)?.delivery,
      ).toBe("queued");
      expect(await promptCalls(runId)).toHaveLength(before);
    } finally {
      await continuation.stop();
    }
    // The sweep owns the dead session: past grace it crashes the run.
    process.env.MAISTER_RECONCILE_GRACE_SECONDS = "1";
    try {
      await expect
        .poll(
          async () => {
            await runReconcileSweep({ db: db as never });

            return runStatus(runId);
          },
          { timeout: 30_000, interval: 1_000 },
        )
        .toBe("Crashed");
    } finally {
      process.env.MAISTER_RECONCILE_GRACE_SECONDS =
        savedEnv.MAISTER_RECONCILE_GRACE_SECONDS;
      if (savedEnv.MAISTER_RECONCILE_GRACE_SECONDS === undefined)
        delete process.env.MAISTER_RECONCILE_GRACE_SECONDS;
    }
    expect(await dialogStatus(runId)).toBe("Crashed");
    const response = await recoverRoute(
      new NextRequest(`http://localhost/api/scratch-runs/${runId}/recover`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: "continue after the death" }),
      }),
      { params: Promise.resolve({ runId }) },
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      action: "recover",
      delivery: "queued",
    });
    await expect
      .poll(
        async () =>
          (await userRows(runId)).find((row) => row.id === stranded)?.delivery,
        { timeout: 45_000, interval: 100 },
      )
      .toBe("prompted");
    await releasePrompt(runId, before + 1);
    await expect
      .poll(
        async () =>
          (await userRows(runId))
            .filter((row) => row.delivery !== null)
            .map((row) => [row.content, row.delivery]),
        { timeout: 45_000, interval: 100 },
      )
      .toEqual([
        ["stranded before the death", "prompted"],
        ["continue after the death", "prompted"],
      ]);
    await releasePrompt(runId, before + 2);
    await awaitDialog(runId, "WaitingForUser");
  }, 240_000);

  it("T1.3 (d): a live wake and the worker's wake race for one stranded row — exactly one prompt", async () => {
    const runId = await idleDialog("message one");
    const stranded = await strand(runId, "one dispatch only");
    const trigger = `scratch_redrive_${runId.replaceAll("-", "")}`;
    const lockKey = Math.floor(Math.random() * 2_000_000_000) + 1;
    const lock = await testDatabase.pool.connect();
    const before = (await promptCalls(runId)).length;
    let continuation: ReturnType<typeof startWorker> | null = null;
    let live: Promise<{ dispatched: boolean }> | null = null;

    try {
      await lock.query("SELECT pg_advisory_lock(260926, $1)", [lockKey]);
      // The first dispatcher parks inside its transaction at the CAS, holding
      // the run and scratch rows; the other must wait for the run row.
      await testDatabase.pool.query(
        `CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.run_id = '${runId}' AND OLD.delivery = 'queued' AND NEW.delivery = 'prompted' THEN PERFORM pg_advisory_xact_lock(260926, ${lockKey}); END IF; RETURN NEW; END $$`,
      );
      await testDatabase.pool.query(
        `CREATE TRIGGER ${trigger} BEFORE UPDATE ON run_messages FOR EACH ROW EXECUTE FUNCTION ${trigger}()`,
      );
      live = service.dispatchQueuedScratchMessages(db, runId);
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
      continuation = startWorker();
      // The worker's wake parks on the run row the live dispatcher holds.
      await expect
        .poll(
          async () =>
            (
              await testDatabase.pool.query<{ count: number }>(
                `SELECT count(*)::int AS count FROM pg_stat_activity
                 WHERE wait_event_type = 'Lock'
                   AND query ILIKE 'SELECT id FROM runs WHERE id = %FOR NO KEY UPDATE'`,
              )
            ).rows[0].count,
          { timeout: 30_000, interval: 50 },
        )
        .toBeGreaterThanOrEqual(1);
      await lock.query("SELECT pg_advisory_unlock_all()");
      await releasePrompt(runId, before + 1);
      expect(await live).toEqual({ dispatched: true });
      await awaitDialog(runId, "WaitingForUser");
    } finally {
      await lock.query("SELECT pg_advisory_unlock_all()");
      lock.release();
      await testDatabase.pool.query(
        `DROP TRIGGER IF EXISTS ${trigger} ON run_messages`,
      );
      await testDatabase.pool.query(`DROP FUNCTION IF EXISTS ${trigger}()`);
      await live?.catch(() => undefined);
      await continuation?.stop();
    }
    expect(
      (await userRows(runId)).find((row) => row.id === stranded)?.delivery,
    ).toBe("prompted");
    expect(await promptCalls(runId)).toHaveLength(before + 1);
  }, 180_000);

  it("T1.1 (a): a launch whose session create is still held is inside the grace window, not crashed", async () => {
    const barrier = proxy.arm(
      {
        caseId: "redrive-held-create",
        method: "POST",
        path: /^\/sessions$/,
      },
      "hold-request",
    );
    let pending: Awaited<ReturnType<typeof launchHeld>> | null = null;

    try {
      pending = await launchHeld("held create");
      await barrier.awaitReached(30_000);
      // Past any plausible node-attempt anchor (there is none for scratch):
      // on master the run had NO anchor and crashed on this tick.
      await runReconcileSweep({ db: db as never });
      expect(await runStatus(pending.runId)).toBe("Running");
      expect(await dialogStatus(pending.runId)).toBe("Starting");
    } finally {
      barrier.release();
    }
    await releasePrompt(pending.runId, 1);
    await pending.done;
    await awaitDialog(pending.runId, "WaitingForUser");
  }, 180_000);
});
