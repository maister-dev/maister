import type { Db } from "@/lib/execution-host/db";
import type { StartedPostgresTestDb } from "@/test-support/pg-container";

import { randomUUID } from "node:crypto";
import { fork, type ChildProcess } from "node:child_process";
import { access, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { z } from "zod";

import * as launch from "@/lib/agents/launch";
import * as worktree from "@/lib/worktree";
import { startAgentContinuationWorker } from "@/lib/agents/continuation-worker";
import { executionCommands, runs, projects } from "@/lib/db/schema";
import { seedAgentRun } from "@/test-support/agent-run-seed";
import { fakeExecutionHosts } from "@/test-support/fake-execution-host";
import { git } from "@/test-support/git-fixture";
import { startMainPostgresTestDb } from "@/test-support/pg-container";
import { mkdtempReal } from "@/test-support/worktree-test-root";
import { agentReadOnlyWorkdirPath } from "@/lib/agents/workspace-paths";
import {
  claimAgentPreparation,
  advanceAgentPreparation,
} from "@/lib/agents/preparation-ownership";
import { acquirePreparationWorkspace } from "@/lib/agents/preparation-workspace";
import {
  agentPreparationOperations,
  executionAssignments,
} from "@/lib/db/schema";
import { mintAssignment } from "@/lib/execution-host/assignments";
import { prepareUndispatchedAgentFailure } from "@/lib/agents/finalization";
import { disposeOperationalRun } from "@/lib/gc/operational-disposition";
import { loadOperationalOutcome } from "@/lib/run-results/operational-projection";
import { admitAgentGenerationTurn } from "@/lib/agents/generation-turn";
import { isMaisterError, MaisterError } from "@/lib/errors";

const probeBarrier = vi.hoisted(() => ({
  target: "",
  entered: (): void => {},
  release: Promise.resolve(),
  used: false,
  skipCalls: 0,
}));

const acquisitionBarrier = vi.hoisted(() => ({
  target: "",
  entered: (): void => {},
  release: Promise.resolve(),
  used: false,
}));

vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();

  return {
    ...actual,
    realpath: async (...args: Parameters<typeof actual.realpath>) => {
      if (
        !acquisitionBarrier.used &&
        String(args[0]) === acquisitionBarrier.target
      ) {
        acquisitionBarrier.used = true;
        acquisitionBarrier.entered();
        await acquisitionBarrier.release;
      }

      return actual.realpath(...args);
    },
    lstat: async (...args: Parameters<typeof actual.lstat>) => {
      if (!probeBarrier.used && String(args[0]) === probeBarrier.target) {
        if (probeBarrier.skipCalls > 0) {
          probeBarrier.skipCalls -= 1;

          return actual.lstat(...args);
        }
        probeBarrier.used = true;
        probeBarrier.entered();
        await probeBarrier.release;
      }

      return actual.lstat(...args);
    },
  };
});

function barrier(): { promise: Promise<void>; release: () => void } {
  let release: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });

  return { promise, release };
}

let database: StartedPostgresTestDb;
let db: Db;
let root: string;
const oldRoot = process.env.MAISTER_WORKTREES_ROOT;
const oldRuntime = process.env.MAISTER_RUNTIME_ROOT;

const preparationProcessMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("probe-paused") }),
  z.object({
    type: z.literal("result"),
    ok: z.boolean(),
    entries: z.number().optional(),
    reason: z.string().optional(),
    diagnostic: z
      .object({
        probeOperation: z.string().optional(),
        causeChain: z.array(
          z.object({ code: z.union([z.string(), z.number()]).optional() }),
        ),
      })
      .optional(),
  }),
]);

