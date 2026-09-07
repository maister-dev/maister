// S2.9: a scratch dialog turn is owned by its durable identity — the launch
// generation for the initial prompt, the accepted transcript row for a user
// message — and the WaitingForUser transition is applied from that turn's own
// verified command output, against a real Postgres and a real supervisor.

import type { Db } from "@/lib/execution-host/db";
import type { ProjectionWorker } from "@/lib/execution-host/events/projection-worker";
import type { RealSupervisor } from "@/test-support/real-supervisor";
import type { ScratchLaunchInput } from "@/lib/scratch-runs/types";

import { randomUUID } from "node:crypto";
import { execFile, fork, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path, { join } from "node:path";
import { promisify } from "node:util";

import { and, eq } from "drizzle-orm";
import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import * as schema from "@/lib/db/schema";
import { testPlatformRunnerRow } from "@/lib/__tests__/runner-fixtures";
import { canonicalProjectors } from "@/lib/execution-host/events/projection-runtime";
import { startProjectionWorker } from "@/lib/execution-host/events/projection-worker";
import { stopRuntimeEventConsumers } from "@/lib/execution-host/events/consumer";
import { resetRegistrarStateForTests } from "@/lib/execution-host/registrar";
import { resetResolverForTests } from "@/lib/execution-host/resolver";
import { startPromptOwnerWorker } from "@/lib/execution-host/prompt-owner-recovery";
import { scratchPromptOwners } from "@/lib/scratch-runs/prompt-owner";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";
import {
  startRealSupervisor,
  useRealSupervisorUrl,
} from "@/test-support/real-supervisor";

const execFileAsync = promisify(execFile);
const USER_ID = "scratch-owner-user";

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

let launchScratchRunStaged: typeof import("@/lib/scratch-runs/service").launchScratchRunStaged;
let sendScratchUserMessage: typeof import("@/lib/scratch-runs/service").sendScratchUserMessage;

let testDatabase: StartedPostgresTestDb;
let db: NodePgDatabase<typeof schema>;
let supervisor: RealSupervisor;
let worker: ProjectionWorker;
let restoreUrl: () => void = () => {};
let projectId: string;
const savedEnv: Record<string, string | undefined> = {};

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args]);

  return stdout;
}

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "scratch_prompt_owners",
  });
  db = testDatabase.db;
  supervisor = await startRealSupervisor({
    fixtureArgs: ["--hang", "--lines", "0", "--supports-resume"],
  });
  restoreUrl = useRealSupervisorUrl(supervisor.url);
  resetRegistrarStateForTests();
  resetResolverForTests();
  worker = startProjectionWorker({
    db: db as unknown as Db,
    projectors: canonicalProjectors,
  });
  ({ launchScratchRunStaged, sendScratchUserMessage } = await import(
    "@/lib/scratch-runs/service"
  ));
  for (const key of [
    "DB_URL",
    "MAISTER_RUNTIME_ROOT",
    "MAISTER_WORKTREES_ROOT",
  ])
    savedEnv[key] = process.env[key];
  process.env.DB_URL = testDatabase.container.getConnectionUri();
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
    name: "Scratch owner",
    repoPath: repo,
    taskKey: "SCR",
  });
}, 240_000);

