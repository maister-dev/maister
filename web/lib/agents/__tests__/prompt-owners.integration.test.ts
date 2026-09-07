import type { Db } from "@/lib/execution-host/db";
import type { RunResultContract } from "@/lib/run-results/types";
import type { RealSupervisor } from "@/test-support/real-supervisor";
import type { ProjectionWorker } from "@/lib/execution-host/events/projection-worker";

import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { and, eq } from "drizzle-orm";
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
} from "@/lib/db/schema";
import { agentPromptOwners } from "@/lib/agents/prompt-owner";
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

function startDriver(runId: string): {
  child: ChildProcess;
  exited: Promise<number | null>;
  output: () => string;
} {
  const child = fork(
    path.resolve("test-support/agent-prompt-owner-process.ts"),
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

  return { child, exited, output: () => output };
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

async function killAtTerminalWrite(runId: string): Promise<void> {
  const trigger = `agent_pause_${randomUUID().replaceAll("-", "")}`;
  const lockKey = Math.floor(Math.random() * 2_000_000_000) + 1;
  const lock = await database.pool.connect();
  let driver: ReturnType<typeof startDriver> | undefined;

  try {
    await lock.query("SELECT pg_advisory_lock(260909, $1)", [lockKey]);
    await database.pool.query(
      `CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id = '${runId}' AND NEW.status IN ('Done', 'Failed', 'Crashed', 'Review') THEN PERFORM pg_advisory_xact_lock(260909, ${lockKey}); END IF; RETURN NEW; END $$`,
    );
    await database.pool.query(
      `CREATE TRIGGER ${trigger} BEFORE UPDATE ON runs FOR EACH ROW EXECUTE FUNCTION ${trigger}()`,
    );
    driver = startDriver(runId);
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
