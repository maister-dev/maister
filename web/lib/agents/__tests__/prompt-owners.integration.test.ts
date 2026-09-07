import type { Db } from "@/lib/execution-host/db";
import type { RunResultContract } from "@/lib/run-results/types";
import type { RealSupervisor } from "@/test-support/real-supervisor";
import type { ProjectionWorker } from "@/lib/execution-host/events/projection-worker";

import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { and, asc, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

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
} from "@/lib/db/schema";
import { agentPromptOwners } from "@/lib/agents/prompt-owner";
import { reworkChildRun } from "@/lib/agents/launch";
import { startPromptOwnerWorker } from "@/lib/execution-host/prompt-owner-recovery";
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
import { initRepo } from "@/test-support/git-fixture";
import { promoteNextPending } from "@/lib/scheduler";
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
  supervisor = await startRealSupervisor({
    fixtureArgs: ["--hang", "--lines", "0", "--supports-resume"],
  });
  restoreUrl = useRealSupervisorUrl(supervisor.url);
  process.env.MAISTER_WORKTREES_ROOT = path.join(
    supervisor.runtimeRoot,
    "worktrees",
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
  await supervisor?.kill();
  await database?.stop();
});

async function seedAgent(input: {
  bytes: number;
  terminalDelayMs?: number;
  stopReason?: string;
  failMessage?: string;
  persistent?: boolean;
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
    `---\nname: Researcher\ndescription: d\nworkspace: none\nmode: session\nplatform_mcp: false\ntriggers:\n  - manual\nrisk_tier: read_only\n---\n${prompt}\n`,
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
    workspace: "none",
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
    agentWorkspace: "none",
    status: "Running",
    flowVersion: "agent",
    flowRevision: "manual",
    resultContract: contract,
    triggerSource: "manual",
    persistent: input.persistent ?? false,
    addressableKey: input.persistent ? "researcher" : null,
  });
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
): {
  child: ChildProcess;
  exited: Promise<number | null>;
  output: () => string;
  returned: () => boolean;
} {
  const child = fork(
    path.resolve("test-support/agent-prompt-owner-process.ts"),
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

async function killAtTerminalWrite(
  runId: string,
  message?: string,
  operation?: "rework",
): Promise<void> {
  const trigger = `agent_pause_${randomUUID().replaceAll("-", "")}`;
  const lockKey = Math.floor(Math.random() * 2_000_000_000) + 1;
  const lock = await database.pool.connect();
  let driver: ReturnType<typeof startDriver> | undefined;

  try {
    await lock.query("SELECT pg_advisory_lock(260909, $1)", [lockKey]);
    await database.pool.query(
      `CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id = '${runId}' AND NEW.status IN ('Done', 'Failed', 'Crashed', 'Review', 'NeedsInputIdle') THEN PERFORM pg_advisory_xact_lock(260909, ${lockKey}); END IF; RETURN NEW; END $$`,
    );
    await database.pool.query(
      `CREATE TRIGGER ${trigger} BEFORE UPDATE ON runs FOR EACH ROW EXECUTE FUNCTION ${trigger}()`,
    );
    driver = startDriver(runId, message, undefined, operation);
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
        { timeout: 30_000, interval: 25 },
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

describe("Agent owned prompts through the production launcher", () => {
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
    120_000,
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

    process.env.MAISTER_MAX_CONCURRENT_AGENTS = "1";
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
