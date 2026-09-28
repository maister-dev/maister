// Ownership residuals T2.1 / T2.2 (the queued-message invariant, D-A6): a
// queued agent message is delivered, superseded, or reported — never left in a
// queue nothing reads. Real Postgres, a REAL supervisor running the mock
// adapter (every prompt is held until SIGUSR1, `--controlled-prompt`), the
// production projection and continuation workers.
//
//   M1  a persistent agent finalized Failed with messages queued behind its
//       running turn supersedes them in the finalization transaction, and a
//       same-key retry answers `superseded`;
//   M2  a message accepted in the launch window (the run and its launch
//       assignment committed, the web dead before `startAgentSession`) is
//       delivered: the continuation worker's launch arm selects a run with no
//       GENERATION turn, starts the session, and the message follows.

import type { Db } from "@/lib/execution-host/db";
import type { AgentTurn } from "@/lib/db/schema";
import type { RealSupervisor } from "@/test-support/real-supervisor";
import type { ProjectionWorker } from "@/lib/execution-host/events/projection-worker";

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { agentTurns, executionCommands, runs, users } from "@/lib/db/schema";
import { closeDb } from "@/lib/db/client";
import {
  finalizeAgentRun,
  sendAgentMessage,
  startAgentSession,
} from "@/lib/agents/launch";
import { startAgentContinuationWorker } from "@/lib/agents/continuation-worker";
import { createExecutionHosts } from "@/lib/execution-host/client";
import { resetResolverForTests } from "@/lib/execution-host/resolver";
import { resetRegistrarStateForTests } from "@/lib/execution-host/registrar";
import { canonicalProjectors } from "@/lib/execution-host/events/projection-runtime";
import { startProjectionWorker } from "@/lib/execution-host/events/projection-worker";
import { stopRuntimeEventConsumers } from "@/lib/execution-host/events/consumer";
import { seedAgentRun } from "@/test-support/agent-run-seed";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";
import {
  startRealSupervisor,
  useRealSupervisorUrl,
} from "@/test-support/real-supervisor";

const USER_ID = "agent-queue-user";

let database: StartedPostgresTestDb;
let db: Db;
let supervisor: RealSupervisor;
let worker: ProjectionWorker;
let restoreUrl: () => void = () => {};
let logDir: string;
let adapterLog: string;
const oldWorktreesRoot = process.env.MAISTER_WORKTREES_ROOT;
const oldRuntimeRoot = process.env.MAISTER_RUNTIME_ROOT;
const oldAgentCap = process.env.MAISTER_MAX_CONCURRENT_AGENTS;
const oldDbUrl = process.env.DB_URL;

beforeAll(async () => {
  database = await startMainPostgresTestDb({ databaseName: "agent_queue" });
  db = database.db as unknown as Db;
  await db
    .insert(users)
    .values({ id: USER_ID, email: "agent-queue@test.local" });
  logDir = await mkdtemp(path.join(tmpdir(), "agent-queue-"));
  adapterLog = path.join(logDir, "adapter-invocations.ndjson");
  supervisor = await startRealSupervisor({
    fixtureArgs: [
      "--hang",
      "--lines",
      "0",
      "--supports-resume",
      "--controlled-prompt",
      "--invocation-log",
      adapterLog,
    ],
  });
  restoreUrl = useRealSupervisorUrl(supervisor.url);
  process.env.MAISTER_WORKTREES_ROOT = path.join(
    supervisor.runtimeRoot,
    "worktrees",
  );
  process.env.MAISTER_RUNTIME_ROOT = path.join(
    supervisor.runtimeRoot,
    "manager",
  );
  // Every case leaves a live agent run: the pool's default cap of 3 would
  // defer later cases.
  process.env.MAISTER_MAX_CONCURRENT_AGENTS = "64";
  process.env.DB_URL = database.databaseUrl;
  resetRegistrarStateForTests();
  resetResolverForTests();
  worker = startProjectionWorker({ db, projectors: canonicalProjectors });
}, 180_000);