function preparationProcess(
  action: "capture" | "owned-remove" | "unfenced-remove",
  input: Readonly<{
    runId: string;
    assignmentId: string;
    repoPath: string;
    cwd: string;
    source: string;
  }>,
): {
  child: ChildProcess;
  close: () => Promise<number | null>;
  wait: (
    type: "probe-paused" | "result",
  ) => Promise<z.infer<typeof preparationProcessMessage>>;
} {
  const child = fork(
    path.resolve("test-support/preparation-owner-process.ts"),
    [action, JSON.stringify(input)],
    {
      execArgv: [
        "--import",
        "tsx",
        "--import",
        path.resolve("scripts/_register-shim.mjs"),
      ],
      env: { ...process.env, DB_URL: database.databaseUrl },
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    },
  );
  const messages: z.infer<typeof preparationProcessMessage>[] = [];
  let stderr = "";

  child.stderr?.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString("utf8")).slice(-4096);
  });
  child.on("message", (message: unknown) => {
    const parsed = preparationProcessMessage.safeParse(message);

    if (parsed.success) messages.push(parsed.data);
  });
  const closed = new Promise<{
    code: number | null;
    failure: Error | null;
  }>((resolve) => {
    let failure: Error | null = null;
    let killDeadline: ReturnType<typeof setTimeout> | undefined;
    const finish = (code: number | null): void => {
      clearTimeout(deadline);
      clearTimeout(killDeadline);
      resolve({ code, failure });
    };
    const deadline = setTimeout(() => {
      failure = new Error("Preparation fixture exceeded its process deadline");
      child.kill("SIGKILL");
      killDeadline = setTimeout(() => finish(null), 3000);
    }, 35_000);

    child.once("close", finish);
    child.once("error", (error: Error) => {
      failure = error;
      child.kill("SIGKILL");
      killDeadline = setTimeout(() => finish(null), 3000);
    });
  });
  const close = async (): Promise<number | null> => {
    const result = await closed;

    if (result.failure) throw result.failure;

    return result.code;
  };
  const wait = async (
    type: "probe-paused" | "result",
  ): Promise<z.infer<typeof preparationProcessMessage>> => {
    const existing = messages.find((message) => message.type === type);

    if (existing) return existing;

    return new Promise((resolve, reject) => {
      const done = (): void => {
        clearTimeout(timeout);
        child.off("message", receive);
        child.off("close", ended);
        child.off("error", failed);
      };
      const receive = (message: unknown): void => {
        const parsed = preparationProcessMessage.safeParse(message);

        if (parsed.success && parsed.data.type === type) {
          done();
          resolve(parsed.data);
        }
      };
      const ended = (): void => {
        done();
        reject(
          new Error(`Preparation fixture ended before ${type}: ${stderr}`),
        );
      };
      const failed = (error: Error): void => {
        done();
        reject(error);
      };
      const timeout = setTimeout(() => {
        done();
        reject(new Error(`Preparation fixture did not reach ${type}`));
      }, 30_000);

      child.on("message", receive);
      child.once("close", ended);
      child.once("error", failed);
      if (child.exitCode !== null || child.signalCode !== null) ended();
    });
  };

  return { child, close, wait };
}

beforeAll(async () => {
  database = await startMainPostgresTestDb({
    databaseName: "preparation_ownership",
  });
  db = database.db;
  root = await mkdtempReal("preparation-ownership-");
  process.env.MAISTER_WORKTREES_ROOT = path.join(root, "worktrees");
  process.env.MAISTER_RUNTIME_ROOT = path.join(root, "manager");
}, 180_000);

afterAll(async () => {
  if (oldRoot === undefined) delete process.env.MAISTER_WORKTREES_ROOT;
  else process.env.MAISTER_WORKTREES_ROOT = oldRoot;
  if (oldRuntime === undefined) delete process.env.MAISTER_RUNTIME_ROOT;
  else process.env.MAISTER_RUNTIME_ROOT = oldRuntime;
  await database?.stop();
  if (root) await rm(root, { recursive: true, force: true });
});

async function seedReadOnlyPreparation(): Promise<{
  runId: string;
  project: typeof projects.$inferSelect;
  checkout: string;
  source: string;
}> {
  const runId = await seedAgentRun(db, {
    runtimeRoot: root,
    definition:
      "---\nname: Qualifier\ndescription: preparation fixture\nkind: operational\ncompletion: {contract: operational_v1}\nworkspace: repo_read\nworkspace_ref: main\nmode: session\nplatform_mcp: false\ntriggers: [manual]\nrisk_tier: read_only\n---\nRead the repository.",
    workspace: "repo_read",
    resultContract: null,
    operational: true,
  });
  const [run] = await db.select().from(runs).where(eq(runs.id, runId));
  const [project] = await db
    .select()
    .from(projects)
    .where(eq(projects.id, run.projectId!));
  const source = `source-${randomUUID()}.txt`;

  await writeFile(path.join(project.repoPath, source), "fixture source\n");
  await git(project.repoPath, "add", source);
  await git(project.repoPath, "commit", "-qm", "source fixture");

  return {
    runId,
    project,
    checkout: agentReadOnlyWorkdirPath(project.slug, runId),
    source,
  };
}

