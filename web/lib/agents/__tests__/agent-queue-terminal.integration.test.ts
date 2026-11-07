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

import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  agentTurns,
  executionCommands,
  flowRevisions,
  flows,
  runs,
  taskLaunchIntents,
  users,
} from "@/lib/db/schema";
import { closeDb } from "@/lib/db/client";
import {
  finalizeAgentRun,
  sendAgentMessage,
  startAgentSession,
  launchAgentRun,
} from "@/lib/agents/launch";
import { startAgentContinuationWorker } from "@/lib/agents/continuation-worker";
import { createExecutionHosts } from "@/lib/execution-host/client";
import { resetResolverForTests } from "@/lib/execution-host/resolver";
import { resetRegistrarStateForTests } from "@/lib/execution-host/registrar";
import { canonicalProjectors } from "@/lib/execution-host/events/projection-runtime";
import { startProjectionWorker } from "@/lib/execution-host/events/projection-worker";
import { stopRuntimeEventConsumers } from "@/lib/execution-host/events/consumer";
import { seedAgentRun } from "@/test-support/agent-run-seed";
import { createTask } from "@/lib/services/tasks";
import { sendTaskToTriage } from "@/lib/services/triage";
import { runAutoLaunchTriagedJob } from "@/lib/scheduler/handlers/auto-launch-triaged";
import {
  loadTaskQualificationInput,
  prepareTaskQualification,
} from "@/lib/tasks/qualification";
import { qualificationFixture } from "@/test-support/task-qualification";
import { operationalSuccessFixture } from "@/test-support/operational-agent";
import { git } from "@/test-support/git-fixture";
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
  it("TB07 real supervisor completes Triager preparation, publishes its assessment and automatically queues the selected delivery Flow", async () => {
    const responseFile = path.join(logDir, "triager-response.txt");
    const templateId = await seedAgentRun(db, {
      runtimeRoot: supervisor.runtimeRoot,
      definition: `---\nname: Qualifier\ndescription: qualify requests\nkind: operational\ncompletion: {contract: operational_v1}\ntask_qualification: {contract: v1, role: qualifier}\nworkspace: repo_read\nworkspace_ref: task_target\nmode: session\nplatform_mcp: false\ntriggers: [manual]\nrisk_tier: read_only\n---\nfixture-output:${JSON.stringify({ bytes: 0, textFile: responseFile })}\n`,
      workspace: "repo_read",
      operational: true,
      resultContract: null,
    });
    const source = (
      await database.pool.query(
        "SELECT r.project_id,r.agent_id,s.runner_id,p.repo_path FROM runs r JOIN run_sessions s ON s.run_id=r.id JOIN projects p ON p.id=r.project_id WHERE r.id=$1",
        [templateId],
      )
    ).rows[0] as {
      project_id: string;
      agent_id: string;
      runner_id: string;
      repo_path: string;
    };

    const flowId = randomUUID();
    const revisionId = randomUUID();
    const targetSha = await git(source.repo_path, "rev-parse", "HEAD");
    const installedPath = path.join(logDir, "qualified-delivery");
    const manifest = {
      schemaVersion: 1,
      name: "Qualified delivery",
      nodes: [
        {
          id: "check",
          type: "cli",
          action: { command: "true" },
          transitions: { success: "done" },
        },
      ],
    };

    await mkdir(installedPath);
    await writeFile(
      path.join(installedPath, "flow.yaml"),
      JSON.stringify(manifest),
    );
    await db.insert(flowRevisions).values({
      id: revisionId,
      flowRefId: flowId,
      source: "local",
      versionLabel: "v1",
      resolvedRevision: targetSha,
      manifestDigest: createHash("sha256")
        .update(JSON.stringify(manifest))
        .digest("hex"),
      manifest,
      schemaVersion: 1,
      installedPath,
      setupStatus: "not_required",
      packageStatus: "Installed",
      execTrust: "trusted",
    });
    await db.insert(flows).values({
      id: flowId,
      projectId: source.project_id,
      flowRefId: flowId,
      source: "local",
      version: "v1",
      installedPath,
      manifest,
      schemaVersion: 1,
      enabledRevisionId: revisionId,
      enablementState: "Enabled",
      trustStatus: "trusted",
    });

    await database.pool.query(
      "UPDATE projects SET task_qualification_override='required' WHERE id=$1",
      [source.project_id],
    );
    await database.pool.query(
      "UPDATE package_installs SET manifest=jsonb_set(manifest,'{spec,compat,engine_min}','\"3.10.0\"') WHERE id=(SELECT package_install_id FROM project_package_attachments WHERE project_id=$1)",
      [source.project_id],
    );
    await database.pool.query(
      "INSERT INTO platform_runtime_settings(id,default_runner_id) VALUES('singleton',$1) ON CONFLICT(id) DO UPDATE SET default_runner_id=excluded.default_runner_id",
      [source.runner_id],
    );
    const task = await createTask(
      {
        title: "Qualification fixture",
        prompt: "Inspect the repository and assess this request.",
      },
      { projectId: source.project_id },
      db,
    );

    await sendTaskToTriage(
      {
        taskId: task.taskId,
        projectId: source.project_id,
        taskRef: task.taskId,
        title: "Qualification fixture",
        actor: { type: "user", id: USER_ID },
        launchIntent: "triage_then_launch",
      },
      db,
    );
    const launched = await launchAgentRun({
      db,
      agentId: source.agent_id,
      projectId: source.project_id,
      taskId: task.taskId,
      trigger: { source: "manual" },
    });

    if (!("runId" in launched)) throw new Error("Expected a qualifier run");
    let invocation: Invocation | undefined;

    await expect
      .poll(
        async () => {
          const session = (
            await database.pool.query(
              "SELECT acp_session_id FROM run_sessions WHERE run_id=$1",
              [launched.runId],
            )
          ).rows[0]?.acp_session_id;

          invocation = (await prompts()).find(
            (entry) => entry.sessionId === session,
          );

          return invocation !== undefined;
        },
        { timeout: 45_000, interval: 50 },
      )
      .toBe(true);
    const preparedRun = (
      await database.pool.query(
        "SELECT operational_integrity_baseline FROM runs WHERE id=$1",
        [launched.runId],
      )
    ).rows[0];

    expect(
      preparedRun.operational_integrity_baseline.generation,
    ).toBeGreaterThan(0);
    const credential = (
      await database.pool.query("SELECT id FROM project_tokens WHERE name=$1", [
        `agent-run:${launched.runId}`,
      ])
    ).rows[0] as { id: string };
    const input = await loadTaskQualificationInput(
      db,
      source.project_id,
      task.taskId,
    );
    const assessment = await prepareTaskQualification(db, {
      projectId: source.project_id,
      taskId: task.taskId,
      author: {
        kind: "agent_run",
        runId: launched.runId,
        tokenId: credential.id,
      },
      request: {
        requestKey: randomUUID(),
        expectedInputRevision: input.inputRevision,
        expectedQualificationRevision: input.currentQualificationRevision,
        qualification: qualificationFixture(),
        flowId,
        runnerId: source.runner_id,
        enqueue: true,
      },
    });
    const candidate = await db.transaction(assessment.apply);
    const selectedIntents = () =>
      db
        .select()
        .from(taskLaunchIntents)
        .where(eq(taskLaunchIntents.taskId, task.taskId));

    expect(await selectedIntents()).toEqual([]);
    expect(
      (
        await database.pool.query(
          "SELECT current_qualification_id FROM tasks WHERE id=$1",
          [task.taskId],
        )
      ).rows[0].current_qualification_id,
    ).toBeNull();
    await writeFile(
      responseFile,
      `\`\`\`json maister:output\n${JSON.stringify({ ...operationalSuccessFixture(), references: [{ kind: "other", id: candidate.qualificationId, state: "confirmed" }] })}\n\`\`\``,
    );
    process.kill(invocation!.pid, "SIGUSR1");
    await expect
      .poll(() => runStatus(launched.runId), { timeout: 45_000, interval: 50 })
      .toBe("Done");
    const completed = (
      await database.pool.query(
        "SELECT operational_terminal FROM runs WHERE id=$1",
        [launched.runId],
      )
    ).rows[0];

    expect(completed.operational_terminal).toMatchObject({
      successful: true,
      integrity: "clean",
      validation: "valid",
    });
    expect(
      (
        await database.pool.query(
          "SELECT current_qualification_id FROM tasks WHERE id=$1",
          [task.taskId],
        )
      ).rows[0].current_qualification_id,
    ).toBe(candidate.qualificationId);
    expect(
      (
        await database.pool.query(
          "SELECT phase,turn_id FROM agent_preparation_operations WHERE run_id=$1",
          [launched.runId],
        )
      ).rows,
    ).toEqual([
      expect.objectContaining({
        phase: "handed_off",
        turn_id: expect.any(String),
      }),
    ]);
    await expect
      .poll(
        async () =>
          (
            await database.pool.query(
              "SELECT operational_cleanup->>'state' AS state FROM runs WHERE id=$1",
              [launched.runId],
            )
          ).rows[0].state,
        { timeout: 45_000, interval: 50 },
      )
      .toBe("released");

    await expect
      .poll(async () => (await selectedIntents()).length, {
        timeout: 30_000,
        interval: 50,
      })
      .toBe(1);
    const accepted = await selectedIntents();

    expect(accepted).toHaveLength(1);
    expect(accepted[0]).toMatchObject({
      basis: {
        kind: "automatic",
        qualificationId: candidate.qualificationId,
        evidenceSha: targetSha,
      },
      settingsSnapshot: {
        kind: "flow",
        flowId,
        flowRevisionId: revisionId,
        baseCommit: targetSha,
        sessions: [expect.objectContaining({ runnerId: source.runner_id })],
      },
    });
    expect((await runAutoLaunchTriagedJob({ db })).launched).toBe(0);
    expect((await selectedIntents()).map((intent) => intent.id)).toEqual([
      accepted[0]!.id,
    ]);
    if (accepted[0]!.runId) {
      await expect
        .poll(() => runStatus(accepted[0]!.runId!), {
          timeout: 30_000,
          interval: 50,
        })
        .not.toMatch(/^(Pending|Running)$/);
    }
  }, 180_000);
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