afterAll(async () => {
  await stopRuntimeEventConsumers();
  await worker?.stop();
  await closeDb();
  restoreUrl();
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

async function seedPersistentAgent(): Promise<string> {
  return seedAgentRun(db, {
    runtimeRoot: supervisor.runtimeRoot,
    definition: `---\nname: Researcher\ndescription: d\nworkspace: none\nmode: session\nplatform_mcp: false\ntriggers:\n  - manual\nrisk_tier: read_only\n---\nfixture-output:${JSON.stringify({ bytes: 0, text: " reply" })}\n`,
    workspace: "none",
    resultContract: null,
    persistent: true,
  });
}

type Invocation = { pid: number; sessionId: string; method: string };

async function prompts(): Promise<Invocation[]> {
  try {
    return (await readFile(adapterLog, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Invocation)
      .filter((row) => row.method === "session/prompt");
  } catch {
    return [];
  }
}

async function turnsOf(runId: string): Promise<AgentTurn[]> {
  return db
    .select()
    .from(agentTurns)
    .where(eq(agentTurns.runId, runId))
    .orderBy(asc(agentTurns.ordinal));
}

async function runStatus(runId: string): Promise<string> {
  const [row] = await db
    .select({ status: runs.status })
    .from(runs)
    .where(eq(runs.id, runId));

  return row.status;
}

describe("the queued-message invariant (D-A6)", () => {
  it("M1: a run finalized Failed supersedes its queued messages in the finalization transaction", async () => {
    const runId = await seedPersistentAgent();
    const before = (await prompts()).length;

    void startAgentSession(runId, { db }).catch(() => undefined);
    // The launch turn is running (held): both messages queue behind it.
    await expect
      .poll(async () => (await prompts()).length, {
        timeout: 45_000,
        interval: 50,
      })
      .toBe(before + 1);
    const first = await sendAgentMessage(runId, "first", {
      db,
      requestKey: `m1-first-${runId}`,
    });
    const second = await sendAgentMessage(runId, "second", {
      db,
      requestKey: `m1-second-${runId}`,
    });

    expect([first.messageState, second.messageState]).toEqual([
      "queued",
      "queued",
    ]);
    const finalized = await finalizeAgentRun(runId, "Failed", { db });

    expect(finalized).toMatchObject({ finalized: true, status: "Failed" });
    const messages = (await turnsOf(runId)).filter((turn) =>
      ["live_message", "persistent_message"].includes(turn.variant),
    );

    expect(messages.map((turn) => turn.state)).toEqual([
      "superseded",
      "superseded",
    ]);
    for (const turn of messages) expect(turn.completedAt).not.toBeNull();
    // The same key finds the settled row: the caller learns it was dropped,
    // and no new turn is minted.
    const retry = await sendAgentMessage(runId, "first", {
      db,
      requestKey: `m1-first-${runId}`,
    });

    expect(retry).toMatchObject({
      messageId: first.messageId,
      messageState: "superseded",
    });
    expect(await runStatus(runId)).toBe("Failed");
  }, 180_000);

  it("M2: a message accepted in the launch window is delivered once the worker starts the session", async () => {
    // The run row, its session row and its launch assignment are committed,
    // and nothing else: the web died before `startAgentSession`.
    const runId = await seedPersistentAgent();
    const accepted = await sendAgentMessage(runId, "hello from the window", {
      db,
    });

    expect(accepted.messageState).toBe("queued");
    // No session is admissible yet: the claim deferred the message and left
    // the run its queue key (C9).
    const [waiting] = await db
      .select({ resumeRequestedAt: runs.resumeRequestedAt })
      .from(runs)
      .where(eq(runs.id, runId));

    expect(waiting.resumeRequestedAt).not.toBeNull();
    // The run is `Running` (its launch committed), so the message is live.
    expect((await turnsOf(runId)).map((turn) => turn.variant)).toEqual([
      "live_message",
    ]);
    const before = (await prompts()).length;
    const continuation = startAgentContinuationWorker({
      db,
      executionHosts: createExecutionHosts({ db }),
    });

    try {
      // The launch arm selects the run and starts its `initial` turn.
      await expect
        .poll(async () => (await turnsOf(runId)).map((turn) => turn.variant), {
          timeout: 45_000,
          interval: 100,
        })
        .toEqual(expect.arrayContaining(["initial", "live_message"]));
      await expect
        .poll(async () => (await prompts()).length, {
          timeout: 45_000,
          interval: 50,
        })
        .toBe(before + 1);
      process.kill((await prompts())[before].pid, "SIGUSR1");
      // The message follows the launch turn and is dispatched.
      await expect
        .poll(async () => (await prompts()).length, {
          timeout: 60_000,
          interval: 50,
        })
        .toBe(before + 2);
      process.kill((await prompts())[before + 1].pid, "SIGUSR1");
      await expect
        .poll(
          async () =>
            (await turnsOf(runId)).find(
              (turn) => turn.id === accepted.messageId,
            )?.state,
          { timeout: 60_000, interval: 100 },
        )
        .toBe("applied");
      const turns = await turnsOf(runId);
      const initial = turns.find((turn) => turn.variant === "initial");
      const message = turns.find((turn) => turn.id === accepted.messageId);
      const commandAt = async (commandId: string | null) =>
        (
          await db
            .select({ createdAt: executionCommands.createdAt })
            .from(executionCommands)
            .where(eq(executionCommands.id, commandId ?? ""))
        )[0]?.createdAt.getTime();

      expect(initial?.state).toBe("applied");
      // The launch turn's prompt went out first; the message rode behind it.
      expect(await commandAt(initial?.commandId ?? null)).toBeLessThan(
        (await commandAt(message?.commandId ?? null)) as number,
      );
    } finally {
      await continuation.stop();
    }
  }, 240_000);
});