it("TB05 a real preparation probe failure persists its cause and issues no model commands", async () => {
  const { hosts } = await fakeExecutionHosts(db);
  const fixture = await seedReadOnlyPreparation();
  const entered = barrier();
  const release = barrier();

  probeBarrier.target = path.join(fixture.checkout, fixture.source);
  probeBarrier.entered = entered.release;
  probeBarrier.release = release.promise;
  probeBarrier.used = false;
  const driver = launch.startAgentSession(fixture.runId, {
    db,
    executionHosts: hosts,
  });

  try {
    await Promise.race([
      entered.promise,
      driver.then(() => {
        throw new Error("Driver ended before probe");
      }),
    ]);
    await worktree.removeWorktree({
      projectRepoPath: fixture.project.repoPath,
      worktreePath: fixture.checkout,
      force: true,
    });
  } finally {
    release.release();
    await driver;
    probeBarrier.target = "";
  }

  const [run] = await db.select().from(runs).where(eq(runs.id, fixture.runId));
  const commands = await db
    .select({ kind: executionCommands.kind })
    .from(executionCommands)
    .where(eq(executionCommands.runId, fixture.runId));

  expect(run.status).toBe("Failed");
  expect(run.operationalTerminal).toMatchObject({
    infrastructureFailure: {
      runId: fixture.runId,
      stage: "baseline",
      probeOperation: "lstat",
      causeChain: [{ code: "ENOENT", syscall: "lstat" }],
    },
  });
  expect(run.operationalTerminal?.reasonCodes).toContain(
    "operational_integrity_probe_failed",
  );
  expect(
    (await loadOperationalOutcome(db, fixture.runId))?.infrastructureFailure,
  ).toEqual(run.operationalTerminal?.infrastructureFailure);
  expect(
    commands.filter((command) =>
      ["session.create", "session.prompt"].includes(command.kind),
    ),
  ).toEqual([]);
  expect(
    JSON.stringify(run.operationalTerminal?.infrastructureFailure),
  ).not.toContain(root);
}, 60_000);

it("TB05 workspace acquisition failure retains the native cause before model dispatch", async () => {
  const { hosts } = await fakeExecutionHosts(db);
  const fixture = await seedReadOnlyPreparation();
  const [before] = await db
    .select()
    .from(runs)
    .where(eq(runs.id, fixture.runId));
  const [assignment] = await db
    .select()
    .from(executionAssignments)
    .where(eq(executionAssignments.id, before.executionAssignmentId!));

  await rename(fixture.project.repoPath, `${fixture.project.repoPath}-removed`);
  await launch.startAgentSession(fixture.runId, { db, executionHosts: hosts });
  const [run] = await db.select().from(runs).where(eq(runs.id, fixture.runId));
  const commands = await db
    .select({ kind: executionCommands.kind })
    .from(executionCommands)
    .where(eq(executionCommands.runId, fixture.runId));

  expect(run.status).toBe("Failed");
  expect(run.operationalTerminal?.infrastructureFailure).toMatchObject({
    runId: fixture.runId,
    assignmentId: assignment.id,
    assignmentEpoch: assignment.epoch,
    stage: "workspace_acquisition",
    causeChain: [{ code: "ENOENT", syscall: "realpath" }],
  });
  expect(run.operationalTerminal?.reasonCodes).toContain(
    "operational_preparation_failed",
  );
  expect(commands).toEqual([]);
  expect(
    JSON.stringify(run.operationalTerminal?.infrastructureFailure),
  ).not.toContain(root);
}, 60_000);

it("TB05 a stale acquisition failure cannot terminalize the successor assignment", async () => {
  const { hosts } = await fakeExecutionHosts(db);
  const fixture = await seedReadOnlyPreparation();
  const [before] = await db
    .select()
    .from(runs)
    .where(eq(runs.id, fixture.runId));
  const [assignment] = await db
    .select()
    .from(executionAssignments)
    .where(eq(executionAssignments.id, before.executionAssignmentId!));
  const entered = barrier();
  const release = barrier();

  acquisitionBarrier.target = fixture.project.repoPath;
  acquisitionBarrier.entered = entered.release;
  acquisitionBarrier.release = release.promise;
  acquisitionBarrier.used = false;
  const driver = launch
    .startAgentSession(fixture.runId, { db, executionHosts: hosts })
    .then(
      () => ({ reason: null }),
      (error: unknown) => ({
        reason:
          error instanceof Object && "details" in error
            ? (error.details as { reason?: string }).reason
            : "unknown",
      }),
    );
  let successor: typeof assignment;

  try {
    await Promise.race([
      entered.promise,
      driver.then(() => {
        throw new Error("Driver ended before acquisition");
      }),
    ]);
    successor = await db.transaction((tx) =>
      mintAssignment(tx, {
        runId: fixture.runId,
        hostId: assignment.executionHostId,
        reason: "recover",
      }),
    );
    await rename(
      fixture.project.repoPath,
      `${fixture.project.repoPath}-removed`,
    );
  } finally {
    release.release();
    acquisitionBarrier.target = "";
  }
  const outcome = await driver;
  const [run] = await db.select().from(runs).where(eq(runs.id, fixture.runId));
  const [current] = await db
    .select()
    .from(executionAssignments)
    .where(eq(executionAssignments.id, successor.id));
  const commands = await db
    .select({ kind: executionCommands.kind })
    .from(executionCommands)
    .where(eq(executionCommands.runId, fixture.runId));

  expect(outcome.reason).toBe("assignment_fenced");
  expect(run.status).toBe("Running");
  expect(run.executionAssignmentId).toBe(successor.id);
  expect(run.operationalTerminal).toBeNull();
  expect(current.state).toBe("active");
  expect(commands).toEqual([]);
}, 60_000);

