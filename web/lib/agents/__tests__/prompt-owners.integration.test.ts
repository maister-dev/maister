import type { Db } from "@/lib/execution-host/db";
import type { RunResultContract } from "@/lib/run-results/types";
import type { RealSupervisor } from "@/test-support/real-supervisor";
import type { ProjectionWorker } from "@/lib/execution-host/events/projection-worker";

import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  agents,
  agentProjectLinks,
  projects,
  runs,
  runSessions,
  runResults,
  packageInstalls,
  projectPackageAttachments,
  platformAcpRunners,
  executionCommands,
  domainEvents,
  executionAssignments,
  agentTurns,
  hitlRequests,
  users,
  workspaces,
} from "@/lib/db/schema";
import { startAgentContinuationWorker } from "@/lib/agents/continuation-worker";
import { lockAgentPermissionResult } from "@/lib/agents/permission-resume";
import {
  agentPermissionResumeSchema,
  assertAgentPermissionResumeSource,
} from "@/lib/execution-host/agent-permission-handoff";
import { agentPromptOwners } from "@/lib/agents/prompt-owner";
import { reworkChildRun } from "@/lib/agents/launch";
import { claimAgentResumeSlot, respondToHitl } from "@/lib/services/hitl";
import { markCheckpointed } from "@/lib/runs/state-transitions";
import { runSweepTick } from "@/lib/runs/keepalive-sweeper";
import { getCommandReceipt } from "@/lib/supervisor-client";
import { queryRunTokens } from "@/lib/runs/cost-rollups";
import { startPromptOwnerWorker } from "@/lib/execution-host/prompt-owner-recovery";
import { RUNTIME_EVENT_CLAIM_LEASE_MS } from "@/lib/execution-host/events/consumer";
import { testRunnerSnapshot } from "@/lib/__tests__/runner-fixtures";
import { createExecutionHosts } from "@/lib/execution-host/client";
import { mintAssignment } from "@/lib/execution-host/assignments";
import {
  localHost,
  resetResolverForTests,
} from "@/lib/execution-host/resolver";
import { resetRegistrarStateForTests } from "@/lib/execution-host/registrar";
import { canonicalProjectors } from "@/lib/execution-host/events/projection-runtime";
import { startProjectionWorker } from "@/lib/execution-host/events/projection-worker";
import { stopRuntimeEventConsumers } from "@/lib/execution-host/events/consumer";
import { initRepo, git } from "@/test-support/git-fixture";
import { addWorktree } from "@/lib/worktree";
import { agentWorkdirPath } from "@/lib/agents/workspace-paths";
import { interruptPermissionInputAcknowledgement } from "@/test-support/permission-ack-fault";
import { countLiveRuns, promoteNextPending } from "@/lib/scheduler";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";
import {
  startRealSupervisor,
  useRealSupervisorUrl,
} from "@/test-support/real-supervisor";

let database: StartedPostgresTestDb;
let db: Db;
let supervisor: RealSupervisor;
let worker: ProjectionWorker;
let restoreUrl: () => void = () => {};
const oldWorktreesRoot = process.env.MAISTER_WORKTREES_ROOT;
const oldRuntimeRoot = process.env.MAISTER_RUNTIME_ROOT;
const drivers: ChildProcess[] = [];
const contract: RunResultContract = {
  kind: "agent_profile",
  profileName: "research",
  schemaRef: "fixture@abcdef123456:research-result.v1",
  schemaVersion: 1,
  sha256: "f".repeat(64),
  required: true,
  schema: {
    schemaVersion: 1,
    fields: [{ name: "summary", type: "string", required: true }],
  },
  sourceFlowRevisionId: "rev-1",
};