afterAll(async () => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await stopRuntimeEventConsumers();
  restoreUrl();
  await worker?.stop();
  await supervisor?.kill();
  await testDatabase?.stop();
  await rm(join(supervisor?.runtimeRoot ?? "/nonexistent", "worktrees"), {
    recursive: true,
    force: true,
  }).catch(() => undefined);
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

async function launch(prompt: string): Promise<string> {
  const staged = launchScratchRunStaged({
    body: launchBody(prompt),
    userId: USER_ID,
  });

  for (;;) {
    const step = await staged.next();

    if (step.done) return step.value.runId;
  }
}

async function promptCommands(runId: string) {
  return db
    .select()
    .from(schema.executionCommands)
    .where(
      and(
        eq(schema.executionCommands.runId, runId),
        eq(schema.executionCommands.kind, "session.prompt"),
      ),
    )
    .orderBy(schema.executionCommands.createdAt);
}

function startTurnProcess(args: readonly string[]): {
  child: ChildProcess;
  exited: Promise<number | null>;
  output: () => string;
} {
  const child = fork(
    path.resolve("test-support", "scratch-prompt-owner-process.ts"),
    [...args],
    {
      execArgv: [
        "--import",
        "tsx",
        "--import",
        path.resolve("scripts/_register-shim.mjs"),
      ],
      env: { ...process.env, DB_URL: testDatabase.databaseUrl },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    },
  );
  let output = "";
  const record = (chunk: Buffer): void => {
    output = (output + chunk.toString("utf8")).slice(-16_384);
  };

  child.stdout?.on("data", record);
  child.stderr?.on("data", record);

  return {
    child,
    exited: new Promise<number | null>((resolve, reject) => {
      child.once("exit", resolve);
      child.once("error", reject);
    }),
    output: () => output,
  };
}

/** Hold the driver inside the dialog transition, then kill it there. */
async function killAtDialogTransition(
  runId: string,
  args: readonly string[],
): Promise<void> {
  const trigger = `scratch_pause_${randomUUID().replaceAll("-", "")}`;
  const lockKey = Math.floor(Math.random() * 2_000_000_000) + 1;
  const lock = await testDatabase.pool.connect();
  let driver: ReturnType<typeof startTurnProcess> | undefined;

  try {
    await lock.query("SELECT pg_advisory_lock(280907, $1)", [lockKey]);
    await testDatabase.pool.query(
      `CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.run_id = '${runId}' AND NEW.dialog_status = 'WaitingForUser' THEN PERFORM pg_advisory_xact_lock(280907, ${lockKey}); END IF; RETURN NEW; END $$`,
    );
    await testDatabase.pool.query(
      `CREATE TRIGGER ${trigger} BEFORE UPDATE ON scratch_runs FOR EACH ROW EXECUTE FUNCTION ${trigger}()`,
    );
    driver = startTurnProcess(args);
    await expect
      .poll(
        async () => {
          if (driver?.child.exitCode !== null)
            throw new Error(driver?.output());
          const waiting = await testDatabase.pool.query(
            "SELECT count(*)::int AS count FROM pg_locks WHERE locktype = 'advisory' AND classid = 280907 AND objid = $1 AND NOT granted",
            [lockKey],
          );

          return waiting.rows[0].count as number;
        },
        { timeout: 60_000, interval: 25 },
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
    await testDatabase.pool.query(
      `DROP TRIGGER IF EXISTS ${trigger} ON scratch_runs`,
    );
    await testDatabase.pool.query(`DROP FUNCTION IF EXISTS ${trigger}()`);
  }
}

describe("Scratch prompt owners through the production service", () => {
  it("owner-scratch-initial: the launch turn owns its WaitingForUser transition", async () => {
    const runId = await launch('fixture-output:{"bytes":0,"text":"hello"}');
    const [command] = await promptCommands(runId);
    const [scratch] = await db
      .select()
      .from(schema.scratchRuns)
      .where(eq(schema.scratchRuns.runId, runId));
    const [assignment] = await db
      .select()
      .from(schema.executionAssignments)
      .where(
        and(
          eq(schema.executionAssignments.runId, runId),
          eq(schema.executionAssignments.state, "active"),
        ),
      );

    expect(command?.ownerKind).toBe("scratch_message");
    expect(command?.ownerRef).toMatchObject({
      variant: "initial",
      scratchRunId: runId,
      turnId: assignment.id,
      promptOrdinal: 0,
    });
    expect(command?.logicalOperationKey).toBe(
      `scratch_message:initial:${assignment.id}:0`,
    );
    expect(command?.applicationState).toBe("applied");
    expect(scratch.dialogStatus).toBe("WaitingForUser");
  }, 240_000);

  it("owner-scratch-message: the accepted transcript row owns its own turn", async () => {
    const runId = await launch('fixture-output:{"bytes":0,"text":"hello"}');
    const sent = await sendScratchUserMessage({
      runId,
      body: {
        content: 'fixture-output:{"bytes":0,"text":"second"}',
        attachments: [],
      },
    });

    expect(sent.dialogStatus).toBe("WaitingForUser");
    const commands = await promptCommands(runId);

    expect(commands).toHaveLength(2);
    const [, messageCommand] = commands;

    expect(messageCommand.ownerKind).toBe("scratch_message");
    expect(messageCommand.ownerRef).toMatchObject({
      variant: "message",
      scratchRunId: runId,
      turnId: sent.messageId,
      messageId: sent.messageId,
      promptOrdinal: sent.sequence,
    });
    expect(messageCommand.logicalOperationKey).toBe(
      `scratch_message:message:${sent.messageId}:${sent.sequence}`,
    );
    expect(messageCommand.applicationState).toBe("applied");
    // Two distinct turns, never one command attached to both.
    expect(
      new Set(commands.map((command) => command.logicalOperationKey)).size,
    ).toBe(2);
  }, 240_000);
  it("owner-scratch-message: process death before the transition keeps the turn", async () => {
    const runId = await launch('fixture-output:{"bytes":0,"text":"hello"}');
    const messageId = randomUUID();
    const prompt = 'fixture-output:{"bytes":0,"text":"stranded"}';

    // What the service persists before it dispatches a user message: the
    // accepted transcript row plus the dialog back in its Running turn.
    await db.insert(schema.runMessages).values({
      id: messageId,
      runId,
      sequence: 100,
      role: "user",
      content: prompt,
    });
    await db
      .update(schema.scratchRuns)
      .set({ dialogStatus: "Running" })
      .where(eq(schema.scratchRuns.runId, runId));
    await killAtDialogTransition(runId, [runId, messageId, "100", prompt]);
    const key = `scratch_message:message:${messageId}:100`;
    const [stranded] = await db
      .select()
      .from(schema.executionCommands)
      .where(eq(schema.executionCommands.logicalOperationKey, key));
    const [beforeRecovery] = await db
      .select({ dialogStatus: schema.scratchRuns.dialogStatus })
      .from(schema.scratchRuns)
      .where(eq(schema.scratchRuns.runId, runId));

    expect(stranded?.state).toBe("succeeded");
    expect(stranded.applicationState).not.toBe("applied");
    expect(beforeRecovery.dialogStatus).toBe("Running");
    const worker = startPromptOwnerWorker({
      db: db as unknown as Db,
      owners: scratchPromptOwners,
    });

    try {
      await expect
        .poll(
          async () => {
            const [current] = await db
              .select({ dialogStatus: schema.scratchRuns.dialogStatus })
              .from(schema.scratchRuns)
              .where(eq(schema.scratchRuns.runId, runId));

            return current.dialogStatus;
          },
          { timeout: 60_000, interval: 100 },
        )
        .toBe("WaitingForUser");
    } finally {
      await worker.stop();
    }
    const [applied] = await db
      .select({ applicationState: schema.executionCommands.applicationState })
      .from(schema.executionCommands)
      .where(eq(schema.executionCommands.logicalOperationKey, key));

    expect(applied.applicationState).toBe("applied");
  }, 240_000);
});