it.each([false, true])(
  "TB02 generic pre-dispatch failure retains its assignment fence (superseded=$0)",
  async (superseded) => {
    const { hosts } = await fakeExecutionHosts(db);
    const fixture = await seedReadOnlyPreparation();
    const [before] = await db
      .select()
      .from(runs)
      .where(eq(runs.id, fixture.runId));
    const [assignment] = await db
      .select()
      .from(executionAssignments)
      .where(eq(executionAssignments.id, before.executionAssignmentId!));

    await db.transaction((tx) =>
      admitAgentGenerationTurn(tx, {
        runId: fixture.runId,
        assignmentId: assignment.id,
        variant: "initial",
        prompt: "Read this exact request",
      }),
    );
    const entered = barrier();
    const release = barrier();
    const driver = launch
      .startAgentSession(fixture.runId, {
        db,
        executionHosts: {
          ...hosts,
          executionFor: async () => {
            entered.release();
            await release.promise;
            throw new MaisterError(
              "EXECUTOR_UNAVAILABLE",
              "fixture host unavailable before dispatch",
            );
          },
        },
      })
      .then(
        () => ({ reason: null }),
        (error: unknown) => ({
          reason: isMaisterError(error) ? error.details?.reason : "unknown",
        }),
      );
    let successor = assignment;

    try {
      await Promise.race([
        entered.promise,
        driver.then(() => {
          throw new Error("Driver ended before host resolution");
        }),
      ]);
      if (superseded)
        successor = await db.transaction((tx) =>
          mintAssignment(tx, {
            runId: fixture.runId,
            hostId: assignment.executionHostId,
            reason: "recover",
          }),
        );
    } finally {
      release.release();
    }
    const outcome = await driver;
    const [run] = await db
      .select()
      .from(runs)
      .where(eq(runs.id, fixture.runId));
    const [current] = await db
      .select()
      .from(executionAssignments)
      .where(eq(executionAssignments.id, successor.id));
    const commands = await db
      .select({ kind: executionCommands.kind })
      .from(executionCommands)
      .where(eq(executionCommands.runId, fixture.runId));

    expect(outcome.reason).toBe(superseded ? "assignment_fenced" : null);
    expect(run.status).toBe(superseded ? "Running" : "Failed");
    expect(run.executionAssignmentId).toBe(successor.id);
    expect(current.state).toBe(superseded ? "active" : "released");
    if (superseded) expect(run.operationalTerminal).toBeNull();
    expect(commands).toEqual([]);
  },
  60_000,
);

it.each([
  {
    stage: "baseline",
    skipCalls: 0,
    generation: null,
    phase: "checkout_ready",
  },
  {
    stage: "trusted generation",
    skipCalls: 1,
    generation: 0,
    phase: "baseline_ready",
  },
])(
  "TB02 an expired preparation cannot publish its $stage",
  async ({ skipCalls, generation, phase }) => {
    const { hosts } = await fakeExecutionHosts(db);
    const fixture = await seedReadOnlyPreparation();
    const entered = barrier();
    const release = barrier();

    probeBarrier.target = path.join(fixture.checkout, fixture.source);
    probeBarrier.entered = entered.release;
    probeBarrier.release = release.promise;
    probeBarrier.used = false;
    probeBarrier.skipCalls = skipCalls;
    const driver = launch.startAgentSession(fixture.runId, {
      db,
      executionHosts: hosts,
    });

    try {
      await Promise.race([
        entered.promise,
        driver.then(() => {
          throw new Error("Driver ended before publication probe");
        }),
      ]);
      await db.execute(sql`UPDATE agent_preparation_operations
      SET lease_expires_at=clock_timestamp()+interval '100 milliseconds'
      WHERE run_id=${fixture.runId} AND phase=${phase}`);
      await expect
        .poll(async () => {
          const result = await db.execute<{
            expired: boolean;
          }>(sql`SELECT lease_expires_at <= clock_timestamp() AS expired
        FROM agent_preparation_operations WHERE run_id=${fixture.runId} AND phase=${phase}`);

          return result.rows[0]?.expired;
        })
        .toBe(true);
    } finally {
      release.release();
      await driver;
      probeBarrier.target = "";
      probeBarrier.skipCalls = 0;
    }
    const [run] = await db
      .select()
      .from(runs)
      .where(eq(runs.id, fixture.runId));
    const [operation] = await db
      .select()
      .from(agentPreparationOperations)
      .where(eq(agentPreparationOperations.runId, fixture.runId));
    const commands = await db
      .select({ kind: executionCommands.kind })
      .from(executionCommands)
      .where(eq(executionCommands.runId, fixture.runId));

    expect(run.status).toBe("Running");
    expect(run.operationalIntegrityBaseline?.generation ?? null).toBe(
      generation,
    );
    expect(operation.phase).toBe(phase);
    expect(operation.generation).toBe(generation);
    expect(commands).toEqual([]);
  },
  60_000,
);