beforeAll(async () => {
  database = await startMainPostgresTestDb({
    databaseName: "agent_prompt_owners",
  });
  db = database.db as unknown as Db;
  await db.insert(users).values({
    id: "agent-permission-user",
    email: "agent-permission@test.local",
  });
  supervisor = await startRealSupervisor({
    fixtureArgs: ["--hang", "--lines", "0", "--supports-resume"],
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
  restoreUrl();
  if (oldWorktreesRoot === undefined) delete process.env.MAISTER_WORKTREES_ROOT;
  else process.env.MAISTER_WORKTREES_ROOT = oldWorktreesRoot;
  if (oldRuntimeRoot === undefined) delete process.env.MAISTER_RUNTIME_ROOT;
  else process.env.MAISTER_RUNTIME_ROOT = oldRuntimeRoot;
  await supervisor?.kill();
  await database?.stop();
});

afterEach(async () => {
  // Each completed launcher owns background consumers and a DB pool. Release
  // them between scenarios instead of accumulating dozens of live workers.
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

async function seedAgent(input: {
  bytes: number;
  terminalDelayMs?: number;
  stopReason?: string;
  failMessage?: string;
  persistent?: boolean;
  permission?: boolean;
  hookTrip?: boolean;
  usageTokens?: number;
  parallelPermission?: boolean;
  permissionOnResume?: boolean;
}): Promise<string> {
  const runId = randomUUID();
  const projectId = randomUUID();
  const runnerId = randomUUID();
  const packageId = randomUUID();
  const packageName = `fixture-${runId}`;
  const agentId = `${packageName}:researcher`;
  const repoPath = await initRepo(
    path.join(supervisor.runtimeRoot, `repo-${runId}`),
  );
  const installedPath = path.join(supervisor.runtimeRoot, `package-${runId}`);
  const sourcePath = path.join(
    installedPath,
    "maister-agents",
    "researcher.md",
  );
  const prompt = `fixture-output:${JSON.stringify({ ...input, chunkSize: 400_000, text: '\n```json maister:output\n{"summary":"original answer"}\n```' })}`;

  await mkdir(path.dirname(sourcePath), { recursive: true });
  await writeFile(
    sourcePath,
    `---\nname: Researcher\ndescription: d\nworkspace: ${input.permission ? "worktree" : "none"}\nmode: session\nplatform_mcp: false\ntriggers:\n  - manual\nrisk_tier: read_only\n${input.hookTrip ? `hooks:\n  repetition:\n    max: ${input.parallelPermission ? 2 : 1}\n` : ""}---\n${prompt}\n`,
  );
  await db.insert(projects).values({
    id: projectId,
    slug: `p-${runId}`,
    name: "Agent fixture",
    taskKey: `T${runId.replaceAll("-", "").slice(0, 7)}`.toUpperCase(),
    repoPath,
    maisterYamlPath: path.join(repoPath, "maister.yaml"),
  });
  await db.insert(packageInstalls).values({
    id: packageId,
    sourceUrl: `github.com/fixture/${runId}`,
    name: packageName,
    versionLabel: "v1.0.0",
    resolvedRevision: "rev-1",
    manifest: {},
    manifestDigest: "digest",
    installedPath,
    packageStatus: "Installed",
    trustStatus: "trusted",
  });
  await db.insert(projectPackageAttachments).values({
    id: randomUUID(),
    projectId,
    packageInstallId: packageId,
    packageName,
  });
  await db.insert(agents).values({
    id: agentId,
    packageName,
    versionLabel: "v1.0.0",
    origin: "git",
    name: "Researcher",
    description: "d",
    workspace: input.permission ? "worktree" : "none",
    mode: "session",
    triggers: ["manual"],
    riskTier: "read_only",
    sourcePath,
    enabled: true,
  });
  await db
    .insert(agentProjectLinks)
    .values({ id: randomUUID(), projectId, agentId });
  const snapshot = testRunnerSnapshot(runnerId);

  await db.insert(platformAcpRunners).values({
    id: runnerId,
    adapter: "claude",
    capabilityAgent: "claude",
    model: snapshot.model,
    provider: { kind: "anthropic" },
    permissionPolicy: "default",
    readinessStatus: "Ready",
    readinessReasons: [],
    enabled: true,
  });
  await db.insert(runs).values({
    id: runId,
    projectId,
    runKind: "agent",
    agentId,
    agentWorkspace: input.permission ? "worktree" : "none",
    status: "Running",
    flowVersion: "agent",
    flowRevision: "manual",
    resultContract: contract,
    triggerSource: "manual",
    persistent: input.persistent ?? false,
    addressableKey: input.persistent ? "researcher" : null,
  });
  if (input.permission) {
    const worktreePath = agentWorkdirPath(`p-${runId}`, runId);
    const branch = `maister/permission-${runId}`;
    const baseCommit = await git(repoPath, "rev-parse", "HEAD");

    await addWorktree({
      projectRepoPath: repoPath,
      worktreePath,
      branch,
      startPoint: "main",
      provenance: {
        version: 2,
        runId,
        parentRepoPath: repoPath,
        projectId,
        branch,
        workspaceKind: "agent",
        createdAt: new Date().toISOString(),
      },
    });
    await db.insert(workspaces).values({
      id: randomUUID(),
      runId,
      projectId,
      branch,
      worktreePath,
      parentRepoPath: repoPath,
      baseBranch: "main",
      targetBranch: "main",
      baseCommit,
    });
  }
  await db.insert(runSessions).values({
    id: randomUUID(),
    runId,
    sessionName: "default",
    runnerId,
    runnerSnapshot: snapshot,
    capabilityAgent: "claude",
  });
  const hosts = createExecutionHosts({ db });
  const host = await localHost({ db, transport: hosts.transport });

  await db.transaction((tx) =>
    mintAssignment(tx, { runId, hostId: host.id, reason: "launch" }),
  );

  return runId;
}

function startDriver(
  runId: string,
  message?: string,
  requestKey?: string,
  operation?: "rework",
): ReturnType<typeof startFixture> {
  return startFixture(
    "agent-prompt-owner-process.ts",
    message === undefined
      ? [runId]
      : [
          runId,
          message,
          ...(operation
            ? [requestKey ?? "", operation]
            : requestKey
              ? [requestKey]
              : []),
        ],
  );
}

function startFixture(
  file: string,
  args: string[],
): {
  child: ChildProcess;
  exited: Promise<number | null>;
  output: () => string;
  returned: () => boolean;
} {
  const child = fork(path.resolve("test-support", file), args, {
    execArgv: [
      "--import",
      "tsx",
      "--import",
      path.resolve("scripts/_register-shim.mjs"),
    ],
    env: { ...process.env, DB_URL: database.databaseUrl },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let output = "";
  let returned = false;

  child.on("message", (value: unknown) => {
    if (
      typeof value === "object" &&
      value !== null &&
      "state" in value &&
      value.state === "prompt_returned"
    )
      returned = true;
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

async function expectCompleted(
  runId: string,
  driver?: ReturnType<typeof startDriver>,
): Promise<void> {
  try {
    await expect
      .poll(
        async () => {
          const [run] = await db
            .select({ status: runs.status })
            .from(runs)
            .where(eq(runs.id, runId));

          if (driver && driver.child.exitCode !== null)
            throw new Error(driver.output());

          return ["Done", "Failed", "Crashed"].includes(run.status);
        },
        { timeout: 50_000, interval: 50 },
      )
      .toBe(true);
    const [run] = await db
      .select({ status: runs.status })
      .from(runs)
      .where(eq(runs.id, runId));

    expect(run.status, driver?.output()).toBe("Done");
  } catch (cause) {
    throw new Error(
      `agent terminal observation failed\n${driver?.output() ?? "autonomous owner worker"}`,
      {
        cause,
      },
    );
  }
  const results = await db
    .select()
    .from(runResults)
    .where(eq(runResults.runId, runId));
  const commands = await db
    .select()
    .from(executionCommands)
    .where(
      and(
        eq(executionCommands.runId, runId),
        eq(executionCommands.kind, "session.prompt"),
      ),
    );
  const events = await db
    .select()
    .from(domainEvents)
    .where(eq(domainEvents.runId, runId));

  expect(results).toHaveLength(1);
  expect(results[0]).toMatchObject({
    value: { summary: "original answer" },
    schemaSha256: contract.sha256,
  });
  expect(commands).toHaveLength(1);
  expect(commands[0]).toMatchObject({
    ownerKind: "agent_turn",
    applicationState: "applied",
  });
  expect(events.filter((event) => event.kind === "run.done")).toHaveLength(1);
}

// These windows SIGKILL a process that may hold the runtime-event stream claim.
// A claim is a lease, so no other consumer ingests the killed turn's terminal
// event until it expires — the waits below budget for that instead of being
// re-guessed whenever lane timing shifts.
const KILLED_CLAIM_WAIT_MS = RUNTIME_EVENT_CLAIM_LEASE_MS;

async function killAtTerminalWrite(
  runId: string,
  message?: string,
  operation?: "rework",
): Promise<void> {
  await interruptAgentStatusWrite(
    runId,
    ["Done", "Failed", "Crashed", "Review", "NeedsInputIdle"],
    () => startDriver(runId, message, undefined, operation),
  );
}

async function interruptAcceptedPrompt(
  runId: string,
  driver: ReturnType<typeof startFixture>,
): Promise<void> {
  const resumedCommands = () =>
    db
      .select({
        id: executionCommands.id,
        state: executionCommands.state,
        transportState: executionCommands.transportState,
      })
      .from(agentTurns)
      .innerJoin(
        executionCommands,
        eq(executionCommands.id, agentTurns.commandId),
      )
      .where(
        and(
          eq(agentTurns.runId, runId),
          eq(agentTurns.variant, "resume"),
          eq(agentTurns.state, "dispatched"),
        ),
      );

  // Turn admission precedes HTTP delivery. Wait for the host ACK so
  // this crash exercises terminal recovery, not an unsent command.
  await expect
    .poll(resumedCommands, {
      timeout: 45_000 + KILLED_CLAIM_WAIT_MS,
      interval: 25,
    })
    .toMatchObject([{ state: "accepted", transportState: "acknowledged" }]);
  const [resumedCommand] = await resumedCommands();

  driver.child.kill("SIGKILL");
  await driver.exited;
  // The fixture delays terminal output; prove the kill happened while
  // the acknowledged prompt was still running on the real supervisor.
  expect(await getCommandReceipt(resumedCommand.id)).toMatchObject({
    receiptVersion: 2,
    phase: "accepted",
    terminal: null,
  });
}

async function interruptAgentStatusWrite(
  runId: string,
  statuses: string[],
  start: () => ReturnType<typeof startFixture>,
): Promise<void> {
  const trigger = `agent_pause_${randomUUID().replaceAll("-", "")}`;
  const lockKey = Math.floor(Math.random() * 2_000_000_000) + 1;
  const lock = await database.pool.connect();
  let driver: ReturnType<typeof startDriver> | undefined;

  try {
    await lock.query("SELECT pg_advisory_lock(260909, $1)", [lockKey]);
    await database.pool.query(
      `CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id = '${runId}' AND NEW.status IN (${statuses.map((status) => `'${status.replaceAll("'", "''")}'`).join(",")}) AND (NEW.status <> 'NeedsInputIdle' OR OLD.status = 'Running') THEN PERFORM pg_advisory_xact_lock(260909, ${lockKey}); END IF; RETURN NEW; END $$`,
    );
    await database.pool.query(
      `CREATE TRIGGER ${trigger} BEFORE UPDATE ON runs FOR EACH ROW EXECUTE FUNCTION ${trigger}()`,
    );
    driver = start();
    await expect
      .poll(
        async () => {
          if (driver?.child.exitCode !== null)
            throw new Error(driver?.output());
          const waiting = await database.pool.query(
            "SELECT count(*)::int AS count FROM pg_locks WHERE locktype = 'advisory' AND classid = 260909 AND objid = $1 AND NOT granted",
            [lockKey],
          );

          return waiting.rows[0].count as number;
        },
        { timeout: 45_000 + KILLED_CLAIM_WAIT_MS, interval: 25 },
      )
      .toBe(1);
    driver.child.kill("SIGKILL");
    await driver.exited;
  } finally {
    if (
      driver &&
      driver.child.exitCode === null &&
      driver.child.signalCode === null
    )
      driver.child.kill("SIGKILL");
    await driver?.exited;
    await lock.query("SELECT pg_advisory_unlock_all()");
    lock.release();
    await database.pool.query(`DROP TRIGGER IF EXISTS ${trigger} ON runs`);
    await database.pool.query(`DROP FUNCTION IF EXISTS ${trigger}()`);
  }
}

async function assertPauseGrantRefusals(hitlId: string): Promise<void> {
  const [hitl] = await db
    .select()
    .from(hitlRequests)
    .where(eq(hitlRequests.id, hitlId));
  const response = hitl.response as Record<string, unknown>;
  const grant = agentPermissionResumeSchema.parse(response._agentResume);
  const [assignment] = await db
    .select()
    .from(executionAssignments)
    .where(eq(executionAssignments.id, grant.assignmentId));

  expect(grant.pause).toBeDefined();
  await assertAgentPermissionResumeSource(db, hitl, assignment);
  for (const pause of [
    { ...grant.pause, decisionSha256: "0".repeat(64) },
    { ...grant.pause, haltEventId: randomUUID() },
    {
      ...grant.pause,
      kind: grant.pause?.kind === "hook_trip" ? "budget_breach" : "hook_trip",
    },
  ]) {
    await expect(
      assertAgentPermissionResumeSource(
        db,
        {
          ...hitl,
          response: { ...response, _agentResume: { ...grant, pause } },
        },
        assignment,
      ),
    ).rejects.toMatchObject({
      details: { causeCode: "agent_permission_resume_grant_identity" },
    });
  }
  await expect(
    assertAgentPermissionResumeSource(
      db,
      {
        ...hitl,
        response: { ...response, newLimit: 99_999 },
      },
      assignment,
    ),
  ).rejects.toMatchObject({
    details: { causeCode: "agent_permission_resume_grant_identity" },
  });
}

describe("Agent owned prompts through the production launcher", () => {
  it.each(
    (["escalate", "terminate_restorable"] as const).flatMap((mode) =>
      (
        [
          "live",
          "after_response",
          "before_terminal",
          "before_application",
        ] as const
      ).map((window) => ({ mode, window })),
    ),
  )(
    "owner-agent-budget $mode resumes its exact interrupted source: $window",
    async ({ mode, window }) => {
      const runId = await seedAgent({
        bytes: 0,
        usageTokens: 500,
        persistent: true,
      });

      const launcher = startDriver(runId);

      await expect
        .poll(
          async () =>
            (await db.select().from(runs).where(eq(runs.id, runId)))[0].status,
          { timeout: 15_000, interval: 50 },
        )
        .toBe("NeedsInputIdle");
      await db
        .update(runs)
        .set({
          executionPolicy: {
            preset: "supervised",
            overrides: {
              budget: { run: { maxTokens: 500 } },
              onBudgetBreach: mode,
            },
          },
        })
        .where(eq(runs.id, runId));
      await expect
        .poll(() => queryRunTokens(runId, { client: db }), {
          timeout: 30_000,
          interval: 50,
        })
        .toBe(500);
      const messenger = startDriver(
        runId,
        'fixture-output:{"bytes":0,"terminalDelayMs":12000,"text":"original budget continuation"}',
      );

      await expect
        .poll(
          async () =>
            (
              await db
                .select()
                .from(agentTurns)
                .where(
                  and(
                    eq(agentTurns.runId, runId),
                    eq(agentTurns.state, "dispatched"),
                  ),
                )
            ).length,
          { timeout: 15_000, interval: 50 },
        )
        .toBe(1);
      await expect
        .poll(
          async () =>
            (
              await db
                .select({ id: executionCommands.id })
                .from(executionCommands)
                .innerJoin(
                  agentTurns,
                  eq(agentTurns.commandId, executionCommands.id),
                )
                .where(
                  and(
                    eq(agentTurns.runId, runId),
                    eq(agentTurns.state, "dispatched"),
                    eq(executionCommands.state, "accepted"),
                  ),
                )
            ).length,
          { timeout: 15_000, interval: 50 },
        )
        .toBe(1);
      await runSweepTick({ db });
      const [hitl] = await db
        .select()
        .from(hitlRequests)
        .where(
          and(
            eq(hitlRequests.runId, runId),
            eq(hitlRequests.kind, "budget_breach"),
          ),
        );
      const [source] = await db
        .select()
        .from(agentTurns)
        .where(
          and(eq(agentTurns.runId, runId), eq(agentTurns.state, "dispatched")),
        );

      expect(hitl?.schema).toMatchObject({
        agentPrompt: { commandId: source.commandId, turnId: source.id },
      });
      const [run] = await db.select().from(runs).where(eq(runs.id, runId));

      expect(run.status).toBe(
        mode === "escalate" ? "NeedsInput" : "NeedsInputIdle",
      );
      if (window !== "live") {
        for (const process of [launcher, messenger]) {
          if (
            process.child.exitCode === null &&
            process.child.signalCode === null
          )
            process.child.kill("SIGKILL");
          await process.exited;
        }
        const start = (): ReturnType<typeof startFixture> =>
          startFixture("agent-pause-response-process.ts", [hitl.id]);

        if (window === "after_response" || window === "before_application") {
          await interruptAgentStatusWrite(
            runId,
            [window === "after_response" ? "Running" : "NeedsInputIdle"],
            start,
          );
        } else {
          await interruptAcceptedPrompt(runId, start());
        }
      } else {
        expect(
          await respondToHitl(
            {
              runId,
              hitlRequestId: hitl.id,
              body: { optionId: "raise", response: { newLimit: 10_000 } },
            },
            {
              kind: "user",
              userId: "agent-permission-user",
              label: "Agent budget qualification",
              preauthorizedProjectId: run.projectId!,
            },
            { db },
          ),
        ).toMatchObject({ status: 202 });
      }
      const continuation = startAgentContinuationWorker({ db });

      try {
        // After the launcher's death the worker re-observes the host session
        // every ~6 s while the durable terminal is applied only once the dead
        // launcher's stream claim expires — observed one to three
        // RUNTIME_EVENT_CLAIM_LEASE_MS cycles (19 s / 47 s / 122 s for the
        // same window). The bound is derived from that ceiling, not tuned to
        // a run; the pacing itself is tracked as an open A/B item.
        await expect
          .poll(
            async () =>
              (
                await db
                  .select()
                  .from(agentTurns)
                  .where(
                    and(
                      eq(agentTurns.runId, runId),
                      eq(agentTurns.variant, "resume"),
                      eq(agentTurns.state, "applied"),
                    ),
                  )
              ).length,
            { timeout: 60_000 + 3 * KILLED_CLAIM_WAIT_MS, interval: 100 },
          )
          .toBe(1);
        const turns = await db
          .select()
          .from(agentTurns)
          .where(eq(agentTurns.runId, runId))
          .orderBy(asc(agentTurns.ordinal));

        expect(turns).toHaveLength(3);
        expect(turns[1].state).toBe("superseded");
        expect(turns[2]).toMatchObject({
          variant: "resume",
          state: "applied",
          prompt: source.prompt,
        });
        expect(
          (await db.select().from(runs).where(eq(runs.id, runId)))[0].status,
        ).toBe("NeedsInputIdle");
        await assertPauseGrantRefusals(hitl.id);
      } finally {
        await continuation.stop();
      }
    },
    120_000 + KILLED_CLAIM_WAIT_MS * 4,
  );

  it.each([
    "live",
    "after_response",
    "before_terminal",
    "before_application",
    "parallel_permission",
    "fresh_permission",
  ] as const)(
    "owner-agent-hook resumes its exact interrupted source: %s",
    async (window) => {
      const runId = await seedAgent({
        bytes: 0,
        permission: true,
        hookTrip: true,
        parallelPermission:
          window === "parallel_permission" || window === "fresh_permission",
        permissionOnResume: window === "fresh_permission",
        terminalDelayMs: window === "before_terminal" ? 5_000 : 0,
      });
      const launcher = startDriver(runId);

      await expect
        .poll(
          async () => {
            if (launcher.returned()) throw new Error(launcher.output());

            return (
              await db
                .select()
                .from(hitlRequests)
                .where(
                  and(
                    eq(hitlRequests.runId, runId),
                    eq(hitlRequests.kind, "hook_trip"),
                  ),
                )
            ).length;
          },
          { timeout: 30_000, interval: 50 },
        )
        .toBe(1);
      const [hitl] = await db
        .select()
        .from(hitlRequests)
        .where(
          and(
            eq(hitlRequests.runId, runId),
            eq(hitlRequests.kind, "hook_trip"),
          ),
        );
      const [source] = await db
        .select()
        .from(agentTurns)
        .where(eq(agentTurns.runId, runId));

      expect(hitl.schema).toMatchObject({
        agentPrompt: { commandId: source.commandId, turnId: source.id },
      });
      const [run] = await db.select().from(runs).where(eq(runs.id, runId));

      if (
        window === "live" ||
        window === "parallel_permission" ||
        window === "fresh_permission"
      ) {
        expect(await claimAgentResumeSlot(db, runId)).toEqual({
          outcome: "queued",
        });
      }
      if (window === "parallel_permission" || window === "fresh_permission") {
        const [cancelled] = await db
          .select()
          .from(hitlRequests)
          .where(
            and(
              eq(hitlRequests.runId, runId),
              eq(hitlRequests.kind, "permission"),
            ),
          );

        expect(cancelled).toMatchObject({
          respondedAt: null,
          supersededByHitlRequestId: hitl.id,
        });
        expect(cancelled.supersededAt).not.toBeNull();
        await expect(
          database.pool.query(
            "UPDATE hitl_requests SET superseded_by_hitl_request_id = $1 WHERE id = $2",
            [randomUUID(), cancelled.id],
          ),
        ).rejects.toMatchObject({
          code: "23514",
          constraint: "hitl_requests_agent_pause_permission_source",
        });
        await expect(
          respondToHitl(
            { runId, hitlRequestId: cancelled.id, body: { optionId: "allow" } },
            {
              kind: "user",
              userId: "agent-permission-user",
              label: "Late cancelled input",
              preauthorizedProjectId: run.projectId!,
            },
            { db },
          ),
        ).rejects.toMatchObject({ code: "CONFLICT" });
      }
      if (
        window !== "live" &&
        window !== "parallel_permission" &&
        window !== "fresh_permission"
      ) {
        launcher.child.kill("SIGKILL");
        await launcher.exited;
        const start = (): ReturnType<typeof startFixture> =>
          startFixture("agent-pause-response-process.ts", [hitl.id]);

        if (window === "after_response" || window === "before_application") {
          await interruptAgentStatusWrite(
            runId,
            [window === "after_response" ? "Running" : "Review"],
            start,
          );
        } else {
          await interruptAcceptedPrompt(runId, start());
        }
      } else {
        expect(
          await respondToHitl(
            { runId, hitlRequestId: hitl.id, body: { optionId: "resume" } },
            {
              kind: "user",
              userId: "agent-permission-user",
              label: "Agent hook qualification",
              preauthorizedProjectId: run.projectId!,
            },
            { db },
          ),
        ).toMatchObject({ status: 202 });
      }
      const continuation = startAgentContinuationWorker({ db });

      try {
        if (window === "fresh_permission") {
          const freshPermissions = () =>
            db
              .select()
              .from(hitlRequests)
              .where(
                and(
                  eq(hitlRequests.runId, runId),
                  eq(hitlRequests.kind, "permission"),
                  isNull(hitlRequests.supersededAt),
                ),
              );

          await expect
            .poll(async () => (await freshPermissions()).length, {
              timeout: 30_000,
              interval: 50,
            })
            .toBe(1);
          const [fresh] = await freshPermissions();

          expect(fresh.respondedAt).toBeNull();
          expect(fresh.response).toBeNull();
          expect(fresh.schema).not.toMatchObject({
            agentPrompt: { commandId: source.commandId },
          });
          expect(
            await respondToHitl(
              { runId, hitlRequestId: fresh.id, body: { optionId: "allow" } },
              {
                kind: "user",
                userId: "agent-permission-user",
                label: "Fresh permission after pause",
                preauthorizedProjectId: run.projectId!,
              },
              { db },
            ),
          ).toMatchObject({ status: 200 });
        }
        await expect
          .poll(
            async () =>
              (await db.select().from(runs).where(eq(runs.id, runId)))[0]
                .status,
            { timeout: 60_000 + KILLED_CLAIM_WAIT_MS, interval: 100 },
          )
          .toBe("Review");
        const turns = await db
          .select()
          .from(agentTurns)
          .where(eq(agentTurns.runId, runId))
          .orderBy(asc(agentTurns.ordinal));

        expect(turns).toHaveLength(2);
        expect(turns[0].state).toBe("superseded");
        expect(turns[1]).toMatchObject({
          variant: "resume",
          state: "applied",
          prompt: source.prompt,
        });
        const [result] = await db
          .select()
          .from(runResults)
          .where(eq(runResults.runId, runId));

        expect(result.value).toEqual({ summary: "original answer" });
        await assertPauseGrantRefusals(hitl.id);
      } finally {
        await continuation.stop();
      }
    },
    120_000 + KILLED_CLAIM_WAIT_MS * 2,
  );

  it("owner-agent-worker starts an admitted run before its first turn exists", async () => {
    const runId = await seedAgent({ bytes: 0 });

    expect(
      await db.select().from(agentTurns).where(eq(agentTurns.runId, runId)),
    ).toHaveLength(0);
    const workers = [
      startAgentContinuationWorker({ db }),
      startAgentContinuationWorker({ db }),
    ];

    try {
      await expect
        .poll(
          async () =>
            (await db.select().from(runs).where(eq(runs.id, runId)))[0].status,
          { timeout: 15_000, interval: 100 },
        )
        .toBe("Done");
      const turns = await db
        .select()
        .from(agentTurns)
        .where(eq(agentTurns.runId, runId));

      expect(turns).toHaveLength(1);
      expect(turns[0].state).toBe("applied");
      const commands = await db
        .select()
        .from(executionCommands)
        .where(eq(executionCommands.runId, runId));

      expect(
        commands.filter((command) => command.kind === "session.create"),
      ).toHaveLength(1);
      expect(
        commands.filter((command) => command.kind === "session.prompt"),
      ).toHaveLength(1);
      const [result] = await db
        .select()
        .from(runResults)
        .where(eq(runResults.runId, runId));

      expect(result.value).toEqual({ summary: "original answer" });
    } finally {
      await Promise.all(workers.map((worker) => worker.stop()));
    }
  }, 45_000);

  it("owner-agent-checkpoint-rejected settles a definitive input rejection without a resume slot", async () => {
    const runId = await seedAgent({ bytes: 0, permission: true });
    const launcher = startDriver(runId);

    await expect
      .poll(
        async () =>
          (
            await db
              .select()
              .from(hitlRequests)
              .where(eq(hitlRequests.runId, runId))
          ).length,
        { timeout: 60_000, interval: 50 },
      )
      .toBe(1);
    const [hitl] = await db
      .select()
      .from(hitlRequests)
      .where(eq(hitlRequests.runId, runId));
    const [source] = await db
      .select()
      .from(agentTurns)
      .where(eq(agentTurns.runId, runId));
    const hosts = createExecutionHosts({ db });
    const client = await hosts.forRun(runId);
    const [session] = await db
      .select()
      .from(runSessions)
      .where(eq(runSessions.runId, runId));

    launcher.child.kill("SIGKILL");
    await launcher.exited;
    await client.deliverInput(session.hostSessionId!, {
      kind: "permission",
      action: "cancel",
      requestId: (hitl.schema as { requestId: string }).requestId,
      reason: "operator-cancelled",
    });
    await interruptPermissionInputAcknowledgement({
      database,
      hitlRequestId: hitl.id,
      startResponder: () =>
        startFixture("flow-permission-response-process.ts", [
          hitl.id,
          "unused",
          "agent-permission-user",
        ]),
    });
    const [pending] = await db
      .select()
      .from(hitlRequests)
      .where(eq(hitlRequests.id, hitl.id));
    const delivery = pending.response as { _delivery: { commandId: string } };

    expect(
      await hosts.transport.getCommandReceipt(delivery._delivery.commandId),
    ).toMatchObject({
      phase: "rejected",
      httpStatus: 410,
      body: { code: "HITL_TIMEOUT" },
    });
    await client.checkpoint(session.hostSessionId!);
    expect((await markCheckpointed(runId, { db })).ok).toBe(true);
    const continuation = startAgentContinuationWorker({ db });

    try {
      await expect
        .poll(
          async () =>
            (await db.select().from(runs).where(eq(runs.id, runId)))[0].status,
          { timeout: 60_000 + KILLED_CLAIM_WAIT_MS, interval: 100 },
        )
        .toBe("Failed");
      expect(await claimAgentResumeSlot(db, runId, hosts)).toEqual({
        outcome: "noop",
      });
      const assignments = await db
        .select()
        .from(executionAssignments)
        .where(eq(executionAssignments.runId, runId));

      expect(assignments).toHaveLength(1);
      const [finished] = await db
        .select()
        .from(agentTurns)
        .where(eq(agentTurns.id, source.id));

      expect(finished.state).toBe("superseded");
      const [input] = await db
        .select()
        .from(executionCommands)
        .where(eq(executionCommands.id, delivery._delivery.commandId));

      expect(input.state).toBe("failed");
      const [responded] = await db
        .select()
        .from(hitlRequests)
        .where(eq(hitlRequests.id, hitl.id));

      expect(responded.response).toMatchObject({
        optionId: "allow",
        _audit: { errorCode: "HITL_TIMEOUT" },
      });
      expect(responded.respondedAt).not.toBeNull();
      expect(
        await db.select().from(runResults).where(eq(runResults.runId, runId)),
      ).toHaveLength(0);
      expect(
        await db
          .select()
          .from(executionCommands)
          .where(
            and(
              eq(executionCommands.runId, runId),
              eq(executionCommands.kind, "session.prompt"),
            ),
          ),
      ).toHaveLength(1);
    } finally {
      await continuation.stop();
    }
  }, 120_000);
  it.each(["live", "before_apply"] as const)(
    "owner-agent-checkpoint-result retains the completed original through %s",
    async (window) => {
      const runId = await seedAgent({ bytes: 0, permission: true });
      const launcher = startDriver(runId);

      await expect
        .poll(
          async () => {
            const rows = await db
              .select()
              .from(hitlRequests)
              .where(eq(hitlRequests.runId, runId));

            return rows.length;
          },
          { timeout: 60_000, interval: 50 },
        )
        .toBe(1);
      const [hitl] = await db
        .select()
        .from(hitlRequests)
        .where(eq(hitlRequests.runId, runId));
      const [source] = await db
        .select()
        .from(agentTurns)
        .where(eq(agentTurns.runId, runId));

      launcher.child.kill("SIGKILL");
      await launcher.exited;
      await interruptPermissionInputAcknowledgement({
        database,
        hitlRequestId: hitl.id,
        startResponder: () =>
          startFixture("flow-permission-response-process.ts", [
            hitl.id,
            "unused",
            "agent-permission-user",
          ]),
      });
      const hosts = createExecutionHosts({ db });

      await expect
        .poll(
          async () =>
            (await hosts.transport.getCommandReceipt(source.commandId!))?.phase,
          { timeout: 30_000, interval: 50 },
        )
        .toBe("completed");
      const client = await hosts.forRun(runId);
      const [session] = await db
        .select()
        .from(runSessions)
        .where(eq(runSessions.runId, runId));

      await client.checkpoint(session.hostSessionId!);
      expect((await markCheckpointed(runId, { db })).ok).toBe(true);
      await expect
        .poll(
          async () => (await claimAgentResumeSlot(db, runId, hosts)).outcome,
          { timeout: 60_000 + KILLED_CLAIM_WAIT_MS, interval: 100 },
        )
        .toBe("claimed");
      const [claimed] = await db
        .select()
        .from(hitlRequests)
        .where(eq(hitlRequests.id, hitl.id));

      expect(claimed.response).toMatchObject({
        _agentResume: {
          kind: "result",
          sourceCommandId: source.commandId,
          turnId: source.id,
        },
      });
      if (window === "live") {
        const response = claimed.response as Record<string, unknown>;
        const grant = response._agentResume as Record<string, unknown>;

        try {
          for (const [key, value] of Object.entries({
            sourceRequestSha256: "0".repeat(64),
            sourceTerminalEvidenceSha256: "0".repeat(64),
            checkpointCommandId: "wrong-checkpoint",
            inputCommandId: "wrong-input",
            resumeSessionId: "wrong-acp-session",
            optionId: "wrong-choice",
          })) {
            await db
              .update(hitlRequests)
              .set({
                response: {
                  ...response,
                  _agentResume: { ...grant, [key]: value },
                },
              })
              .where(eq(hitlRequests.id, hitl.id));
            await expect(
              db.transaction((tx) =>
                lockAgentPermissionResult(tx, runId, source.commandId!),
              ),
            ).rejects.toMatchObject({
              details: {
                reason: "prompt_owner_invariant",
                causeCode: "agent_permission_resume_grant_identity",
              },
            });
          }
        } finally {
          await db
            .update(hitlRequests)
            .set({ response })
            .where(eq(hitlRequests.id, hitl.id));
        }
      }
      if (window === "before_apply") await killAtTerminalWrite(runId);
      const resumed = startDriver(runId);

      await expect
        .poll(
          async () => {
            const [run] = await db
              .select()
              .from(runs)
              .where(eq(runs.id, runId));

            if (resumed.returned() && run.status !== "Review")
              throw new Error(resumed.output());

            return run.status;
          },
          { timeout: 60_000 + KILLED_CLAIM_WAIT_MS, interval: 100 },
        )
        .toBe("Review");
      const turns = await db
        .select()
        .from(agentTurns)
        .where(eq(agentTurns.runId, runId));

      expect(turns).toHaveLength(1);
      expect(turns[0]).toMatchObject({
        id: source.id,
        state: "applied",
        prompt: source.prompt,
      });
      const commands = await db
        .select()
        .from(executionCommands)
        .where(eq(executionCommands.runId, runId));

      expect(
        commands.filter((command) => command.kind === "session.create"),
      ).toHaveLength(1);
      expect(
        commands.filter((command) => command.kind === "session.prompt"),
      ).toHaveLength(1);
      expect(
        commands.find((command) => command.id === source.commandId)
          ?.applicationState,
      ).toBe("applied");
      const [result] = await db
        .select()
        .from(runResults)
        .where(eq(runResults.runId, runId));

      expect(result.value).toEqual({ summary: "original answer" });
      const [completed] = await db
        .select()
        .from(hitlRequests)
        .where(eq(hitlRequests.id, hitl.id));

      expect(completed.respondedAt).not.toBeNull();
      expect(completed.response).toMatchObject({
        _agentResume: { applied: true },
      });
    },
    180_000,
  );
  it("owner-agent-checkpoint resumes an unanswered original permission under an explicit grant", async () => {
    const runId = await seedAgent({ bytes: 0, permission: true });
    const driver = startDriver(runId);

    await expect
      .poll(
        async () => {
          const rows = await db
            .select()
            .from(hitlRequests)
            .where(eq(hitlRequests.runId, runId));

          return rows.length;
        },
        { timeout: 30_000, interval: 25 },
      )
      .toBe(1);
    const [hitl] = await db
      .select()
      .from(hitlRequests)
      .where(eq(hitlRequests.runId, runId));
    const [source] = await db
      .select()
      .from(agentTurns)
      .where(eq(agentTurns.runId, runId));

    driver.child.kill("SIGKILL");
    await driver.exited;
    const hosts = createExecutionHosts({ db });
    const client = await hosts.forRun(runId);
    const [session] = await db
      .select()
      .from(runSessions)
      .where(eq(runSessions.runId, runId));

    await client.checkpoint(session.hostSessionId!);
    expect((await markCheckpointed(runId, { db })).ok).toBe(true);
    const [run] = await db.select().from(runs).where(eq(runs.id, runId));
    const response = await respondToHitl(
      { runId, hitlRequestId: hitl.id, body: { optionId: "allow" } },
      {
        kind: "user",
        userId: "agent-permission-user",
        label: "Agent checkpoint qualification",
        preauthorizedProjectId: run.projectId!,
      },
      { db },
    );

    expect(response.status).toBe(202);
    const [beforeWorker] = await db
      .select()
      .from(hitlRequests)
      .where(eq(hitlRequests.id, hitl.id));

    if (
      !(beforeWorker.response as Record<string, unknown> | null)?._agentResume
    )
      expect(await response.json()).toMatchObject({
        runStatus: "NeedsInputIdle",
      });
    const continuation = startAgentContinuationWorker({ db });

    try {
      await expect
        .poll(
          async () => {
            const [row] = await db
              .select()
              .from(hitlRequests)
              .where(eq(hitlRequests.id, hitl.id));

            return (row.response as Record<string, unknown> | null)
              ?._agentResume;
          },
          { timeout: 60_000 + KILLED_CLAIM_WAIT_MS, interval: 100 },
        )
        .toBeDefined();
      const [claimed] = await db
        .select()
        .from(hitlRequests)
        .where(eq(hitlRequests.id, hitl.id));

      expect(claimed.response).toMatchObject({
        _agentResume: {
          version: 1,
          kind: "continue",
          sourceCommandId: source.commandId,
          assignmentId: expect.any(String),
          turnId: expect.any(String),
        },
      });
      await expect
        .poll(
          async () => {
            const [current] = await db
              .select()
              .from(runs)
              .where(eq(runs.id, runId));

            return current.status;
          },
          { timeout: 45_000, interval: 50 },
        )
        .toBe("Review");
      const turns = await db
        .select()
        .from(agentTurns)
        .where(eq(agentTurns.runId, runId))
        .orderBy(asc(agentTurns.ordinal));

      expect(turns).toHaveLength(2);
      expect(turns[0].state).toBe("superseded");
      expect(turns[1]).toMatchObject({
        variant: "resume",
        state: "applied",
        prompt: source.prompt,
      });
      const requests = await db
        .select()
        .from(hitlRequests)
        .where(eq(hitlRequests.runId, runId));

      expect(requests).toHaveLength(2);
      expect(requests.every((request) => request.respondedAt !== null)).toBe(
        true,
      );
      const [result] = await db
        .select()
        .from(runResults)
        .where(eq(runResults.runId, runId));

      expect(result.value).toEqual({ summary: "original answer" });
    } finally {
      await continuation.stop();
    }
  }, 90_000);

  it.each(["live", "launcher_restart", "input_ack_restart"] as const)(
    "owner-agent-permission retains its exact source through %s",
    async (window) => {
      const runId = await seedAgent({ bytes: 0, permission: true });
      const driver = startDriver(runId);

      await expect
        .poll(
          async () => {
            const requests = await db
              .select()
              .from(hitlRequests)
              .where(eq(hitlRequests.runId, runId));

            if (requests.length === 0 && driver.returned())
              throw new Error(driver.output());

            return requests.length;
          },
          { timeout: 30_000, interval: 25 },
        )
        .toBe(1);
      const [hitl] = await db
        .select()
        .from(hitlRequests)
        .where(eq(hitlRequests.runId, runId));
      const [turn] = await db
        .select()
        .from(agentTurns)
        .where(eq(agentTurns.runId, runId));

      expect(hitl.schema).toMatchObject({
        agentPrompt: {
          version: 1,
          commandId: turn.commandId,
          turnId: turn.id,
          promptOrdinal: turn.ordinal,
          assignmentId: turn.executionAssignmentId,
          incarnationId: turn.incarnationId,
        },
      });
      if (window === "input_ack_restart") {
        await interruptPermissionInputAcknowledgement({
          database,
          hitlRequestId: hitl.id,
          startResponder: () =>
            startFixture("flow-permission-response-process.ts", [
              hitl.id,
              "unused",
              "agent-permission-user",
            ]),
        });
        const [pending] = await db
          .select()
          .from(hitlRequests)
          .where(eq(hitlRequests.id, hitl.id));
        const [paused] = await db.select().from(runs).where(eq(runs.id, runId));

        expect(pending.respondedAt).toBeNull();
        expect(paused.status).toBe("NeedsInput");
      }
      if (window !== "live") {
        driver.child.kill("SIGKILL");
        await driver.exited;
        const resumed = startDriver(runId);

        await expect
          .poll(
            () => resumed.output().includes("agent-owned-session-observing"),
            {
              timeout: 15_000,
              interval: 25,
            },
          )
          .toBe(true);
      }
      if (window !== "input_ack_restart") {
        const [run] = await db.select().from(runs).where(eq(runs.id, runId));
        const response = await respondToHitl(
          { runId, hitlRequestId: hitl.id, body: { optionId: "allow" } },
          {
            kind: "user",
            userId: "agent-permission-user",
            label: "Agent permission qualification",
            preauthorizedProjectId: run.projectId!,
          },
          { db },
        );

        expect(response.status).toBe(200);
      }
      await expect
        .poll(
          async () => {
            const [current] = await db
              .select()
              .from(runs)
              .where(eq(runs.id, runId));

            return current.status;
          },
          { timeout: 35_000, interval: 50 },
        )
        .toBe("Review");
      const requests = await db
        .select()
        .from(hitlRequests)
        .where(eq(hitlRequests.runId, runId));

      expect(requests).toHaveLength(1);
      expect(requests[0].respondedAt).not.toBeNull();
      expect(requests[0].response).toMatchObject({
        _delivery: { commandId: expect.any(String) },
        _audit: { sourceCommandId: turn.commandId },
      });
      const prompts = await db
        .select()
        .from(executionCommands)
        .where(
          and(
            eq(executionCommands.runId, runId),
            eq(executionCommands.kind, "session.prompt"),
          ),
        );

      expect(prompts).toHaveLength(1);
      expect(prompts[0].applicationState).toBe("applied");
      const inputs = await db
        .select()
        .from(executionCommands)
        .where(
          and(
            eq(executionCommands.runId, runId),
            eq(executionCommands.kind, "session.input"),
          ),
        );

      expect(inputs).toHaveLength(1);
      expect(inputs[0].state).toBe("succeeded");
      const [result] = await db
        .select()
        .from(runResults)
        .where(eq(runResults.runId, runId));

      expect(result.value).toEqual({ summary: "original answer" });
    },
    90_000,
  );

  it.each(["live", "before_terminal", "before_apply"] as const)(
    "owner-agent-rework retains its requested result after %s",
    async (window) => {
      const runId = await seedAgent({ bytes: 0 });

      await expectCompleted(runId, startDriver(runId));
      await db.update(runs).set({ status: "Review" }).where(eq(runs.id, runId));
      const prompt = `fixture-output:${JSON.stringify({ bytes: 0, terminalDelayMs: window === "before_terminal" ? 5_000 : 0, text: '\n```json maister:output\n{"summary":"reworked answer"}\n```' })}`;

      if (window === "live")
        expect(await reworkChildRun(runId, prompt, { db })).toMatchObject({
          childRunId: runId,
          status: "Done",
        });
      else if (window === "before_apply")
        await killAtTerminalWrite(runId, prompt, "rework");
      else {
        const driver = startDriver(runId, prompt, undefined, "rework");

        if (window === "before_terminal") {
          await expect
            .poll(
              async () => {
                const [command] = await db
                  .select()
                  .from(executionCommands)
                  .where(
                    and(
                      eq(executionCommands.runId, runId),
                      eq(executionCommands.kind, "session.prompt"),
                      eq(executionCommands.state, "accepted"),
                    ),
                  );

                return command?.ownerRef?.variant;
              },
              { timeout: 15_000, interval: 25 },
            )
            .toBe("rework");
          const [prior] = await db
            .select()
            .from(runResults)
            .where(eq(runResults.runId, runId));

          expect(prior.validity).toBe("stale");
          driver.child.kill("SIGKILL");
          await driver.exited;
        }
      }
      if (window !== "live") startDriver(runId);
      await expect
        .poll(
          async () => {
            const [turn] = await db
              .select()
              .from(agentTurns)
              .where(
                and(
                  eq(agentTurns.runId, runId),
                  eq(agentTurns.variant, "rework"),
                ),
              );

            return turn?.state;
          },
          { timeout: 50_000, interval: 50 },
        )
        .toBe("applied");
      const results = await db
        .select()
        .from(runResults)
        .where(eq(runResults.runId, runId))
        .orderBy(asc(runResults.revision));

      expect(results).toHaveLength(2);
      expect(results[0].validity).not.toBe("valid");
      expect(results[1]).toMatchObject({
        validity: "valid",
        value: { summary: "reworked answer" },
        schemaSha256: contract.sha256,
      });
      const prompts = await db
        .select()
        .from(executionCommands)
        .where(
          and(
            eq(executionCommands.runId, runId),
            eq(executionCommands.kind, "session.prompt"),
          ),
        );

      expect(prompts).toHaveLength(2);
      expect(
        prompts.every((command) => command.applicationState === "applied"),
      ).toBe(true);
    },
    120_000 + KILLED_CLAIM_WAIT_MS * 2,
  );

  it("owner-agent-rework refuses admission while its agent pool is full", async () => {
    const previousCap = process.env.MAISTER_MAX_CONCURRENT_AGENTS;
    const runId = await seedAgent({ bytes: 0 });

    await expectCompleted(runId, startDriver(runId));
    await db.update(runs).set({ status: "Review" }).where(eq(runs.id, runId));
    const occupying = await seedAgent({ bytes: 0 });

    process.env.MAISTER_MAX_CONCURRENT_AGENTS = "1";
    try {
      await expect(
        reworkChildRun(runId, 'fixture-output:{"bytes":0}', { db }),
      ).rejects.toMatchObject({
        code: "CONFLICT",
        details: { reason: "agent_pool_full" },
      });
      const [run] = await db.select().from(runs).where(eq(runs.id, runId));

      expect(run.status).toBe("Review");
      expect(
        await db
          .select()
          .from(agentTurns)
          .where(
            and(eq(agentTurns.runId, runId), eq(agentTurns.variant, "rework")),
          ),
      ).toHaveLength(0);
    } finally {
      await db.delete(runs).where(eq(runs.id, occupying));
      if (previousCap === undefined)
        delete process.env.MAISTER_MAX_CONCURRENT_AGENTS;
      else process.env.MAISTER_MAX_CONCURRENT_AGENTS = previousCap;
    }
  }, 60_000);

  it.each(["live", "before_apply"] as const)(
    "owner-agent-message settles a failed retained create after %s",
    async (window) => {
      const runId = await seedAgent({ bytes: 0, persistent: true });

      startDriver(runId);
      await expect
        .poll(
          async () => {
            const [run] = await db
              .select()
              .from(runs)
              .where(eq(runs.id, runId));

            return run.status;
          },
          { timeout: 30_000, interval: 50 },
        )
        .toBe("NeedsInputIdle");
      await db
        .update(runSessions)
        .set({ acpSessionId: "fixture-missing-session" })
        .where(eq(runSessions.runId, runId));
      const prompt = 'fixture-output:{"bytes":0,"text":"must never dispatch"}';

      if (window === "before_apply") {
        await killAtTerminalWrite(runId, prompt);
        startDriver(runId);
      } else startDriver(runId, prompt);
      await expect
        .poll(
          async () => {
            const [run] = await db
              .select()
              .from(runs)
              .where(eq(runs.id, runId));

            return run.status;
          },
          { timeout: 30_000, interval: 50 },
        )
        .toBe("Failed");
      const [turn] = await db
        .select()
        .from(agentTurns)
        .where(
          and(
            eq(agentTurns.runId, runId),
            eq(agentTurns.variant, "persistent_message"),
          ),
        );

      expect(turn).toMatchObject({
        prompt,
        state: "superseded",
        commandId: null,
      });
      const creates = await db
        .select()
        .from(executionCommands)
        .where(
          and(
            eq(executionCommands.runId, runId),
            eq(executionCommands.kind, "session.create"),
          ),
        );

      expect(creates).toHaveLength(2);
      expect(
        creates.filter((command) => command.state === "failed"),
      ).toHaveLength(1);
      expect(
        creates.every(
          (command) => command.createIntent?.sessionFallback === false,
        ),
      ).toBe(true);
      const prompts = await db
        .select()
        .from(executionCommands)
        .where(
          and(
            eq(executionCommands.runId, runId),
            eq(executionCommands.kind, "session.prompt"),
          ),
        );

      expect(prompts).toHaveLength(1);
    },
    90_000,
  );

  it.each(["before_create_ack", "before_prompt"] as const)(
    "owner-agent-initial preserves its create and original input after %s",
    async (window) => {
      const runId = await seedAgent({ bytes: 0 });
      const trigger = `agent_create_pause_${randomUUID().replaceAll("-", "")}`;
      const lockKey = Math.floor(Math.random() * 2_000_000_000) + 1;
      const lock = await database.pool.connect();
      const table =
        window === "before_create_ack" ? "run_sessions" : "execution_commands";
      const operation = window === "before_create_ack" ? "UPDATE" : "INSERT";
      const predicate =
        window === "before_create_ack"
          ? "NEW.host_session_id IS NOT NULL"
          : "NEW.kind = 'session.prompt'";
      let driver: ReturnType<typeof startDriver> | undefined;

      try {
        await lock.query("SELECT pg_advisory_lock(260910, $1)", [lockKey]);
        await database.pool.query(
          `CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.run_id = '${runId}' AND ${predicate} THEN PERFORM pg_advisory_xact_lock(260910, ${lockKey}); END IF; RETURN NEW; END $$`,
        );
        await database.pool.query(
          `CREATE TRIGGER ${trigger} BEFORE ${operation} ON ${table} FOR EACH ROW EXECUTE FUNCTION ${trigger}()`,
        );
        driver = startDriver(runId);
        await expect
          .poll(
            async () => {
              if (driver?.child.exitCode !== null)
                throw new Error(driver?.output());
              const waiting = await database.pool.query(
                "SELECT count(*)::int AS count FROM pg_locks WHERE locktype = 'advisory' AND classid = 260910 AND objid = $1 AND NOT granted",
                [lockKey],
              );

              return waiting.rows[0].count as number;
            },
            { timeout: 30_000, interval: 25 },
          )
          .toBeGreaterThan(0);
        driver.child.kill("SIGKILL");
        await driver.exited;
      } finally {
        if (driver?.child.exitCode === null && driver.child.signalCode === null)
          driver.child.kill("SIGKILL");
        await driver?.exited;
        await lock.query("SELECT pg_advisory_unlock_all()");
        lock.release();
        await database.pool.query(
          `DROP TRIGGER IF EXISTS ${trigger} ON ${table}`,
        );
        await database.pool.query(`DROP FUNCTION IF EXISTS ${trigger}()`);
      }
      const [run] = await db.select().from(runs).where(eq(runs.id, runId));
      const [agent] = await db
        .select()
        .from(agents)
        .where(eq(agents.id, run.agentId!));
      const source = await readFile(agent.sourcePath, "utf8");

      await writeFile(
        agent.sourcePath,
        source.replace("original answer", "changed answer"),
      );
      const restarted = startDriver(runId);

      await expectCompleted(runId, restarted);
      const creates = await db
        .select()
        .from(executionCommands)
        .where(
          and(
            eq(executionCommands.runId, runId),
            eq(executionCommands.kind, "session.create"),
          ),
        );

      expect(creates).toHaveLength(1);
      expect(creates[0].createIntent).toMatchObject({
        owner: { variant: "agent" },
      });
    },
    90_000,
  );

  it("owner-agent-live-message drains distinct queued inputs once after the original launcher dies", async () => {
    const runId = await seedAgent({
      bytes: 0,
      persistent: true,
      terminalDelayMs: 15_000,
    });
    const original = startDriver(runId);

    await expect
      .poll(
        async () => {
          const [command] = await db
            .select()
            .from(executionCommands)
            .where(
              and(
                eq(executionCommands.runId, runId),
                eq(executionCommands.kind, "session.prompt"),
              ),
            );

          return command?.state;
        },
        { timeout: 30_000, interval: 25 },
      )
      .toBe("accepted");
    const prompts = [
      'fixture-output:{"bytes":0,"text":"first queued reply"}',
      'fixture-output:{"bytes":0,"text":"second queued reply"}',
    ];

    for (const [index, prompt] of prompts.entries()) {
      const sender = startDriver(runId, prompt, `message-${index}`);

      await expect
        .poll(sender.returned, { timeout: 10_000, interval: 25 })
        .toBe(true);
    }
    const retry = startDriver(runId, prompts[0], "message-0");

    await expect
      .poll(retry.returned, { timeout: 10_000, interval: 25 })
      .toBe(true);
    const queued = await db
      .select()
      .from(agentTurns)
      .where(
        and(
          eq(agentTurns.runId, runId),
          inArray(agentTurns.variant, ["live_message", "persistent_message"]),
        ),
      )
      .orderBy(asc(agentTurns.ordinal));

    expect(
      queued.map((turn) => ({
        prompt: turn.prompt,
        state: turn.state,
        variant: turn.variant,
      })),
    ).toEqual(
      prompts.map((prompt) => ({
        prompt,
        state: "queued",
        variant: "live_message",
      })),
    );
    original.child.kill("SIGKILL");
    await original.exited;
    startDriver(runId);
    await expect
      .poll(
        async () => {
          const turns = await db
            .select()
            .from(agentTurns)
            .where(
              and(
                eq(agentTurns.runId, runId),
                inArray(agentTurns.variant, [
                  "live_message",
                  "persistent_message",
                ]),
              ),
            )
            .orderBy(asc(agentTurns.ordinal));

          return turns.map((turn) => turn.state);
        },
        { timeout: 65_000, interval: 50 },
      )
      .toEqual(["applied", "applied"]);
    const commands = await db
      .select()
      .from(executionCommands)
      .where(
        and(
          eq(executionCommands.runId, runId),
          eq(executionCommands.kind, "session.prompt"),
        ),
      )
      .orderBy(asc(executionCommands.createdAt));

    expect(commands).toHaveLength(3);
    expect(
      commands.every((command) => command.applicationState === "applied"),
    ).toBe(true);
    expect(
      commands
        .slice(1)
        .map((command) =>
          command.ownerRef && "turnId" in command.ownerRef
            ? command.ownerRef.turnId
            : null,
        ),
    ).toEqual(queued.map((turn) => turn.id));
    const [run] = await db.select().from(runs).where(eq(runs.id, runId));

    expect(run).toMatchObject({
      status: "NeedsInputIdle",
      resumeRequestedAt: null,
    });
  }, 110_000);

  it.each(["live", "before_terminal", "before_apply"] as const)(
    "owner-agent-resume retains the completed turn input after %s",
    async (window) => {
      const runId = await seedAgent({
        bytes: 0,
        persistent: true,
        terminalDelayMs: window === "before_terminal" ? 3_000 : 0,
      });
      const initial = startDriver(runId);

      await expect
        .poll(initial.returned, { timeout: 30_000, interval: 50 })
        .toBe(true);
      const [source] = await db
        .select()
        .from(agentTurns)
        .where(eq(agentTurns.runId, runId));

      expect(source.state).toBe("applied");
      const claim = await claimAgentResumeSlot(db, runId);

      expect(claim.outcome).toBe("claimed");
      const [turn] = await db
        .select()
        .from(agentTurns)
        .where(
          and(eq(agentTurns.runId, runId), eq(agentTurns.variant, "resume")),
        );

      expect(turn).toMatchObject({
        state: "claimed",
        prompt: source.prompt,
      });
      expect(turn.executionAssignmentId).not.toBe(source.executionAssignmentId);
      if (window === "before_apply") await killAtTerminalWrite(runId);
      else {
        const driver = startDriver(runId);

        if (window === "before_terminal") {
          await expect
            .poll(
              async () => {
                const [command] = await db
                  .select()
                  .from(executionCommands)
                  .where(
                    and(
                      eq(executionCommands.runId, runId),
                      eq(executionCommands.kind, "session.prompt"),
                      eq(
                        executionCommands.executionAssignmentId,
                        turn.executionAssignmentId!,
                      ),
                    ),
                  );

                return command?.state;
              },
              { timeout: 30_000, interval: 25 },
            )
            .toBe("accepted");
          driver.child.kill("SIGKILL");
          await driver.exited;
        }
      }
      if (window !== "live") startDriver(runId);
      await expect
        .poll(
          async () => {
            const [current] = await db
              .select()
              .from(agentTurns)
              .where(eq(agentTurns.id, turn.id));

            return current.state;
          },
          { timeout: 50_000, interval: 50 },
        )
        .toBe("applied");
      const commands = await db
        .select()
        .from(executionCommands)
        .where(
          and(
            eq(executionCommands.runId, runId),
            eq(executionCommands.kind, "session.prompt"),
          ),
        );

      expect(commands).toHaveLength(2);
      expect(
        commands.every((command) => command.applicationState === "applied"),
      ).toBe(true);
      const [run] = await db.select().from(runs).where(eq(runs.id, runId));

      expect(run.status).toBe("NeedsInputIdle");
    },
    90_000,
  );

  it.each(["live", "before_terminal", "before_apply"] as const)(
    "owner-agent-idle-message applies the original accepted message after %s",
    async (window) => {
      const runId = await seedAgent({ bytes: 0, persistent: true });

      startDriver(runId);
      await expect
        .poll(
          async () => {
            const [run] = await db
              .select()
              .from(runs)
              .where(eq(runs.id, runId));

            return run.status;
          },
          { timeout: 30_000, interval: 50 },
        )
        .toBe("NeedsInputIdle");
      const message = `fixture-output:${JSON.stringify({ bytes: 0, text: "original follow-up answer", terminalDelayMs: window === "before_terminal" ? 3_000 : 0 })}`;

      if (window === "before_apply") await killAtTerminalWrite(runId, message);
      else {
        const delivery = startDriver(runId, message);

        if (window === "before_terminal") {
          await expect
            .poll(
              async () => {
                const [turn] = await db
                  .select()
                  .from(agentTurns)
                  .where(
                    and(
                      eq(agentTurns.runId, runId),
                      inArray(agentTurns.variant, [
                        "live_message",
                        "persistent_message",
                      ]),
                    ),
                  );

                if (!turn?.commandId) return null;
                const [command] = await db
                  .select()
                  .from(executionCommands)
                  .where(eq(executionCommands.id, turn.commandId));

                return command?.state;
              },
              { timeout: 30_000, interval: 25 },
            )
            .toBe("accepted");
          delivery.child.kill("SIGKILL");
          await delivery.exited;
        }
      }
      if (window !== "live") startDriver(runId);
      await expect
        .poll(
          async () => {
            const [turn] = await db
              .select()
              .from(agentTurns)
              .where(
                and(
                  eq(agentTurns.runId, runId),
                  inArray(agentTurns.variant, [
                    "live_message",
                    "persistent_message",
                  ]),
                ),
              );

            return turn?.state;
          },
          { timeout: 50_000, interval: 50 },
        )
        .toBe("applied");
      const [turn] = await db
        .select()
        .from(agentTurns)
        .where(
          and(
            eq(agentTurns.runId, runId),
            inArray(agentTurns.variant, ["live_message", "persistent_message"]),
          ),
        );
      const [run] = await db.select().from(runs).where(eq(runs.id, runId));
      const commands = await db
        .select()
        .from(executionCommands)
        .where(
          and(
            eq(executionCommands.runId, runId),
            eq(executionCommands.kind, "session.prompt"),
          ),
        );
      const command = commands.find((item) => item.id === turn.commandId);

      expect(run.status).toBe("NeedsInputIdle");
      expect(turn).toMatchObject({
        prompt: message,
        variant: "persistent_message",
        state: "applied",
      });
      expect(turn.completedAt).not.toBeNull();
      expect(commands).toHaveLength(2);
      expect(command).toMatchObject({
        ownerKind: "agent_turn",
        applicationState: "applied",
        ownerRef: {
          turnId: turn.id,
          messageId: turn.id,
          promptOrdinal: turn.ordinal,
        },
      });
      expect(command?.completionAppliedAt).not.toBeNull();
      expect(
        await db.select().from(runResults).where(eq(runResults.runId, runId)),
      ).toHaveLength(0);
    },
    110_000,
  );

  it("owner-agent-idle-message retains accepted input while the agent pool is full", async () => {
    const previousCap = process.env.MAISTER_MAX_CONCURRENT_AGENTS;
    // Earlier cases in this shared database leave slot-holding runs whose
    // settlement timing depends on lease expiry, so "full" is pinned relative
    // to the live count instead of an absolute 1 that residue can break.
    const occupied = await countLiveRuns(db as never, "agent");

    process.env.MAISTER_MAX_CONCURRENT_AGENTS = String(occupied + 1);
    try {
      const runId = await seedAgent({ bytes: 0, persistent: true });

      startDriver(runId);
      await expect
        .poll(
          async () => {
            const [run] = await db
              .select()
              .from(runs)
              .where(eq(runs.id, runId));

            return run.status;
          },
          { timeout: 30_000, interval: 50 },
        )
        .toBe("NeedsInputIdle");
      const occupyingRunId = await seedAgent({ bytes: 0 });
      const message =
        'fixture-output:{"bytes":0,"text":"queued original input"}';
      const delivery = startDriver(runId, message);

      await expect
        .poll(delivery.returned, { timeout: 30_000, interval: 50 })
        .toBe(true);
      const [run] = await db.select().from(runs).where(eq(runs.id, runId));

      expect(run.status).toBe("NeedsInputIdle");
      expect(run.resumeRequestedAt).not.toBeNull();
      const turns = await db
        .select()
        .from(agentTurns)
        .where(
          and(
            eq(agentTurns.runId, runId),
            inArray(agentTurns.variant, ["live_message", "persistent_message"]),
          ),
        );

      expect(turns).toHaveLength(1);
      expect(turns[0]).toMatchObject({
        state: "queued",
        prompt: message,
        commandId: null,
        executionAssignmentId: null,
      });
      const commands = await db
        .select()
        .from(executionCommands)
        .where(
          and(
            eq(executionCommands.runId, runId),
            eq(executionCommands.kind, "session.prompt"),
          ),
        );

      expect(commands).toHaveLength(1);
      await db.delete(runs).where(eq(runs.id, occupyingRunId));
      let resumedDriver: ReturnType<typeof startDriver> | undefined;
      const promoted = await promoteNextPending({
        db,
        pool: "agent",
        startAgentRun: (id) => {
          resumedDriver = startDriver(id);
        },
      });

      expect(promoted.promotedRunId).toBe(runId);
      await expect
        .poll(() => resumedDriver?.returned(), {
          timeout: 30_000,
          interval: 50,
        })
        .toBe(true);
      const [applied] = await db
        .select()
        .from(agentTurns)
        .where(eq(agentTurns.id, turns[0].id));

      expect(applied).toMatchObject({ state: "applied", prompt: message });
      const promptCommands = await db
        .select()
        .from(executionCommands)
        .where(
          and(
            eq(executionCommands.runId, runId),
            eq(executionCommands.kind, "session.prompt"),
          ),
        );

      expect(promptCommands).toHaveLength(2);
    } finally {
      if (previousCap === undefined)
        delete process.env.MAISTER_MAX_CONCURRENT_AGENTS;
      else process.env.MAISTER_MAX_CONCURRENT_AGENTS = previousCap;
    }
  }, 80_000);

  it.each(["live", "before_terminal", "before_apply"] as const)(
    "owner-agent-persistent-first parks the original turn after %s",
    async (window) => {
      const runId = await seedAgent({
        bytes: 0,
        persistent: true,
        terminalDelayMs: window === "before_terminal" ? 3_000 : 0,
      });

      if (window === "before_apply") await killAtTerminalWrite(runId);
      else {
        const driver = startDriver(runId);

        if (window === "before_terminal") {
          await expect
            .poll(
              async () => {
                const [command] = await db
                  .select()
                  .from(executionCommands)
                  .where(
                    and(
                      eq(executionCommands.runId, runId),
                      eq(executionCommands.kind, "session.prompt"),
                    ),
                  );

                return command?.state;
              },
              { timeout: 30_000, interval: 25 },
            )
            .toBe("accepted");
          driver.child.kill("SIGKILL");
          await driver.exited;
        }
      }
      const ownerWorker = startPromptOwnerWorker({
        db,
        owners: agentPromptOwners,
      });

      try {
        await expect
          .poll(
            async () => {
              const [run] = await db
                .select()
                .from(runs)
                .where(eq(runs.id, runId));

              return run.status;
            },
            { timeout: 50_000, interval: 50 },
          )
          .toBe("NeedsInputIdle");
        const [session] = await db
          .select()
          .from(runSessions)
          .where(eq(runSessions.runId, runId));
        const commands = await db
          .select()
          .from(executionCommands)
          .where(
            and(
              eq(executionCommands.runId, runId),
              eq(executionCommands.kind, "session.prompt"),
            ),
          );

        expect(session.acpSessionId).toEqual(expect.any(String));
        expect(commands).toHaveLength(1);
        expect(commands[0]).toMatchObject({
          ownerKind: "agent_turn",
          applicationState: "applied",
        });
        expect(commands[0].completionAppliedAt).not.toBeNull();
        expect(
          await db.select().from(runResults).where(eq(runResults.runId, runId)),
        ).toHaveLength(0);
        expect(
          await db
            .select()
            .from(domainEvents)
            .where(eq(domainEvents.runId, runId)),
        ).toHaveLength(0);
        const [assignment] = await db
          .select()
          .from(executionAssignments)
          .where(eq(executionAssignments.runId, runId));

        expect(assignment).toMatchObject({
          state: "released",
          releasedReason: "parked",
        });
        const sessions = await createExecutionHosts({ db })
          .local()
          .listSessions();

        expect(
          sessions.filter(
            (item) => item.runId === runId && item.status === "live",
          ),
        ).toHaveLength(0);
      } finally {
        await ownerWorker.stop();
      }
    },
    100_000,
  );

  it("owner-agent-initial retains original result beyond the preview limit", async () => {
    const runId = await seedAgent({ bytes: 1_999_983 });
    const driver = startDriver(runId);

    await expectCompleted(runId, driver);
  }, 90_000);
  it.each(["before_terminal", "before_apply"] as const)(
    "owner-agent-initial recovers after SIGKILL %s without another prompt",
    async (window) => {
      const runId = await seedAgent({
        bytes: 0,
        terminalDelayMs: window === "before_terminal" ? 3_000 : 0,
      });

      if (window === "before_apply") await killAtTerminalWrite(runId);
      else {
        const first = startDriver(runId);

        await expect
          .poll(
            async () => {
              const [command] = await db
                .select({ state: executionCommands.state })
                .from(executionCommands)
                .where(
                  and(
                    eq(executionCommands.runId, runId),
                    eq(executionCommands.kind, "session.prompt"),
                  ),
                );

              return command?.state;
            },
            { timeout: 30_000, interval: 25 },
          )
          .toBe("accepted");
        first.child.kill("SIGKILL");
        await first.exited;
      }
      await expectCompleted(runId, startDriver(runId));
    },
    90_000,
  );
  it("owner-agent-initial autonomously applies a terminal command after its launcher dies", async () => {
    const runId = await seedAgent({ bytes: 1_999_983 });

    await killAtTerminalWrite(runId);
    const recovering = startPromptOwnerWorker({
      db,
      owners: agentPromptOwners,
    });

    try {
      await expectCompleted(runId);
    } finally {
      await recovering.stop();
    }
  }, 90_000);

  it("owner-agent-initial cannot finalize a successor assignment from historical output", async () => {
    const runId = await seedAgent({ bytes: 0, terminalDelayMs: 3_000 });
    const first = startDriver(runId);

    await expect
      .poll(
        async () => {
          const [command] = await db
            .select({ state: executionCommands.state })
            .from(executionCommands)
            .where(
              and(
                eq(executionCommands.runId, runId),
                eq(executionCommands.kind, "session.prompt"),
              ),
            );

          return command?.state;
        },
        { timeout: 30_000, interval: 25 },
      )
      .toBe("accepted");
    first.child.kill("SIGKILL");
    await first.exited;
    const hosts = createExecutionHosts({ db });
    const host = await localHost({ db, transport: hosts.transport });
    const successor = await db.transaction((tx) =>
      mintAssignment(tx, { runId, hostId: host.id, reason: "recover" }),
    );
    const recovering = startPromptOwnerWorker({
      db,
      owners: agentPromptOwners,
    });

    try {
      await expect
        .poll(
          async () => {
            const [command] = await db
              .select({ applicationState: executionCommands.applicationState })
              .from(executionCommands)
              .where(
                and(
                  eq(executionCommands.runId, runId),
                  eq(executionCommands.kind, "session.prompt"),
                ),
              );

            return command?.applicationState;
          },
          { timeout: 30_000, interval: 50 },
        )
        .toBe("superseded");
      const [run] = await db.select().from(runs).where(eq(runs.id, runId));

      const [source] = await db
        .select()
        .from(executionCommands)
        .where(
          and(
            eq(executionCommands.runId, runId),
            eq(executionCommands.kind, "session.prompt"),
          ),
        );

      expect(source.state).toBe("succeeded");
      expect(run).toMatchObject({
        status: "Running",
        executionAssignmentId: successor.id,
        endedAt: null,
      });
      expect(
        await db.select().from(runResults).where(eq(runResults.runId, runId)),
      ).toHaveLength(0);
      expect(
        await db
          .select()
          .from(domainEvents)
          .where(eq(domainEvents.runId, runId)),
      ).toHaveLength(0);
    } finally {
      await recovering.stop();
    }
  }, 60_000);
  it.each([
    { name: "non-end-turn response", stopReason: "max_tokens" },
    {
      name: "adapter request failure",
      failMessage: "fixture adapter rejected the original prompt",
    },
    {
      name: "persistent non-end-turn response",
      persistent: true,
      stopReason: "max_tokens",
    },
    {
      name: "persistent adapter request failure",
      persistent: true,
      failMessage: "fixture adapter rejected the persistent prompt",
    },
  ])(
    "owner-agent-initial settles $name and stops its exact session",
    async (failure) => {
      const runId = await seedAgent({ bytes: 0, ...failure });

      startDriver(runId);
      await expect
        .poll(
          async () => {
            const [run] = await db
              .select({ status: runs.status })
              .from(runs)
              .where(eq(runs.id, runId));

            return run.status;
          },
          { timeout: 15_000, interval: 50 },
        )
        .toBe("Failed");
      const commands = await db
        .select()
        .from(executionCommands)
        .where(
          and(
            eq(executionCommands.runId, runId),
            eq(executionCommands.kind, "session.prompt"),
          ),
        );

      expect(commands).toHaveLength(1);
      expect(commands[0]).toMatchObject({
        ownerKind: "agent_turn",
        applicationState: "applied",
      });
      expect(
        await db.select().from(runResults).where(eq(runResults.runId, runId)),
      ).toHaveLength(0);
      const active = await db
        .select()
        .from(executionAssignments)
        .where(
          and(
            eq(executionAssignments.runId, runId),
            eq(executionAssignments.state, "active"),
          ),
        );

      expect(active).toHaveLength(0);
      const events = await db
        .select()
        .from(domainEvents)
        .where(
          and(
            eq(domainEvents.runId, runId),
            eq(domainEvents.kind, "run.failed"),
          ),
        );

      expect(events).toHaveLength(1);
      const sessions = await createExecutionHosts({ db })
        .local()
        .listSessions();

      expect(
        sessions.filter(
          (session) => session.runId === runId && session.status === "live",
        ),
      ).toHaveLength(0);
    },
    45_000,
  );
});
