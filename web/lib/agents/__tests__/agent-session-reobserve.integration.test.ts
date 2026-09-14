// A `run_kind='agent'` run has exactly ONE in-process reader of its canonical
// event stream. When the process holding it dies, the session stays live on the
// supervisor and nobody reads it: reconcile classified the run `reattach` and
// then refused ("refusing reattach for non-flow run"), so the run held a live,
// unread session until the session itself died — and the sweep then crashed it
// as `agent-session-gone`, naming what the sweep noticed rather than what
// happened.
//
// This drives the real production launcher against a REAL supervisor child, kills
// the process that observes the session, and pins the recovery: the sweep puts an
// observer back, writes no run state doing it, and the run still finishes through
// its OWN path (the prompt owner), not through a sweep crash.

import type { Db } from "@/lib/execution-host/db";
import type { RealSupervisor } from "@/test-support/real-supervisor";
import type { ProjectionWorker } from "@/lib/execution-host/events/projection-worker";

import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  agents,
  agentProjectLinks,
  domainEvents,
  executionCommands,
  packageInstalls,
  platformAcpRunners,
  projectPackageAttachments,
  projects,
  runs,
  runSessions,
  users,
} from "@/lib/db/schema";
import { hasAgentSessionObserver } from "@/lib/agents/session-observer-registry";
import { runReconcileSweep } from "@/lib/reconcile";
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
const oldRuntimeRoot = process.env.MAISTER_RUNTIME_ROOT;
const drivers: ChildProcess[] = [];

beforeAll(async () => {
  database = await startMainPostgresTestDb({
    databaseName: "agent_session_reobserve",
  });
  db = database.db as unknown as Db;
  await db.insert(users).values({
    id: "reobserve-user",
    email: "reobserve@test.local",
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
  for (const child of drivers) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    const exited = new Promise<void>((resolve) =>
      child.once("exit", () => resolve()),
    );

    child.kill("SIGKILL");
    await exited;
  }
}, 30_000);

// A `workspace: none` platform agent whose fixture turn holds the terminal
// response open long enough for the driver to be killed mid-turn.
async function seedAgent(terminalDelayMs: number): Promise<string> {
  const runId = randomUUID();
  const projectId = randomUUID();
  const runnerId = randomUUID();
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
  const spec = JSON.stringify({ bytes: 0, terminalDelayMs });

  await mkdir(path.dirname(sourcePath), { recursive: true });
  await writeFile(
    sourcePath,
    `---\nname: Researcher\ndescription: d\nworkspace: none\nmode: session\nplatform_mcp: false\ntriggers:\n  - manual\nrisk_tier: read_only\n---\nfixture-output:${spec}\n`,
  );
  await db.insert(projects).values({
    id: projectId,
    slug: `p-${runId}`,
    name: "Reobserve fixture",
    taskKey: `T${runId.replaceAll("-", "").slice(0, 7)}`.toUpperCase(),
    repoPath,
    maisterYamlPath: path.join(repoPath, "maister.yaml"),
  });
  const packageId = randomUUID();

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
    triggerSource: "manual",
    persistent: false,
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

// The production launcher, in its OWN process — the process whose death this
// scenario is about.
function startDriver(runId: string): {
  child: ChildProcess;
  output: () => string;
} {
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
  const record = (chunk: Buffer): void => {
    output = (output + chunk.toString("utf8")).slice(-16_384);
  };

  child.stdout?.on("data", record);
  child.stderr?.on("data", record);
  drivers.push(child);

  return { child, output: () => output };
}

async function liveHostSessionId(runId: string): Promise<string> {
  const hosts = createExecutionHosts({ db });
  const records = await hosts.local().listSessions();
  const record = records.find(
    (entry) => entry.runId === runId && entry.status === "live",
  );

  expect(record, "the supervisor must still hold a live session").toBeTruthy();

  return record!.sessionId;
}

function sweep(): ReturnType<typeof runReconcileSweep> {
  return runReconcileSweep({
    db,
    executionHosts: createExecutionHosts({ db }),
    // The agent run carries no workspace (`workspace: none`), so no worktree
    // list can decide anything here; a stub keeps the tick off the filesystem.
    listWorktrees: async () => [],
    runFlow: () => {},
  });
}

describe("reconcile re-observes a live agent session whose reader is gone", () => {
  it("kills the observing process mid-turn, re-observes through the sweep, and lets the run finish its own way", async () => {
    const runId = await seedAgent(20_000);
    const driver = startDriver(runId);

    // The session is live and the turn is in flight — the shape the stand hit.
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
        { timeout: 60_000, interval: 50 },
      )
      .toBe("accepted");

    const sessionId = await liveHostSessionId(runId);

    expect(
      hasAgentSessionObserver(sessionId),
      "the observer lives in the driver process, not this one",
    ).toBe(false);

    const exited = new Promise<void>((resolve) =>
      driver.child.once("exit", () => resolve()),
    );

    driver.child.kill("SIGKILL");
    await exited;

    // Before the fix this tick logged "refusing reattach for non-flow run".
    const first = await sweep();

    expect(first.reobserved, driver.output()).toBe(1);
    expect(first.crashed).toBe(0);
    expect(hasAgentSessionObserver(sessionId)).toBe(true);

    // The run state is untouched by the re-observe itself.
    const [afterSweep] = await db
      .select({ status: runs.status, endedAt: runs.endedAt })
      .from(runs)
      .where(eq(runs.id, runId));

    expect(afterSweep).toMatchObject({ status: "Running", endedAt: null });

    // A second tick finds the observer it just installed and leaves it alone —
    // one observer per session, never two.
    const second = await sweep();

    expect(second.reobserved).toBe(0);
    expect(second.crashed).toBe(0);

    // The run still completes through its OWN path: the prompt owner applies
    // the turn's terminal outcome. The observer never terminalizes a run with
    // an owned prompt.
    const recovering = startPromptOwnerWorker({
      db,
      owners: agentPromptOwners,
    });

    try {
      await expect
        .poll(
          async () => {
            const [run] = await db
              .select({ status: runs.status })
              .from(runs)
              .where(eq(runs.id, runId));

            return run.status;
          },
          { timeout: 90_000, interval: 100 },
        )
        .toBe("Done");
    } finally {
      await recovering.stop();
    }

    const events = await db
      .select()
      .from(domainEvents)
      .where(eq(domainEvents.runId, runId));

    expect(events.filter((event) => event.kind === "run.done")).toHaveLength(1);
    expect(events.filter((event) => event.kind === "run.crashed")).toHaveLength(
      0,
    );
  }, 240_000);
});