it("TB02 a failed ownership receipt rolls back the captured baseline", async () => {
  const { hosts } = await fakeExecutionHosts(db);
  const fixture = await seedReadOnlyPreparation();

  await db.execute(sql`CREATE FUNCTION reject_preparation_publication() RETURNS trigger
    LANGUAGE plpgsql AS $$ BEGIN
      RAISE EXCEPTION 'fixture preparation receipt unavailable' USING ERRCODE='40001';
    END $$`);
  await db.execute(sql`CREATE TRIGGER reject_preparation_publication
    BEFORE UPDATE OF phase ON agent_preparation_operations
    FOR EACH ROW WHEN (NEW.phase='baseline_ready')
    EXECUTE FUNCTION reject_preparation_publication()`);
  try {
    await launch.startAgentSession(fixture.runId, {
      db,
      executionHosts: hosts,
    });
  } finally {
    await db.execute(
      sql`DROP TRIGGER reject_preparation_publication ON agent_preparation_operations`,
    );
    await db.execute(sql`DROP FUNCTION reject_preparation_publication()`);
  }
  const [run] = await db.select().from(runs).where(eq(runs.id, fixture.runId));
  const [operation] = await db
    .select()
    .from(agentPreparationOperations)
    .where(eq(agentPreparationOperations.runId, fixture.runId));
  const commands = await db
    .select({ kind: executionCommands.kind })
    .from(executionCommands)
    .where(eq(executionCommands.runId, fixture.runId));

  expect(run.status).toBe("Failed");
  expect(run.operationalIntegrityBaseline).toBeNull();
  expect(operation.phase).toBe("failed");
  expect(operation.generation).toBeNull();
  expect(
    run.operationalTerminal?.infrastructureFailure?.causeChain,
  ).toContainEqual(expect.objectContaining({ code: "40001" }));
  expect(
    commands.filter((command) =>
      ["session.create", "session.prompt"].includes(command.kind),
    ),
  ).toEqual([]);
}, 60_000);

it("TB02 durable ownership rejects identity forgery and terminal publication", async () => {
  await fakeExecutionHosts(db);
  const fixture = await seedReadOnlyPreparation();
  const [run] = await db.select().from(runs).where(eq(runs.id, fixture.runId));
  const physical = await acquirePreparationWorkspace({
    repoPath: fixture.project.repoPath,
    cwd: fixture.checkout,
    resourceKind: "ephemeral_checkout",
  });

  try {
    const claim = await claimAgentPreparation(db, {
      runId: run.id,
      assignmentId: run.executionAssignmentId!,
      repoPath: fixture.project.repoPath,
      cwd: fixture.checkout,
    });
    const oldWriter = await database.pool.connect();

    try {
      await oldWriter.query("SET maister.agent_preparation_writer=''");
      await expect(
        oldWriter.query(
          "UPDATE agent_preparation_operations SET updated_at=clock_timestamp() WHERE id=$1",
          [claim.operation.id],
        ),
      ).rejects.toMatchObject({
        constraint: "agent_preparation_writer_capability",
      });
    } finally {
      await oldWriter.query("SET maister.agent_preparation_writer='v1'");
      oldWriter.release();
    }
    await expect(
      db
        .insert(agentPreparationOperations)
        .values({ ...claim.operation, id: randomUUID() }),
    ).rejects.toMatchObject({
      cause: { constraint: "agent_preparation_active_resource_uq" },
    });

    await expect(
      db
        .update(agentPreparationOperations)
        .set({ assignmentEpoch: 2 })
        .where(eq(agentPreparationOperations.id, claim.operation.id)),
    ).rejects.toMatchObject({
      cause: { constraint: "agent_preparation_identity_immutable" },
    });
    const terminal = await prepareUndispatchedAgentFailure(run.id, {
      db,
      reason: "fixture_cancel",
    });

    await db.transaction(terminal.apply);
    await expect(
      advanceAgentPreparation(db, claim.operation, { phase: "checkout_ready" }),
    ).rejects.toMatchObject({ details: { reason: "assignment_fenced" } });
    const [closed] = await db
      .select()
      .from(agentPreparationOperations)
      .where(eq(agentPreparationOperations.id, claim.operation.id));

    expect(closed.phase).toBe("cancelled");
    expect(closed.leaseExpiresAt).toBeNull();
    await db.delete(runs).where(eq(runs.id, run.id));
    expect(
      await db
        .select()
        .from(agentPreparationOperations)
        .where(eq(agentPreparationOperations.runId, run.id)),
    ).toEqual([]);
  } finally {
    await physical.release();
  }
}, 60_000);

it("TB02 stale assignment cannot publish and its live physical owner blocks the next epoch", async () => {
  await fakeExecutionHosts(db);
  const fixture = await seedReadOnlyPreparation();
  const [run] = await db.select().from(runs).where(eq(runs.id, fixture.runId));
  const [assignment] = await db
    .select()
    .from(executionAssignments)
    .where(eq(executionAssignments.id, run.executionAssignmentId!));
  const resource = {
    repoPath: fixture.project.repoPath,
    cwd: fixture.checkout,
    resourceKind: "ephemeral_checkout",
  };
  const physical = await acquirePreparationWorkspace(resource);
  const claim = await claimAgentPreparation(db, {
    ...resource,
    runId: run.id,
    assignmentId: assignment.id,
  });

  try {
    const successor = await db.transaction((tx) =>
      mintAssignment(tx, {
        runId: run.id,
        hostId: assignment.executionHostId,
        reason: "recover",
      }),
    );

    expect(successor.epoch).toBe(assignment.epoch + 1);
    await expect(
      advanceAgentPreparation(db, claim.operation, { phase: "checkout_ready" }),
    ).rejects.toMatchObject({ details: { reason: "assignment_fenced" } });
    await expect(acquirePreparationWorkspace(resource)).rejects.toMatchObject({
      details: { reason: "operation_busy" },
    });
  } finally {
    await physical.release();
  }
  const successorPhysical = await acquirePreparationWorkspace(resource);

  try {
    const [current] = await db.select().from(runs).where(eq(runs.id, run.id));
    const recovered = await claimAgentPreparation(db, {
      ...resource,
      runId: run.id,
      assignmentId: current.executionAssignmentId!,
    });

    expect(recovered.operation.id).not.toBe(claim.operation.id);
    expect(recovered.operation.incarnation).toBe(claim.operation.incarnation);
  } finally {
    await successorPhysical.release();
  }
}, 60_000);

it("TB01 initial and actual continuation drivers cannot replace a checkout during baseline capture", async () => {
  const { hosts } = await fakeExecutionHosts(db);
  const { runId, checkout, source } = await seedReadOnlyPreparation();
  const captureEntered = barrier();
  const releaseCapture = barrier();
  const secondRemoved = barrier();
  const releaseSecond = barrier();
  const secondSettled = barrier();
  const remove = worktree.removeWorktree;
  const start = launch.startAgentSession;
  let removals = 0;
  let worker: ReturnType<typeof startAgentContinuationWorker> | undefined;
  let first: Promise<void> | undefined;

  probeBarrier.target = path.join(checkout, source);
  probeBarrier.entered = captureEntered.release;
  probeBarrier.release = releaseCapture.promise;
  probeBarrier.used = false;
  const removeSpy = vi
    .spyOn(worktree, "removeWorktree")
    .mockImplementation(async (args) => {
      await remove(args);
      if (args.worktreePath === checkout && ++removals === 2) {
        secondRemoved.release();
        await releaseSecond.promise;
      }
    });
  const startSpy = vi
    .spyOn(launch, "startAgentSession")
    .mockImplementation(async (id, opts) => {
      try {
        await start(id, opts);
      } finally {
        if (opts?.signal) secondSettled.release();
      }
    });

  try {
    first = launch.startAgentSession(runId, { db, executionHosts: hosts });
    await Promise.race([
      captureEntered.promise,
      first.then(() => {
        throw new Error("Initial driver ended before capture barrier");
      }),
    ]);
    const identity = await stat(probeBarrier.target);

    worker = startAgentContinuationWorker({ db, executionHosts: hosts });
    await Promise.race([secondRemoved.promise, secondSettled.promise]);

    await expect(access(probeBarrier.target)).resolves.toBeUndefined();
    expect((await stat(probeBarrier.target)).ino).toBe(identity.ino);
    expect(removals).toBeLessThan(2);
  } finally {
    releaseCapture.release();
    releaseSecond.release();
    await Promise.allSettled([first]);
    await worker?.stop();
    removeSpy.mockRestore();
    startSpy.mockRestore();
    probeBarrier.target = "";
  }
}, 60_000);

it("TB04 terminal cleanup waits for paused baseline capture and late preparation cannot dispatch or recreate", async () => {
  const { hosts } = await fakeExecutionHosts(db);
  const fixture = await seedReadOnlyPreparation();
  const entered = barrier();
  const release = barrier();

  probeBarrier.target = path.join(fixture.checkout, fixture.source);
  probeBarrier.entered = entered.release;
  probeBarrier.release = release.promise;
  probeBarrier.used = false;
  const driver = launch.startAgentSession(fixture.runId, {
    db,
    executionHosts: hosts,
  });

  try {
    await Promise.race([
      entered.promise,
      driver.then(() => {
        throw new Error("Driver ended before capture");
      }),
    ]);
    const terminal = await prepareUndispatchedAgentFailure(fixture.runId, {
      db,
      reason: "fixture_terminal_race",
    });
    const application = await db.transaction(terminal.apply);

    expect(application.finalized).toBe(true);
    await terminal.afterCommit(application);
    await expect(access(probeBarrier.target)).resolves.toBeUndefined();
    const [run] = await db
      .select()
      .from(runs)
      .where(eq(runs.id, fixture.runId));

    expect(run.operationalCleanup).toMatchObject({
      state: "retry",
      attempts: 0,
      errorCode: "operation_busy",
    });
  } finally {
    release.release();
    await driver;
    probeBarrier.target = "";
  }

  expect(
    await disposeOperationalRun(fixture.runId, {
      db,
      hosts,
      now: new Date(Date.now() + 120_000),
    }),
  ).toBe("released");
  await launch.startAgentSession(fixture.runId, { db, executionHosts: hosts });
  await expect(access(fixture.checkout)).rejects.toMatchObject({
    code: "ENOENT",
  });
  const commands = await db
    .select()
    .from(executionCommands)
    .where(eq(executionCommands.runId, fixture.runId));

  expect(
    commands.filter((command) =>
      ["session.create", "session.prompt"].includes(command.kind),
    ),
  ).toEqual([]);
}, 60_000);

it("TB03 restart redrive reuses the journaled pristine checkout instead of resetting it", async () => {
  const { hosts } = await fakeExecutionHosts(db);
  const fixture = await seedReadOnlyPreparation();
  const [run] = await db.select().from(runs).where(eq(runs.id, fixture.runId));
  const resource = {
    repoPath: fixture.project.repoPath,
    cwd: fixture.checkout,
    resourceKind: "ephemeral_checkout",
  };
  const physical = await acquirePreparationWorkspace(resource);
  const claim = await claimAgentPreparation(db, {
    ...resource,
    runId: run.id,
    assignmentId: run.executionAssignmentId!,
  });
  const commit = (
    await git(fixture.project.repoPath, "rev-parse", "HEAD")
  ).trim();

  try {
    await advanceAgentPreparation(db, claim.operation, {
      phase: "claimed",
      resolvedCommit: commit,
    });
    await physical.run(() =>
      worktree.addDetachedWorktree({
        projectRepoPath: fixture.project.repoPath,
        worktreePath: fixture.checkout,
        committish: commit,
      }),
    );
    await advanceAgentPreparation(db, claim.operation, {
      phase: "checkout_ready",
    });
  } finally {
    await physical.release();
  }
  const identity = await stat(path.join(fixture.checkout, fixture.source));
  const entered = barrier();
  const release = barrier();

  probeBarrier.target = path.join(fixture.checkout, fixture.source);
  probeBarrier.entered = entered.release;
  probeBarrier.release = release.promise;
  probeBarrier.used = false;
  const driver = launch.startAgentSession(run.id, {
    db,
    executionHosts: hosts,
  });

  try {
    await Promise.race([
      entered.promise,
      driver.then(() => {
        throw new Error("Recovery ended before baseline");
      }),
    ]);
    expect((await stat(probeBarrier.target)).ino).toBe(identity.ino);
  } finally {
    release.release();
    await driver;
    probeBarrier.target = "";
  }
  const operations = await db
    .select()
    .from(agentPreparationOperations)
    .where(eq(agentPreparationOperations.runId, run.id));

  expect(operations).toHaveLength(2);
  expect(
    operations.find((operation) => operation.id === claim.operation.id)?.phase,
  ).toBe("fenced");
  expect(
    operations.every(
      (operation) =>
        operation.resolvedCommit === commit &&
        operation.incarnation === claim.operation.incarnation,
    ),
  ).toBe(true);
}, 60_000);

it("TB06 refuses a checkout whose HEAD changes away from the frozen preparation commit", async () => {
  const { hosts } = await fakeExecutionHosts(db);
  const fixture = await seedReadOnlyPreparation();
  const entered = barrier();
  const release = barrier();

  probeBarrier.target = path.join(fixture.checkout, fixture.source);
  probeBarrier.entered = entered.release;
  probeBarrier.release = release.promise;
  probeBarrier.used = false;
  const driver = launch.startAgentSession(fixture.runId, {
    db,
    executionHosts: hosts,
  });

  try {
    await Promise.race([
      entered.promise,
      driver.then(() => {
        throw new Error("Driver ended before probe");
      }),
    ]);
    await git(
      fixture.checkout,
      "commit",
      "--allow-empty",
      "-qm",
      "unexpected checkout revision",
    );
  } finally {
    release.release();
    await driver;
    probeBarrier.target = "";
  }
  const commands = await db
    .select()
    .from(executionCommands)
    .where(eq(executionCommands.runId, fixture.runId));
  const [run] = await db.select().from(runs).where(eq(runs.id, fixture.runId));

  expect(
    commands.filter((command) =>
      ["session.create", "session.prompt"].includes(command.kind),
    ),
  ).toEqual([]);
  expect(run.operationalTerminal?.reasonCodes).toContain(
    "operational_source_revision_changed",
  );
}, 60_000);

it("TB03 real processes preserve an owned slow baseline; disabling the guard reproduces checkout interference", async () => {
  await fakeExecutionHosts(db);

  for (const action of ["owned-remove", "unfenced-remove"] as const) {
    const fixture = await seedReadOnlyPreparation();
    const [run] = await db
      .select()
      .from(runs)
      .where(eq(runs.id, fixture.runId));
    const input = {
      runId: run.id,
      assignmentId: run.executionAssignmentId!,
      repoPath: fixture.project.repoPath,
      cwd: fixture.checkout,
      source: fixture.source,
    };
    const owner = preparationProcess("capture", input);
    const children = [owner];

    try {
      await owner.wait("probe-paused");
      const remover = preparationProcess(action, input);

      children.push(remover);
      const removed = await remover.wait("result");

      expect(await remover.close()).toBe(0);
      if (action === "owned-remove") {
        expect(removed).toMatchObject({ ok: false, reason: "operation_busy" });
        await expect(
          access(path.join(fixture.checkout, fixture.source)),
        ).resolves.toBeUndefined();
      } else {
        expect(removed).toMatchObject({ ok: true });
        await expect(access(fixture.checkout)).rejects.toMatchObject({
          code: "ENOENT",
        });
      }
      owner.child.send({ type: "resume" });
      const captured = await owner.wait("result");

      expect(await owner.close()).toBe(0);
      if (action === "owned-remove") {
        expect(captured).toMatchObject({ ok: true });
        const cleanup = preparationProcess("owned-remove", input);

        children.push(cleanup);
        expect(await cleanup.wait("result")).toMatchObject({ ok: true });
        expect(await cleanup.close()).toBe(0);
      } else {
        expect(captured).toMatchObject({
          ok: false,
          reason: "operational_integrity_probe_failed",
          diagnostic: {
            probeOperation: "lstat",
            causeChain: [{ code: "ENOENT" }],
          },
        });
      }
      const operations = await db
        .select()
        .from(agentPreparationOperations)
        .where(eq(agentPreparationOperations.runId, run.id));

      expect(operations).toHaveLength(1);
      expect(operations[0].phase).toBe("cancelled");
      await expect(access(fixture.checkout)).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      const cleanup = await Promise.allSettled(
        children.map(async (driver) => {
          if (
            driver.child.exitCode === null &&
            driver.child.signalCode === null
          )
            driver.child.kill("SIGKILL");
          await driver.close();
        }),
      );
      const failures = cleanup.flatMap((result) =>
        result.status === "rejected" ? [result.reason as unknown] : [],
      );

      if (failures.length)
        throw new AggregateError(
          failures,
          "Preparation fixture cleanup failed",
        );
    }
  }
}, 120_000);
