import type { Db } from "@/lib/execution-host/db";
import type { RealSupervisor } from "@/test-support/real-supervisor";
import type { ProjectionWorker } from "@/lib/execution-host/events/projection-worker";
import type { FlowYamlV1 } from "@/lib/config.schema";

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fork, type ChildProcess } from "node:child_process";
import path from "node:path";

import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  executionCommands,
  domainEvents,
  executionAssignments,
  gateResults,
  hitlRequests,
  nodeAttempts,
  runSessionIncarnations,
  runSessions,
  runs,
  users,
} from "@/lib/db/schema";
import { loadRun } from "@/lib/flows/graph/runner-core";
import { compileManifest } from "@/lib/flows/graph/compile";
import { buildContext } from "@/lib/flows/context";
import { runNodeGates } from "@/lib/flows/graph/gates-exec";
import { flowPromptOwners } from "@/lib/flows/graph/prompt-owner";
import { assertFlowPermissionDelivery } from "@/lib/flows/graph/prompt-permission";
import { startFlowContinuationWorker } from "@/lib/flows/graph/continuation-worker";
import { startPromptOwnerWorker } from "@/lib/execution-host/prompt-owner-recovery";
import { runFlow } from "@/lib/flows/runner";
import { respondToHitl } from "@/lib/services/hitl";
import { buildOrchestratorResumeConsumer } from "@/lib/domain-events/orchestrator-resume";
import { createExecutionHosts } from "@/lib/execution-host/client";
import {
  readCreateIntent,
  type FlowCreateOwner,
} from "@/lib/execution-host/create-intent";
import { applyCreateAck } from "@/lib/execution-host/create-ack";
import { recoverExecutionCommands } from "@/lib/execution-host/recovery";
import { defaultTransport } from "@/lib/execution-host/default-transport";
import { UNKNOWN_OUTCOME_DETAIL } from "@/lib/execution-host/contracts";
import { MaisterError } from "@/lib/errors";
import { mintAssignment } from "@/lib/execution-host/assignments";
import { canonicalProjectors } from "@/lib/execution-host/events/projection-runtime";
import { startProjectionWorker } from "@/lib/execution-host/events/projection-worker";
import {
  startRuntimeEventConsumer,
  stopRuntimeEventConsumers,
} from "@/lib/execution-host/events/consumer";
import { resetRegistrarStateForTests } from "@/lib/execution-host/registrar";
import { resetResolverForTests } from "@/lib/execution-host/resolver";
import { seedGraphRun } from "@/test-support/graph-run-seed";
import { addWorktree, initRepo } from "@/test-support/git-fixture";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";
import {
  startRealSupervisor,
  useRealSupervisorUrl,
} from "@/test-support/real-supervisor";

let database: StartedPostgresTestDb;
let supervisor: RealSupervisor;
let worker: ProjectionWorker;
let restoreUrl: () => void = () => {};

beforeAll(async () => {
  database = await startMainPostgresTestDb({
    databaseName: "flow_prompt_owners",
  });
  supervisor = await startRealSupervisor({
    fixtureArgs: ["--hang", "--lines", "0", "--supports-resume"],
  });
  restoreUrl = useRealSupervisorUrl(supervisor.url);
  resetRegistrarStateForTests();
  resetResolverForTests();
  worker = startProjectionWorker({
    db: database.db as unknown as Db,
    projectors: canonicalProjectors,
  });
}, 180_000);

afterAll(async () => {
  await stopRuntimeEventConsumers();
  restoreUrl();
  await worker?.stop();
  await supervisor?.kill();
  await database?.stop();
});

async function seedOwnerFlow(
  nodes: FlowYamlV1["nodes"],
  options: { engineMin?: string; installedPath?: string } = {},
) {
  const name = randomUUID();
  const repoPath = await initRepo(`${supervisor.runtimeRoot}/repo-${name}`);
  const worktreePath = await addWorktree(
    repoPath,
    `${supervisor.runtimeRoot}/wt-${name}`,
    `maister/${name}`,
  );

  return seedGraphRun(
    database.db,
    {
      schemaVersion: 1,
      name: "owned-flow",
      compat: { engine_min: options.engineMin ?? "1.1.0" },
      nodes,
    },
    {
      repoPath,
      installedPath: options.installedPath,
      flowRevision: true,
      workspace: {
        worktreePath,
        parentRepoPath: repoPath,
        branch: `maister/${name}`,
      },
    },
  );
}

async function seedGate(kind: "ai_judgment" | "skill_check", prefixBytes = 0) {
  const prompt = `fixture-output:${JSON.stringify({
    bytes: prefixBytes,
    chunkSize: 400_000,
    text: '{"verdict":"pass","confidence":0.95,"reasons":["original verdict"]}',
  })}`;

  return seedOwnerFlow([
    {
      id: "work",
      type: "cli",
      action: { command: "printf 'work\\n' >> gate-parent-count.txt" },
      pre_finish: {
        gates: [
          {
            id: "review",
            kind,
            mode: "blocking",
            ...(kind === "skill_check" ? { command: prompt } : { prompt }),
          },
        ],
      },
      transitions: { success: "done" },
    },
  ]);
}

function startDriver(runId: string) {
  return startFixtureProcess("flow-prompt-owner-process.ts", runId);
}

function startFixtureProcess(
  script: string,
  targetId: string,
  additionalArgs: readonly string[] = [],
): {
  child: ChildProcess;
  exited: Promise<number | null>;
  output: () => string;
} {
  const child = fork(
    path.resolve("test-support", script),
    [targetId, supervisor.runtimeRoot, ...additionalArgs],
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

  return { child, exited, output: () => output };
}

async function killBeforeSecondWorkAttempt(runId: string): Promise<void> {
  await killAtNodeAttemptWrite(
    `NEW.run_id = '${runId}' AND NEW.node_id = 'work' AND NEW.attempt = 2`,
    () => startDriver(runId),
  );
}

async function killAtNodeAttemptWrite(
  predicate: string,
  launch: () => ReturnType<typeof startDriver>,
): Promise<void> {
  await killAtDatabaseWrite({
    table: "node_attempts",
    event: "INSERT OR UPDATE",
    predicate,
    launch,
  });
}

async function killAtDatabaseWrite(input: {
  table: "node_attempts" | "hitl_requests" | "execution_commands";
  event: "INSERT OR UPDATE" | "INSERT" | "UPDATE";
  predicate: string;
  launch: () => ReturnType<typeof startDriver>;
}): Promise<void> {
  const trigger = `attempt_pause_${randomUUID().replaceAll("-", "")}`;
  const lockKey = Math.floor(Math.random() * 2_000_000_000) + 1;
  const lock = await database.pool.connect();
  let driver: ReturnType<typeof startDriver> | undefined;

  try {
    await lock.query("SELECT pg_advisory_lock(260908, $1)", [lockKey]);
    await database.pool.query(
      `CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF ${input.predicate} THEN PERFORM pg_advisory_xact_lock(260908, ${lockKey}); END IF; RETURN NEW; END $$`,
    );
    await database.pool.query(
      `CREATE TRIGGER ${trigger} BEFORE ${input.event} ON ${input.table} FOR EACH ROW EXECUTE FUNCTION ${trigger}()`,
    );
    driver = input.launch();
    await expect
      .poll(
        async () => {
          if (driver?.child.exitCode !== null)
            throw new Error(driver?.output());
          const waiting = await database.pool.query(
            "SELECT count(*)::int AS count FROM pg_locks WHERE locktype = 'advisory' AND classid = 260908 AND objid = $1 AND NOT granted",
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
    await database.pool.query(
      `DROP TRIGGER IF EXISTS ${trigger} ON ${input.table}`,
    );
    await database.pool.query(`DROP FUNCTION IF EXISTS ${trigger}()`);
  }
}

describe("Flow prompt owners through the production graph driver", () => {
  it.each(["node", "ai_judgment", "skill_check"] as const)(
    "owner-flow-admission: %s rolls back an INSERT blocked past the driver lease",
    async (origin) => {
      const seeded =
        origin === "node"
          ? await seedOwnerFlow([
              {
                id: "work",
                type: "ai_coding",
                action: {
                  prompt:
                    'fixture-output:{"bytes":0,"text":"must not dispatch"}',
                },
                transitions: { success: "done" },
              },
            ])
          : await seedGate(origin);
      const trigger = `admission_expiry_${randomUUID().replaceAll("-", "")}`;
      const lockKey = Math.floor(Math.random() * 2_000_000_000) + 1;
      let driver: ReturnType<typeof startDriver> | undefined;
      let continuation:
        | ReturnType<typeof startFlowContinuationWorker>
        | undefined;

      await database.pool.query(
        `CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.run_id = '${seeded.runId}' AND NEW.kind = 'session.prompt' THEN PERFORM pg_advisory_xact_lock(260910, ${lockKey}); PERFORM pg_sleep(greatest(0, extract(epoch from flow_driver_lease_expires_at - clock_timestamp())) + 0.15) FROM runs WHERE id = NEW.run_id; END IF; RETURN NEW; END $$`,
      );
      await database.pool.query(
        `CREATE TRIGGER ${trigger} BEFORE INSERT ON execution_commands FOR EACH ROW EXECUTE FUNCTION ${trigger}()`,
      );
      try {
        driver = startDriver(seeded.runId);
        await expect
          .poll(
            async () => {
              if (driver?.child.exitCode !== null)
                throw new Error(driver?.output());
              const blocked = await database.pool.query(
                "SELECT count(*)::int AS count FROM pg_locks WHERE locktype = 'advisory' AND classid = 260910 AND objid = $1 AND granted",
                [lockKey],
              );

              return blocked.rows[0].count as number;
            },
            { timeout: 30_000, interval: 25 },
          )
          .toBe(1);
        // Suspend renewal without killing the owner. PostgreSQL finishes the
        // blocked INSERT after the real lease expires, before JS can commit.
        driver.child.kill("SIGSTOP");
        await database.pool.query(
          "SELECT pg_sleep(greatest(0, extract(epoch from flow_driver_lease_expires_at - clock_timestamp())) + 0.25) FROM runs WHERE id = $1",
          [seeded.runId],
        );
        driver.child.kill("SIGCONT");
        await expect
          .poll(() => driver?.child.exitCode, { timeout: 20_000 })
          .toBe(0);
        const commands = await database.db
          .select()
          .from(executionCommands)
          .where(
            and(
              eq(executionCommands.runId, seeded.runId),
              eq(executionCommands.kind, "session.prompt"),
            ),
          );

        expect(commands).toHaveLength(0);
        const [run] = await database.db
          .select()
          .from(runs)
          .where(eq(runs.id, seeded.runId));
        const attempts = await database.db
          .select()
          .from(nodeAttempts)
          .where(eq(nodeAttempts.runId, seeded.runId));

        expect(run).toMatchObject({ status: "Running", currentStepId: "work" });
        expect(attempts).toHaveLength(1);
        expect(attempts[0]).toMatchObject({
          status: "Running",
          actionPromptOrdinal: 0,
          finishContinuation: null,
        });
        if (origin === "node") {
          expect(attempts[0].actionCompletion).toBeNull();
        } else {
          const evaluations = await database.db
            .select()
            .from(gateResults)
            .where(eq(gateResults.runId, seeded.runId));

          expect(evaluations).toHaveLength(1);
          expect(evaluations[0].status).toBe("running");
          expect(
            await readFile(
              `${seeded.worktreePath}/gate-parent-count.txt`,
              "utf8",
            ),
          ).toBe("work\n");
        }
        await database.pool.query(
          `DROP TRIGGER ${trigger} ON execution_commands`,
        );
        continuation = startFlowContinuationWorker({
          db: database.db as unknown as Db,
          runtimeRoot: supervisor.runtimeRoot,
        });
        await expect
          .poll(
            async () => {
              const [resumed] = await database.db
                .select({ status: runs.status })
                .from(runs)
                .where(eq(runs.id, seeded.runId));

              return resumed.status;
            },
            { timeout: 45_000 },
          )
          .toBe("Review");
        const accepted = await database.db
          .select()
          .from(executionCommands)
          .where(
            and(
              eq(executionCommands.runId, seeded.runId),
              eq(executionCommands.kind, "session.prompt"),
            ),
          );

        expect(accepted).toHaveLength(1);
        expect(accepted[0]).toMatchObject({
          state: "succeeded",
          applicationState: "applied",
        });
      } finally {
        await continuation?.stop();
        driver?.child.kill("SIGCONT");
        driver?.child.kill("SIGKILL");
        await driver?.exited;
        await database.pool.query(
          `DROP TRIGGER IF EXISTS ${trigger} ON execution_commands`,
        );
        await database.pool.query(`DROP FUNCTION ${trigger}()`);
      }
    },
    130_000,
  );
  it.each(["node", "gate"] as const)(
    "owner-flow-cli: %s loses its assignment and kills its entire process group without closing domain state",
    async (origin) => {
      const command = `trap '' TERM; (trap '' TERM; sleep 300) >/dev/null 2>&1 & printf '%s %s\n' "$$" "$!" > driver-cli-pids.txt; wait`;
      const seeded = await seedOwnerFlow([
        {
          id: "work",
          type: "cli",
          action: { command: origin === "node" ? command : "true" },
          ...(origin === "gate"
            ? {
                pre_finish: {
                  gates: [
                    {
                      id: "check",
                      kind: "command_check" as const,
                      mode: "blocking" as const,
                      command,
                    },
                  ],
                },
              }
            : {}),
          transitions: { success: "after" },
        },
        {
          id: "after",
          type: "ai_coding",
          action: {
            prompt: 'fixture-output:{"bytes":0,"text":"must not run"}',
          },
          transitions: { success: "done" },
        },
      ]);
      const driver = startDriver(seeded.runId);
      let pids: number[] = [];

      try {
        await expect
          .poll(
            async () => {
              try {
                pids = (
                  await readFile(
                    `${seeded.worktreePath}/driver-cli-pids.txt`,
                    "utf8",
                  )
                )
                  .trim()
                  .split(" ")
                  .map(Number);

                return pids.length;
              } catch (error) {
                if ((error as NodeJS.ErrnoException).code === "ENOENT")
                  return 0;
                throw error;
              }
            },
            { timeout: 30_000 },
          )
          .toBe(2);
        expect(pids.every((pid) => Number.isInteger(pid) && pid > 0)).toBe(
          true,
        );
        const [before] = await database.db
          .select()
          .from(nodeAttempts)
          .where(eq(nodeAttempts.runId, seeded.runId));
        const [runBefore] = await database.db
          .select()
          .from(runs)
          .where(eq(runs.id, seeded.runId));

        expect(runBefore.flowDriverToken).not.toBeNull();
        const [assignment] = await database.db
          .select()
          .from(executionAssignments)
          .where(eq(executionAssignments.id, runBefore.executionAssignmentId!));
        const successor = await database.db.transaction((tx) =>
          mintAssignment(tx as unknown as Db, {
            runId: seeded.runId,
            hostId: assignment.executionHostId,
            reason: "recover",
          }),
        );

        await expect
          .poll(() => driver.child.exitCode, { timeout: 20_000 })
          .toBe(0);
        await expect
          .poll(
            () =>
              pids.every((pid) => {
                try {
                  process.kill(pid, 0);

                  return false;
                } catch (error) {
                  if ((error as NodeJS.ErrnoException).code === "ESRCH")
                    return true;
                  throw error;
                }
              }),
            { timeout: 3_000 },
          )
          .toBe(true);
        const [after] = await database.db
          .select()
          .from(nodeAttempts)
          .where(eq(nodeAttempts.id, before.id));
        const [runAfter] = await database.db
          .select()
          .from(runs)
          .where(eq(runs.id, seeded.runId));

        expect(after).toMatchObject({
          status: before.status,
          endedAt: before.endedAt,
          finishContinuation: before.finishContinuation,
          executionAssignmentId: before.executionAssignmentId,
        });
        expect(runAfter).toMatchObject({
          status: "Running",
          executionAssignmentId: successor.id,
        });
        if (origin === "gate") {
          const gates = await database.db
            .select()
            .from(gateResults)
            .where(eq(gateResults.runId, seeded.runId));

          expect(gates).toHaveLength(1);
          expect(gates[0].status).toBe("running");
        }
      } finally {
        if (pids[0]) {
          try {
            process.kill(-pids[0], "SIGKILL");
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
          }
        }
        if (driver.child.exitCode === null && driver.child.signalCode === null)
          driver.child.kill("SIGKILL");
        await driver.exited;
        await database.db
          .update(runs)
          .set({ status: "Failed" })
          .where(eq(runs.id, seeded.runId));
      }
    },
    65_000,
  );

  it.each(["finish", "next_visit"] as const)(
    "owner-flow-ceiling: recovers visit 500 before %s without admitting visit 501",
    async (outcome) => {
      const seeded = await seedOwnerFlow([
        {
          id: "work",
          type: "ai_coding",
          action: { prompt: 'fixture-output:{"bytes":0,"text":"last visit"}' },
          transitions: { success: outcome === "finish" ? "done" : "after" },
        },
        ...(outcome === "next_visit"
          ? [
              {
                id: "after",
                type: "cli" as const,
                action: { command: "touch forbidden-visit.txt" },
                transitions: { success: "done" },
              },
            ]
          : []),
      ]);

      await killAtDatabaseWrite({
        table: "execution_commands",
        event: "UPDATE",
        predicate: `NEW.run_id = '${seeded.runId}' AND NEW.kind = 'session.create' AND NEW.state = 'succeeded'`,
        launch: () => startDriver(seeded.runId),
      });
      // Reconstruct the preceding 499 visits after death, so the fresh driver
      // still starts with its ordinary empty-ledger admission contract.
      await database.db
        .update(nodeAttempts)
        .set({ attempt: 500 })
        .where(eq(nodeAttempts.runId, seeded.runId));
      const historyStart = Date.now() - 600_000;

      await database.db.insert(nodeAttempts).values(
        Array.from({ length: 499 }, (_, index) => ({
          id: randomUUID(),
          runId: seeded.runId,
          nodeId: "work",
          nodeType: "ai_coding" as const,
          attempt: index + 1,
          status: "Succeeded" as const,
          startedAt: new Date(historyStart + index),
          endedAt: new Date(historyStart + index),
        })),
      );
      const [original] = await database.db
        .select()
        .from(nodeAttempts)
        .where(
          and(
            eq(nodeAttempts.runId, seeded.runId),
            eq(nodeAttempts.attempt, 500),
          ),
        );

      expect(original.status).toBe("Running");
      const continuation = startFlowContinuationWorker({
        db: database.db as unknown as Db,
        runtimeRoot: supervisor.runtimeRoot,
      });

      try {
        await expect
          .poll(
            async () => {
              const [run] = await database.db
                .select()
                .from(runs)
                .where(eq(runs.id, seeded.runId));

              return run.status;
            },
            { timeout: 60_000 },
          )
          .not.toBe("Running");
        const [run] = await database.db
          .select()
          .from(runs)
          .where(eq(runs.id, seeded.runId));
        const attempts = await database.db
          .select()
          .from(nodeAttempts)
          .where(eq(nodeAttempts.runId, seeded.runId));
        const commands = await database.db
          .select()
          .from(executionCommands)
          .where(eq(executionCommands.runId, seeded.runId));

        expect(attempts).toHaveLength(500);
        expect(
          attempts.find((attempt) => attempt.id === original.id),
        ).toMatchObject({
          status: "Succeeded",
          actionPromptOrdinal: 0,
          finishContinuation: {
            targetNodeId: outcome === "finish" ? null : "after",
          },
        });
        expect(run.status).toBe(outcome === "finish" ? "Review" : "Failed");
        expect(
          commands.filter((command) => command.kind === "session.create"),
        ).toHaveLength(1);
        const prompts = commands.filter(
          (command) => command.kind === "session.prompt",
        );

        expect(prompts).toHaveLength(1);
        expect(prompts[0].completionAppliedAt).not.toBeNull();
        await expect(
          readFile(`${seeded.worktreePath}/forbidden-visit.txt`),
        ).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        await continuation.stop();
      }
    },
    100_000,
  );

  it.each(["resume", "workspace"] as const)(
    "owner-flow-create: definitive %s refusal persists one replacement",
    async (refusal) => {
      const seeded = await seedOwnerFlow([
        {
          id: "work",
          type: "ai_coding",
          action: {
            prompt: 'fixture-output:{"bytes":0,"text":"fresh session"}',
          },
          transitions: { success: "done" },
        },
      ]);

      await killAtDatabaseWrite({
        table: "execution_commands",
        event: "UPDATE",
        predicate: `NEW.run_id = '${seeded.runId}' AND NEW.kind = 'session.create' AND NEW.attempts = 1`,
        launch: () => startDriver(seeded.runId),
      });
      const db = database.db as unknown as Db;
      const [attempt] = await db
        .select()
        .from(nodeAttempts)
        .where(eq(nodeAttempts.runId, seeded.runId));
      const client = await createExecutionHosts({ db }).forAssignment({
        id: attempt.executionAssignmentId!,
      });
      const [unissued] = await db
        .select()
        .from(executionCommands)
        .where(
          and(
            eq(executionCommands.runId, seeded.runId),
            eq(executionCommands.kind, "session.create"),
          ),
        );
      const request = readCreateIntent(unissued, client.host.hostKey);

      // Keep the original unsent generation as evidence; this fixture admits a
      // separate turn to exercise the real adapter's definitive resume refusal.
      await db
        .update(nodeAttempts)
        .set({ actionPromptOrdinal: 1 })
        .where(eq(nodeAttempts.id, attempt.id));
      const owner = {
        variant: "node",
        nodeAttemptId: attempt.id,
        promptOrdinal: 1,
      } as const;

      if (refusal === "workspace")
        await client.releaseWorkspace(
          request.envelope.payload.executionWorkspaceId,
        );
      let prepared = 0;
      const result = await client.createOwnedSession(owner, async () => {
        prepared += 1;

        return {
          ...request.envelope.payload,
          ...(refusal === "resume"
            ? { resumeSessionId: "fixture-missing-session" }
            : {}),
        };
      });

      try {
        expect(result.sessionFallback).toBe(refusal === "resume");
        expect(prepared).toBe(1);
        const replay = await client.createOwnedSession(owner, async () => {
          throw new Error("replay must not rebuild the create request");
        });

        expect(replay).toEqual(result);
        const creates = await db
          .select()
          .from(executionCommands)
          .where(
            and(
              eq(executionCommands.runId, seeded.runId),
              eq(executionCommands.kind, "session.create"),
            ),
          );

        expect(creates).toHaveLength(3);
        expect(
          creates.find((command) => command.id === unissued.id)?.state,
        ).toBe(unissued.state);
        const failed = creates.find((command) => command.state === "failed")!;
        const succeeded = creates.find(
          (command) => command.state === "succeeded",
        )!;

        expect(failed.lastError?.code).toBe(
          refusal === "resume" ? "CHECKPOINT" : "PRECONDITION",
        );
        expect(succeeded.createIntent).toMatchObject({
          generation: 1,
          supersedesCommandId: failed.id,
          sessionFallback: refusal === "resume",
        });
        expect(
          readCreateIntent(succeeded, client.host.hostKey).envelope.payload
            .resumeSessionId,
        ).toBeUndefined();
      } finally {
        await client.deleteSession(result.sessionId);
        await db
          .update(runs)
          .set({ status: "Failed" })
          .where(eq(runs.id, seeded.runId));
      }
    },
    50_000,
  );

  it.each([
    ["node", "before_admission"],
    ["node", "before_effect"],
    ["node", "before_ack"],
    ["gate", "before_effect"],
    ["gate", "before_ack"],
    ["gate", "before_admission"],
  ] as const)(
    "owner-flow-create: %s %s recovers the original create before prompt admission",
    async (origin, window) => {
      const seeded =
        origin === "gate"
          ? await seedGate("ai_judgment")
          : await seedOwnerFlow([
              {
                id: "work",
                type: "ai_coding",
                action: {
                  prompt: 'fixture-output:{"bytes":0,"text":"original action"}',
                },
                transitions: { success: "done" },
              },
            ]);

      await killAtDatabaseWrite({
        table: "execution_commands",
        event: window === "before_admission" ? "INSERT" : "UPDATE",
        predicate: `NEW.run_id = '${seeded.runId}' AND NEW.kind = 'session.create' AND ${window === "before_admission" ? "TRUE" : window === "before_effect" ? "NEW.attempts = 1" : "NEW.state = 'succeeded'"}`,
        launch: () => startDriver(seeded.runId),
      });
      const [original] = await database.db
        .select()
        .from(executionCommands)
        .where(
          and(
            eq(executionCommands.runId, seeded.runId),
            eq(executionCommands.kind, "session.create"),
          ),
        );

      if (window === "before_admission") expect(original).toBeUndefined();
      else expect(original).toBeDefined();
      if (window === "before_effect") {
        const recovered = await recoverExecutionCommands({
          db: database.db as unknown as Db,
          graceMs: 0,
        });

        expect(recovered.errors).toEqual([]);
        const [retained] = await database.db
          .select()
          .from(executionCommands)
          .where(eq(executionCommands.id, original.id));

        expect(retained).toMatchObject({
          id: original.id,
          state: original.state,
          attempts: original.attempts,
          createdAt: original.createdAt,
          createIntent: original.createIntent,
        });
      }
      const continuation = startFlowContinuationWorker({
        db: database.db as unknown as Db,
        runtimeRoot: supervisor.runtimeRoot,
      });

      try {
        await expect
          .poll(
            async () => {
              const [run] = await database.db
                .select()
                .from(runs)
                .where(eq(runs.id, seeded.runId));

              return run.status;
            },
            { timeout: 60_000 },
          )
          .toBe("Review");
        const commands = await database.db
          .select()
          .from(executionCommands)
          .where(eq(executionCommands.runId, seeded.runId));
        const creates = commands.filter(
          (command) => command.kind === "session.create",
        );

        expect(creates).toHaveLength(1);
        expect(creates[0].state).toBe("succeeded");
        if (original)
          expect(creates[0]).toMatchObject({
            id: original.id,
            createdAt: original.createdAt,
          });
        const prompts = commands.filter(
          (command) => command.kind === "session.prompt",
        );

        expect(prompts).toHaveLength(1);
        expect(prompts[0].targetSessionId).toBe(creates[0].result?.sessionId);
        expect(prompts[0].completionAppliedAt).not.toBeNull();
        const attempts = await database.db
          .select()
          .from(nodeAttempts)
          .where(eq(nodeAttempts.runId, seeded.runId));

        expect(attempts).toHaveLength(1);
        expect(attempts[0]).toMatchObject({
          status: "Succeeded",
          actionPromptOrdinal: 0,
        });
        if (origin === "gate") {
          const gates = await database.db
            .select()
            .from(gateResults)
            .where(eq(gateResults.runId, seeded.runId));

          expect(gates).toHaveLength(1);
          expect(gates[0].status).toBe("passed");
          expect(
            await readFile(
              `${seeded.worktreePath}/gate-parent-count.txt`,
              "utf8",
            ),
          ).toBe("work\n");
        }
      } finally {
        await continuation.stop();
      }
    },
    100_000,
  );

  it.each(["node", "gate"] as const)(
    "owner-flow-create: %s rejects late create evidence after its owner generation changes",
    async (origin) => {
      const seeded =
        origin === "gate"
          ? await seedGate("ai_judgment")
          : await seedOwnerFlow([
              {
                id: "work",
                type: "ai_coding",
                action: {
                  prompt: 'fixture-output:{"bytes":0,"text":"current action"}',
                },
                transitions: { success: "done" },
              },
            ]);

      await killAtDatabaseWrite({
        table: "execution_commands",
        event: "UPDATE",
        predicate: `NEW.run_id = '${seeded.runId}' AND NEW.kind = 'session.create' AND NEW.attempts = 1`,
        launch: () => startDriver(seeded.runId),
      });
      const db = database.db as unknown as Db;
      const [original] = await db
        .select()
        .from(executionCommands)
        .where(
          and(
            eq(executionCommands.runId, seeded.runId),
            eq(executionCommands.kind, "session.create"),
          ),
        );
      const client = await createExecutionHosts({ db }).forAssignment({
        id: original.executionAssignmentId,
      });
      const request = readCreateIntent(original, client.host.hostKey);
      const oldOwner = request.intent.owner;

      if (oldOwner.variant === "agent")
        throw new Error("expected a Flow create owner");
      let nextOwner: FlowCreateOwner;

      if (oldOwner.variant === "node") {
        nextOwner = { ...oldOwner, promptOrdinal: oldOwner.promptOrdinal + 1 };
        await db
          .update(nodeAttempts)
          .set({ actionPromptOrdinal: nextOwner.promptOrdinal })
          .where(eq(nodeAttempts.id, oldOwner.nodeAttemptId));
      } else {
        const [oldGate] = await db
          .select()
          .from(gateResults)
          .where(eq(gateResults.id, oldOwner.evaluationId));

        await db
          .update(gateResults)
          .set({ status: "stale" })
          .where(eq(gateResults.id, oldGate.id));
        const id = randomUUID();

        await db
          .insert(gateResults)
          .values({ ...oldGate, id, createdAt: new Date() });
        nextOwner = { ...oldOwner, evaluationId: id };
      }
      const successor = await client.createOwnedSession(
        nextOwner,
        async () => request.envelope.payload,
      );
      const oldResult = await defaultTransport().createSession(
        request.envelope,
      );

      try {
        await expect
          .poll(
            async () => {
              const [incarnation] = await db
                .select()
                .from(runSessionIncarnations)
                .where(
                  eq(runSessionIncarnations.hostSessionId, oldResult.sessionId),
                );

              return incarnation?.state;
            },
            { timeout: 45_000 },
          )
          .toBe("lost");
        const disposition = await db.transaction((tx) =>
          applyCreateAck(tx, {
            commandId: original.id,
            runId: seeded.runId,
            assignmentId: original.executionAssignmentId,
            nodeAttemptId: oldOwner.nodeAttemptId,
            sessionName: request.envelope.payload.sessionName ?? "default",
            result: oldResult,
          }),
        );

        expect(disposition).toBe("stale");
        const recovery = await recoverExecutionCommands({ db, graceMs: 0 });

        expect(recovery.errors).toEqual([]);
        const [settled] = await db
          .select()
          .from(executionCommands)
          .where(eq(executionCommands.id, original.id));

        expect(settled).toMatchObject({
          state: "succeeded",
          result: oldResult,
        });
        const [binding] = await db
          .select()
          .from(runSessions)
          .where(eq(runSessions.runId, seeded.runId));

        expect(binding).toMatchObject({
          hostSessionId: successor.sessionId,
          acpSessionId: successor.acpSessionId,
        });
      } finally {
        await client.deleteSession(oldResult.sessionId);
        await client.deleteSession(successor.sessionId);
        await db
          .update(runs)
          .set({ status: "Failed" })
          .where(eq(runs.id, seeded.runId));
      }
    },
    65_000,
  );

  it("owner-flow-create: unknown outcomes beyond the delivery budget keep one create", async () => {
    const seeded = await seedOwnerFlow([
      {
        id: "work",
        type: "ai_coding",
        action: {
          prompt:
            'fixture-output:{"bytes":0,"text":"survived lost create replies"}',
        },
        transitions: { success: "done" },
      },
    ]);
    const real = defaultTransport();
    const sent: string[] = [];
    const hosts = createExecutionHosts({
      db: database.db as unknown as Db,
      transport: {
        ...real,
        createSession: async (envelope, options) => {
          sent.push(JSON.stringify(envelope));
          const result = await real.createSession(envelope, options);

          if (sent.length <= 4)
            throw new MaisterError(
              "EXECUTOR_UNAVAILABLE",
              "injected loss after real create receipt",
              { details: { transport: UNKNOWN_OUTCOME_DETAIL } },
            );

          return result;
        },
      },
    });

    await runFlow(seeded.runId, {
      db: database.db,
      runtimeRoot: supervisor.runtimeRoot,
      executionHosts: hosts,
    });
    const [run] = await database.db
      .select()
      .from(runs)
      .where(eq(runs.id, seeded.runId));

    expect(run.status).toBe("Running");
    const continuation = startFlowContinuationWorker({
      db: database.db as unknown as Db,
      runtimeRoot: supervisor.runtimeRoot,
      executionHosts: hosts,
    });

    try {
      await expect
        .poll(
          async () => {
            const [current] = await database.db
              .select()
              .from(runs)
              .where(eq(runs.id, seeded.runId));

            return current.status;
          },
          { timeout: 60_000 },
        )
        .toBe("Review");
      const commands = await database.db
        .select()
        .from(executionCommands)
        .where(eq(executionCommands.runId, seeded.runId));
      const creates = commands.filter(
        (command) => command.kind === "session.create",
      );

      expect(creates).toHaveLength(1);
      expect(creates[0]).toMatchObject({
        state: "succeeded",
        attempts: 5,
        maxAttempts: 3,
      });
      expect(new Set(sent).size).toBe(1);
      expect(
        commands.filter((command) => command.kind === "session.prompt"),
      ).toHaveLength(1);
    } finally {
      await continuation.stop();
    }
  }, 80_000);

  it.each([
    ...(
      [
        "before_hitl",
        "after_hitl",
        "before_delivery",
        "before_delivery_ack",
        "delivery_refused",
        "persistence_failure",
        "lost_response",
        "concurrent_response",
      ] as const
    ).map((window) => ({ ownerKind: "node" as const, window })),
    ...(["ai_judgment", "skill_check"] as const).flatMap((ownerKind) =>
      (
        [
          "before_hitl",
          "after_hitl",
          "before_delivery_ack",
          "lost_response",
        ] as const
      ).map((window) => ({ ownerKind, window })),
    ),
  ])(
    "owner-flow-permission-live: $ownerKind $window retains the original turn and permission",
    async ({ ownerKind, window }) => {
      const gatePermissionPrompt = `fixture-output:${JSON.stringify({
        bytes: 0,
        permission: true,
        text: '{"verdict":"pass","confidence":0.95,"reasons":["permission recovered"]}',
      })}`;
      const seeded =
        ownerKind === "node"
          ? await seedOwnerFlow([
              {
                id: "work",
                type: "ai_coding",
                action: {
                  prompt:
                    'fixture-output:{"bytes":0,"permission":true,"text":"permission recovered"}',
                },
                transitions: { success: "done" },
              },
            ])
          : await seedOwnerFlow([
              {
                id: "work",
                type: "cli",
                action: {
                  command: "printf 'work\\n' >> gate-permission-parent.txt",
                },
                pre_finish: {
                  gates: [
                    {
                      id: "review",
                      kind: ownerKind,
                      mode: "blocking",
                      ...(ownerKind === "skill_check"
                        ? { command: gatePermissionPrompt }
                        : { prompt: gatePermissionPrompt }),
                    },
                  ],
                },
                transitions: { success: "done" },
              },
            ]);
      const userId = randomUUID();

      await database.db
        .insert(users)
        .values({ id: userId, email: `${userId}@example.test`, role: "admin" });
      if (window === "persistence_failure") {
        const trigger = `permission_failure_${randomUUID().replaceAll("-", "")}`;

        await database.pool.query(
          `CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.run_id = '${seeded.runId}' THEN RAISE EXCEPTION 'permission persistence fixture failure'; END IF; RETURN NEW; END $$`,
        );
        await database.pool.query(
          `CREATE TRIGGER ${trigger} BEFORE INSERT ON hitl_requests FOR EACH ROW EXECUTE FUNCTION ${trigger}()`,
        );
        const driver = startDriver(seeded.runId);

        try {
          await expect(driver.exited).resolves.toBe(0);
          const [run] = await database.db
            .select()
            .from(runs)
            .where(eq(runs.id, seeded.runId));

          expect(run.status).toBe("Running");
        } finally {
          driver.child.kill("SIGKILL");
          await driver.exited;
          await database.pool.query(`DROP TRIGGER ${trigger} ON hitl_requests`);
          await database.pool.query(`DROP FUNCTION ${trigger}()`);
        }
      } else if (window === "before_hitl") {
        await killAtDatabaseWrite({
          table: "hitl_requests",
          event: "INSERT",
          predicate: `NEW.run_id = '${seeded.runId}'`,
          launch: () => startDriver(seeded.runId),
        });
      } else {
        const driver = startDriver(seeded.runId);

        try {
          await expect
            .poll(
              async () => {
                const [run] = await database.db
                  .select()
                  .from(runs)
                  .where(eq(runs.id, seeded.runId));

                return run?.status;
              },
              { timeout: 20_000 },
            )
            .toBe("NeedsInput");
        } finally {
          driver.child.kill("SIGKILL");
          await driver.exited;
        }
      }
      const [original] = await database.db
        .select()
        .from(executionCommands)
        .where(
          and(
            eq(executionCommands.runId, seeded.runId),
            eq(executionCommands.kind, "session.prompt"),
          ),
        );

      if (window === "before_delivery" || window === "before_delivery_ack") {
        const [hitl] = await database.db
          .select()
          .from(hitlRequests)
          .where(eq(hitlRequests.runId, seeded.runId));

        await killAtDatabaseWrite({
          table: "execution_commands",
          event: "UPDATE",
          predicate: `NEW.run_id = '${seeded.runId}' AND NEW.kind = 'session.input' AND ${window === "before_delivery" ? "NEW.attempts = 1" : "NEW.state = 'succeeded'"}`,
          launch: () =>
            startFixtureProcess(
              "flow-permission-response-process.ts",
              hitl.id,
              [userId],
            ),
        });
      }
      if (window === "before_delivery_ack") {
        // Recover canonical evidence independently of the killed graph driver.
        // Its old event-stream claim must expire before the new reader takes over.
        startRuntimeEventConsumer({
          db: database.db as unknown as Db,
          executionHostId: original.executionHostId,
          transport: defaultTransport(),
        });
        // Apply the action/verdict before input ACK without advancing the graph.
        const application = startPromptOwnerWorker({
          db: database.db as unknown as Db,
          owners: flowPromptOwners,
        });

        try {
          await expect
            .poll(
              async () => {
                const [command] = await database.db
                  .select()
                  .from(executionCommands)
                  .where(eq(executionCommands.id, original.id));

                return command.applicationState;
              },
              { timeout: 45_000 },
            )
            .toBe("applied");
          const [waitingRun] = await database.db
            .select()
            .from(runs)
            .where(eq(runs.id, seeded.runId));
          const [waitingHitl] = await database.db
            .select()
            .from(hitlRequests)
            .where(eq(hitlRequests.runId, seeded.runId));

          expect(waitingRun.status).toBe("NeedsInput");
          expect(waitingHitl.respondedAt).toBeNull();
          if (ownerKind !== "node") {
            const [appliedGate] = await database.db
              .select()
              .from(gateResults)
              .where(eq(gateResults.runId, seeded.runId));

            expect(appliedGate.status).toBe("passed");
          } else {
            const [appliedNode] = await database.db
              .select()
              .from(nodeAttempts)
              .where(eq(nodeAttempts.runId, seeded.runId));

            expect(appliedNode.actionCompletion?.commandId).toBe(original.id);
          }
        } finally {
          await application.stop();
        }
      }
      const continuation = startFlowContinuationWorker({
        db: database.db as unknown as Db,
        runtimeRoot: supervisor.runtimeRoot,
      });

      try {
        await expect
          .poll(
            async () => {
              const [hitl] = await database.db
                .select()
                .from(hitlRequests)
                .where(eq(hitlRequests.runId, seeded.runId));

              return hitl?.schema;
            },
            { timeout: 55_000 },
          )
          .toMatchObject({
            flowPrompt: {
              version: 1,
              commandId: original.id,
              nodeAttemptId: (original.ownerRef as { nodeAttemptId: string })
                .nodeAttemptId,
              ...(ownerKind === "node"
                ? { promptOrdinal: 0 }
                : {
                    variant:
                      ownerKind === "skill_check" ? "gate_skill" : "gate_ai",
                    promptOrdinal: 0,
                    gateId: "review",
                    evaluationId: (
                      original.ownerRef as { evaluationId: string }
                    ).evaluationId,
                  }),
              assignmentId: original.executionAssignmentId,
              incarnationId: (original.ownerRef as { incarnationId: string })
                .incarnationId,
            },
          });
        const [hitl] = await database.db
          .select()
          .from(hitlRequests)
          .where(eq(hitlRequests.runId, seeded.runId));
        const permissionSchema = hitl.schema as {
          flowPrompt: Record<string, unknown>;
        };

        if (ownerKind === "ai_judgment" && window === "before_hitl") {
          const [evaluation] = await database.db
            .select()
            .from(gateResults)
            .where(eq(gateResults.runId, seeded.runId));
          const rollback = new Error("rollback the later-evaluation fixture");

          await expect(
            database.db.transaction(async (tx) => {
              await tx.insert(gateResults).values({
                ...evaluation,
                id: randomUUID(),
                createdAt: new Date(evaluation.createdAt.getTime() + 1),
              });
              await expect(
                assertFlowPermissionDelivery(
                  tx as unknown as Db,
                  permissionSchema,
                ),
              ).rejects.toMatchObject({
                code: "CONFLICT",
                details: {
                  reason: "prompt_owner_invariant",
                  causeCode: "permission_evaluation_generation",
                },
              });
              throw rollback;
            }),
          ).rejects.toBe(rollback);
        }
        for (const changed of [
          ...(ownerKind === "node"
            ? [{ promptOrdinal: 1 }]
            : [
                { evaluationId: randomUUID() },
                { gateId: "another-gate" },
                {
                  variant:
                    ownerKind === "skill_check" ? "gate_ai" : "gate_skill",
                },
              ]),
          { nodeAttemptId: randomUUID() },
          { incarnationId: randomUUID() },
          { assignmentId: randomUUID() },
        ]) {
          await expect(
            database.db.transaction((tx) =>
              assertFlowPermissionDelivery(tx as unknown as Db, {
                ...permissionSchema,
                flowPrompt: { ...permissionSchema.flowPrompt, ...changed },
              }),
            ),
          ).rejects.toMatchObject({ code: "CONFLICT" });
        }
        if (window === "delivery_refused") {
          const transport = defaultTransport();
          const refused = await respondToHitl(
            {
              runId: seeded.runId,
              hitlRequestId: hitl.id,
              body: { optionId: "allow" },
            },
            {
              kind: "user",
              userId,
              label: "Permission qualification",
              preauthorizedProjectId: seeded.projectId,
            },
            {
              db: database.db,
              executionHosts: createExecutionHosts({
                db: database.db as unknown as Db,
                transport: {
                  ...transport,
                  deliverInput: async () => {
                    throw new MaisterError(
                      "EXECUTOR_UNAVAILABLE",
                      "qualification refusal before input dispatch",
                      { details: { httpStatus: 503 } },
                    );
                  },
                },
              }),
            },
          );

          expect(refused.status).toBe(503);
        }
        if (window !== "before_delivery" && window !== "before_delivery_ack") {
          const transport = defaultTransport();
          let responseLost = false;
          const responseHosts = createExecutionHosts({
            db: database.db as unknown as Db,
            ...(window === "lost_response"
              ? {
                  transport: {
                    ...transport,
                    deliverInput: async (
                      ...args: Parameters<typeof transport.deliverInput>
                    ) => {
                      const result = await transport.deliverInput(...args);

                      if (!responseLost) {
                        responseLost = true;
                        throw new MaisterError(
                          "EXECUTOR_UNAVAILABLE",
                          "qualification lost input response",
                          { details: { transport: UNKNOWN_OUTCOME_DETAIL } },
                        );
                      }

                      return result;
                    },
                  },
                }
              : {}),
          });
          const respond = () =>
            respondToHitl(
              {
                runId: seeded.runId,
                hitlRequestId: hitl.id,
                body: { optionId: "allow" },
              },
              {
                kind: "user",
                userId,
                label: "Permission qualification",
                preauthorizedProjectId: seeded.projectId,
              },
              {
                db: database.db,
                executionHosts: responseHosts,
              },
            );

          if (window === "concurrent_response") {
            const replies = await Promise.allSettled([respond(), respond()]);

            expect(
              replies.some(
                (reply) =>
                  reply.status === "fulfilled" && reply.value.status === 200,
              ),
            ).toBe(true);
            for (const reply of replies) {
              if (reply.status === "fulfilled")
                expect([200, 202]).toContain(reply.value.status);
              else expect(reply.reason).toMatchObject({ code: "CONFLICT" });
            }
          }
          const response = await respond();

          expect(response.status).toBe(200);
        }
        await expect
          .poll(
            async () => {
              const [run] = await database.db
                .select()
                .from(runs)
                .where(eq(runs.id, seeded.runId));

              return run?.status;
            },
            { timeout: 55_000 },
          )
          .toBe("Review");
        const prompts = await database.db
          .select()
          .from(executionCommands)
          .where(
            and(
              eq(executionCommands.runId, seeded.runId),
              eq(executionCommands.kind, "session.prompt"),
            ),
          );

        expect(prompts).toHaveLength(1);
        expect(prompts[0]).toMatchObject({
          id: original.id,
          applicationState: "applied",
        });
        const attempts = await database.db
          .select()
          .from(nodeAttempts)
          .where(eq(nodeAttempts.runId, seeded.runId));

        expect(attempts).toHaveLength(1);
        expect(attempts[0]).toMatchObject({
          status: "Succeeded",
          actionPromptOrdinal: 0,
          actionResume: null,
        });
        if (ownerKind !== "node") {
          const evaluations = await database.db
            .select()
            .from(gateResults)
            .where(eq(gateResults.runId, seeded.runId));

          expect(evaluations).toHaveLength(1);
          expect(evaluations[0]).toMatchObject({
            id: (original.ownerRef as { evaluationId: string }).evaluationId,
            status: "passed",
          });
          expect(
            await readFile(
              `${seeded.worktreePath}/gate-permission-parent.txt`,
              "utf8",
            ),
          ).toBe("work\n");
        }
        const hitls = await database.db
          .select()
          .from(hitlRequests)
          .where(eq(hitlRequests.runId, seeded.runId));

        expect(hitls).toHaveLength(1);
        expect(hitls[0].respondedAt).toBeInstanceOf(Date);
        const inputs = await database.db
          .select()
          .from(executionCommands)
          .where(
            and(
              eq(executionCommands.runId, seeded.runId),
              eq(executionCommands.kind, "session.input"),
            ),
          );

        expect(inputs).toHaveLength(window === "delivery_refused" ? 2 : 1);
        const deliveredInput = inputs.find(
          (command) => command.state === "succeeded",
        )!;

        expect(deliveredInput).toBeDefined();
        if (window === "delivery_refused")
          expect(
            inputs.filter((command) => command.state === "failed"),
          ).toHaveLength(1);
        expect(hitls[0].response).toMatchObject({
          optionId: "allow",
          _delivery: {
            commandId: deliveredInput.id,
            hostSessionId: original.targetSessionId,
            payload: {
              kind: "permission",
              action: "select",
              optionId: "allow",
            },
          },
          _audit: {
            deliveryCommandId: deliveredInput.id,
            sourceCommandId: original.id,
            assignmentId: original.executionAssignmentId,
            incarnationId: (original.ownerRef as { incarnationId: string })
              .incarnationId,
          },
        });
      } finally {
        await continuation.stop();
      }
    },
    140_000,
  );

  it("owner-flow-rework: SIGKILL retains the selected target, comments and attempt budget", async () => {
    const seeded = await seedOwnerFlow(
      [
        {
          id: "work",
          type: "ai_coding",
          action: {
            prompt:
              'fixture-output:{"bytes":0,"text":"work result"}\nfeedback={{ verdict }}',
          },
          transitions: { success: "review" },
        },
        {
          id: "review",
          type: "judge",
          action: {
            prompt: `fixture-output:${JSON.stringify({ bytes: 0, text: '\n```json maister:output\n{"verdict":"rework","score":0.95}\n```' })}`,
          },
          output: {
            result: { schema: "./schemas/result.json", required: true },
          },
          decide: { from: "output.verdict" },
          transitions: { rework: "work", exhausted: "done" },
          rework: {
            allowedTargets: ["work"],
            workspacePolicies: ["keep"],
            maxLoops: 1,
            onExhaustion: "exhausted",
            commentsVar: "verdict",
            session_policy: "new_session",
          },
        },
      ],
      {
        engineMin: "2.1.0",
        installedPath: path.resolve(
          "lib/flows/graph/__tests__/_fixtures/m26-output-flow",
        ),
      },
    );
    let continuation:
      | ReturnType<typeof startFlowContinuationWorker>
      | undefined;

    try {
      await killBeforeSecondWorkAttempt(seeded.runId);
      continuation = startFlowContinuationWorker({
        db: database.db as unknown as Db,
        runtimeRoot: supervisor.runtimeRoot,
      });
      await expect
        .poll(
          async () => {
            const [run] = await database.db
              .select()
              .from(runs)
              .where(eq(runs.id, seeded.runId));

            return run.status;
          },
          { timeout: 60_000 },
        )
        .toBe("Review");
      const attempts = await database.db
        .select()
        .from(nodeAttempts)
        .where(eq(nodeAttempts.runId, seeded.runId));
      const work = attempts.filter((attempt) => attempt.nodeId === "work");
      const review = attempts.filter((attempt) => attempt.nodeId === "review");
      const prompts = await database.db
        .select()
        .from(executionCommands)
        .where(
          and(
            eq(executionCommands.runId, seeded.runId),
            eq(executionCommands.kind, "session.prompt"),
          ),
        );

      expect(work).toHaveLength(2);
      expect(review).toHaveLength(2);
      expect(prompts).toHaveLength(4);
      const reworkAttempt = work.find((attempt) => attempt.attempt === 2);

      expect(reworkAttempt).toMatchObject({
        status: "Succeeded",
        sessionPolicy: "new_session",
      });
      expect(
        prompts.find(
          (command) =>
            command.ownerRef &&
            "nodeAttemptId" in command.ownerRef &&
            command.ownerRef.nodeAttemptId === reworkAttempt?.id,
        )?.requestCanonicalJson,
      ).toContain("feedback=rework");
    } finally {
      await continuation?.stop();
    }
  }, 110_000);
  it.each(["live", "after_claim", "capacity"] as const)(
    "owner-flow-orchestrator-wait: child wake preserves one authorized turn (%s)",
    async (window) => {
      const parent = await seedOwnerFlow(
        [
          {
            id: "coordinate",
            type: "orchestrator",
            action: {
              prompt: 'fixture-output:{"bytes":0,"text":"coordinator turn"}',
            },
            transitions: { success: "done" },
          },
        ],
        { engineMin: "1.6.0" },
      );
      const child = await seedOwnerFlow([
        {
          id: "child",
          type: "cli",
          action: { command: "true" },
          transitions: { success: "done" },
        },
      ]);

      await database.db
        .update(runs)
        .set({ parentRunId: parent.runId })
        .where(eq(runs.id, child.runId));
      await runFlow(parent.runId, {
        db: database.db as unknown as Db,
        runtimeRoot: supervisor.runtimeRoot,
      });
      const [parked] = await database.db
        .select()
        .from(runs)
        .where(eq(runs.id, parent.runId));

      expect(parked.status).toBe("WaitingOnChildren");
      const [sourceAttempt] = await database.db
        .select()
        .from(nodeAttempts)
        .where(eq(nodeAttempts.runId, parent.runId));

      expect(sourceAttempt.actionCompletion?.commandId).toBeTruthy();
      await runFlow(child.runId, {
        db: database.db as unknown as Db,
        runtimeRoot: supervisor.runtimeRoot,
      });
      const events = await database.db
        .select()
        .from(domainEvents)
        .where(
          and(
            eq(domainEvents.runId, child.runId),
            eq(domainEvents.kind, "run.review"),
          ),
        );

      expect(events).toHaveLength(1);
      const consumer = buildOrchestratorResumeConsumer({
        db: database.db,
        resumeFlow: (runId, options) =>
          runFlow(runId, { ...options, runtimeRoot: supervisor.runtimeRoot }),
      });
      const previousCap = process.env.MAISTER_MAX_CONCURRENT_RUNS;
      let continuation:
        | ReturnType<typeof startFlowContinuationWorker>
        | undefined;

      try {
        if (window === "after_claim") {
          await killAtNodeAttemptWrite(
            `NEW.id = '${sourceAttempt.id}' AND NEW.status = 'Running' AND NEW.action_prompt_ordinal = 1`,
            () =>
              startFixtureProcess(
                "flow-orchestrator-resume-process.ts",
                String(events[0].id),
              ),
          );
        } else if (window === "capacity") {
          const blocker = await seedOwnerFlow([
            {
              id: "blocker",
              type: "cli",
              action: { command: "true" },
              transitions: { success: "done" },
            },
          ]);

          process.env.MAISTER_MAX_CONCURRENT_RUNS = "1";
          await consumer.handle(events);
          const [deferred] = await database.db
            .select()
            .from(runs)
            .where(eq(runs.id, parent.runId));
          const [unchanged] = await database.db
            .select()
            .from(nodeAttempts)
            .where(eq(nodeAttempts.id, sourceAttempt.id));

          expect(deferred.status).toBe("WaitingOnChildren");
          expect(deferred.resumeRequestedAt).toBeInstanceOf(Date);
          expect(unchanged.actionPromptOrdinal).toBe(0);
          await runFlow(blocker.runId, {
            db: database.db as unknown as Db,
            runtimeRoot: supervisor.runtimeRoot,
          });
        } else {
          await consumer.handle(events);
        }
        if (window !== "live") {
          continuation = startFlowContinuationWorker({
            db: database.db as unknown as Db,
            runtimeRoot: supervisor.runtimeRoot,
          });
          await expect
            .poll(
              async () => {
                const [run] = await database.db
                  .select()
                  .from(runs)
                  .where(eq(runs.id, parent.runId));

                return run.status;
              },
              { timeout: 60_000 },
            )
            .toBe("Review");
        }

        const [finished] = await database.db
          .select()
          .from(runs)
          .where(eq(runs.id, parent.runId));

        expect(finished.status).toBe("Review");
        const attempts = await database.db
          .select()
          .from(nodeAttempts)
          .where(eq(nodeAttempts.runId, parent.runId));
        const prompts = await database.db
          .select()
          .from(executionCommands)
          .where(
            and(
              eq(executionCommands.runId, parent.runId),
              eq(executionCommands.kind, "session.prompt"),
            ),
          );

        expect(attempts).toHaveLength(1);
        expect(attempts[0]).toMatchObject({
          id: sourceAttempt.id,
          actionPromptOrdinal: 1,
          status: "Succeeded",
        });
        expect(prompts).toHaveLength(2);
        expect(
          new Set(prompts.map((command) => command.logicalOperationKey)).size,
        ).toBe(2);
        const [sourceAssignment] = await database.db
          .select()
          .from(executionAssignments)
          .where(
            eq(executionAssignments.id, sourceAttempt.executionAssignmentId!),
          );

        expect(sourceAssignment.state).toBe("released");
        await consumer.handle(events);
        expect(
          await database.db
            .select()
            .from(nodeAttempts)
            .where(eq(nodeAttempts.runId, parent.runId)),
        ).toHaveLength(1);
      } finally {
        await continuation?.stop();
        if (previousCap === undefined)
          delete process.env.MAISTER_MAX_CONCURRENT_RUNS;
        else process.env.MAISTER_MAX_CONCURRENT_RUNS = previousCap;
      }
    },
    110_000,
  );
  it("owner-flow-retry: SIGKILL preserves the admitted retry without extending its budget", async () => {
    const seeded = await seedOwnerFlow(
      [
        {
          id: "work",
          type: "ai_coding",
          action: {
            prompt: 'fixture-output:{"failMessage":"bounded retry failure"}',
          },
          retry_policy: {
            attempts: 2,
            on_errors: ["ACP_PROTOCOL"],
            workspace: "keep",
          },
          transitions: { success: "done" },
        },
      ],
      { engineMin: "2.1.0" },
    );
    let continuation:
      | ReturnType<typeof startFlowContinuationWorker>
      | undefined;

    try {
      await killBeforeSecondWorkAttempt(seeded.runId);
      continuation = startFlowContinuationWorker({
        db: database.db as unknown as Db,
        runtimeRoot: supervisor.runtimeRoot,
      });
      await expect
        .poll(
          async () => {
            const [run] = await database.db
              .select()
              .from(runs)
              .where(eq(runs.id, seeded.runId));

            return run.status;
          },
          { timeout: 60_000 },
        )
        .toBe("Failed");
      const attempts = await database.db
        .select()
        .from(nodeAttempts)
        .where(eq(nodeAttempts.runId, seeded.runId))
        .orderBy(nodeAttempts.attempt);
      const prompts = await database.db
        .select()
        .from(executionCommands)
        .where(
          and(
            eq(executionCommands.runId, seeded.runId),
            eq(executionCommands.kind, "session.prompt"),
          ),
        );

      expect(attempts).toHaveLength(2);
      expect(attempts[0]).toMatchObject({
        status: "Failed",
        autoRetry: false,
        finishContinuation: { targetNodeId: "work", autoRetry: true },
      });
      expect(attempts[1]).toMatchObject({
        status: "Failed",
        autoRetry: true,
        sessionPolicy: "new_session",
        finishContinuation: null,
      });
      expect(prompts).toHaveLength(2);
      expect(
        new Set(prompts.map((command) => command.logicalOperationKey)).size,
      ).toBe(2);
    } finally {
      await continuation?.stop();
    }
  }, 110_000);
  it.each([
    "before_terminal",
    "before_apply",
    "after_apply",
    "after_failure",
  ] as const)(
    "owner-flow-node: SIGKILL %s recovers the complete graph without another accepted prompt",
    async (window) => {
      const seeded = await seedOwnerFlow([
        {
          id: "work",
          type: "ai_coding",
          action: {
            prompt: `fixture-output:${JSON.stringify({ bytes: 1_999_983, chunkSize: 400_000, text: "\noriginal action tail", terminalDelayMs: window === "before_terminal" ? 5_000 : 0, ...(window === "after_failure" ? { failMessage: "original action failure" } : {}) })}`,
          },
          pre_finish: {
            gates: [
              {
                id: "review",
                kind: "ai_judgment",
                mode: "blocking",
                prompt:
                  'fixture-output:{"bytes":0,"text":"{\\"verdict\\":\\"pass\\",\\"confidence\\":0.95,\\"reasons\\":[\\"recovered gate\\"]}"}',
              },
            ],
          },
          transitions: { success: "after" },
        },
        {
          id: "after",
          type: "cli",
          action: {
            command: "printf 'continued\\n' >> continuation-count.txt",
          },
          transitions: { success: "done" },
        },
      ]);
      const trigger = `node_pause_${randomUUID().replaceAll("-", "")}`;
      const targetTable = window === "after_failure" ? "runs" : "node_attempts";
      const lockKey = Math.floor(Math.random() * 2_000_000_000) + 1;
      const lock = await database.pool.connect();
      let driver: ReturnType<typeof startDriver> | undefined;
      let continuation:
        | ReturnType<typeof startFlowContinuationWorker>
        | undefined;
      let ownerWorker: ReturnType<typeof startPromptOwnerWorker> | undefined;

      try {
        await lock.query("SELECT pg_advisory_lock(260907, $1)", [lockKey]);
        const predicate =
          window === "after_failure"
            ? `NEW.id = '${seeded.runId}' AND OLD.status = 'Running' AND NEW.status = 'Failed'`
            : `NEW.run_id = '${seeded.runId}' AND NEW.node_id = 'work' AND (${
                window === "before_apply"
                  ? "OLD.action_completion IS NULL AND NEW.action_completion IS NOT NULL"
                  : "OLD.status <> 'Succeeded' AND NEW.status = 'Succeeded'"
              })`;

        if (window !== "before_terminal") {
          await database.pool.query(
            `CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF ${predicate} THEN PERFORM pg_advisory_xact_lock(260907, ${lockKey}); END IF; RETURN NEW; END $$`,
          );
          await database.pool.query(
            `CREATE TRIGGER ${trigger} BEFORE UPDATE ON ${targetTable} FOR EACH ROW EXECUTE FUNCTION ${trigger}()`,
          );
        }
        driver = startDriver(seeded.runId);
        await expect
          .poll(
            async () => {
              if (driver?.child.exitCode !== null)
                throw new Error(driver?.output());
              if (window === "before_terminal") {
                const rows = await database.pool.query(
                  "SELECT count(*)::int AS count FROM execution_commands WHERE run_id = $1 AND kind = 'session.prompt' AND state = 'accepted'",
                  [seeded.runId],
                );

                return rows.rows[0].count as number;
              }
              const waiting = await database.pool.query(
                "SELECT count(*)::int AS count FROM pg_locks WHERE locktype = 'advisory' AND classid = 260907 AND objid = $1 AND NOT granted",
                [lockKey],
              );

              return waiting.rows[0].count as number;
            },
            { timeout: 30_000, interval: 25 },
          )
          .toBe(1);
        const admitted = await database.db
          .select()
          .from(executionCommands)
          .where(
            and(
              eq(executionCommands.runId, seeded.runId),
              eq(executionCommands.kind, "session.prompt"),
            ),
          );
        const original = admitted.find(
          (command) => command.ownerRef?.variant === "node",
        );

        if (!original) throw new Error("original owned node prompt missing");

        expect(original.applicationState).toBe(
          window === "after_apply" || window === "after_failure"
            ? "applied"
            : window === "before_apply"
              ? "applying"
              : "pending",
        );
        driver.child.kill("SIGKILL");
        await driver.exited;
        await lock.query("SELECT pg_advisory_unlock(260907, $1)", [lockKey]);
        ownerWorker = startPromptOwnerWorker({
          db: database.db as unknown as Db,
          owners: flowPromptOwners,
        });
        continuation = startFlowContinuationWorker({
          db: database.db as unknown as Db,
          runtimeRoot: supervisor.runtimeRoot,
        });
        await expect
          .poll(
            async () => {
              const [run] = await database.db
                .select()
                .from(runs)
                .where(eq(runs.id, seeded.runId));

              return run.status;
            },
            { timeout: 60_000 },
          )
          .toBe(window === "after_failure" ? "Failed" : "Review");
        const attempts = await database.db
          .select()
          .from(nodeAttempts)
          .where(eq(nodeAttempts.runId, seeded.runId));
        const prompts = await database.db
          .select()
          .from(executionCommands)
          .where(
            and(
              eq(executionCommands.runId, seeded.runId),
              eq(executionCommands.kind, "session.prompt"),
            ),
          );
        const evaluations = await database.db
          .select()
          .from(gateResults)
          .where(eq(gateResults.runId, seeded.runId));

        if (window === "after_failure") {
          expect(attempts).toHaveLength(1);
          expect(attempts[0]).toMatchObject({
            status: "Failed",
            errorCode: "ACP_PROTOCOL",
          });
          expect(prompts).toHaveLength(1);
          expect(prompts[0]).toMatchObject({
            id: original.id,
            requestSha256: original.requestSha256,
            applicationState: "applied",
          });
          expect(evaluations).toHaveLength(0);
          await expect(
            readFile(
              path.join(seeded.worktreePath, "continuation-count.txt"),
              "utf8",
            ),
          ).rejects.toMatchObject({ code: "ENOENT" });

          return;
        }
        expect(attempts).toHaveLength(2);
        expect(
          attempts.every((attempt) => attempt.status === "Succeeded"),
        ).toBe(true);
        expect(prompts).toHaveLength(2);
        expect(
          prompts.find((command) => command.id === original.id),
        ).toMatchObject({
          requestSha256: original.requestSha256,
          applicationState: "applied",
        });
        expect(evaluations).toHaveLength(1);
        expect(evaluations[0]).toMatchObject({
          status: "passed",
          verdict: { reasons: ["recovered gate"] },
        });
        expect(
          await readFile(
            path.join(seeded.worktreePath, "continuation-count.txt"),
            "utf8",
          ),
        ).toBe("continued\n");
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
        await continuation?.stop();
        await ownerWorker?.stop();
        if (window !== "before_terminal") {
          await database.pool.query(
            `DROP TRIGGER IF EXISTS ${trigger} ON ${targetTable}`,
          );
          await database.pool.query(`DROP FUNCTION IF EXISTS ${trigger}()`);
        }
      }
    },
    110_000,
  );
  it("owner-flow-node: validates the original tail result beyond the stdout preview", async () => {
    const payload = { verdict: "pass", score: 0.95 };
    const prompt = `fixture-output:${JSON.stringify({ bytes: 1_999_983, chunkSize: 400_000, text: `\n\`\`\`json maister:output\n${JSON.stringify(payload)}\n\`\`\`` })}`;
    const seeded = await seedOwnerFlow(
      [
        {
          id: "work",
          type: "ai_coding",
          action: { prompt },
          output: {
            result: { schema: "./schemas/result.json", required: true },
          },
          transitions: { success: "done" },
        },
      ],
      {
        engineMin: "1.7.0",
        installedPath: path.resolve(
          "lib/flows/graph/__tests__/_fixtures/m26-output-flow",
        ),
      },
    );

    await runFlow(seeded.runId, {
      db: database.db,
      runtimeRoot: supervisor.runtimeRoot,
      executionHosts: createExecutionHosts({
        db: database.db as unknown as Db,
      }),
    });
    const [attempt] = await database.db
      .select()
      .from(nodeAttempts)
      .where(eq(nodeAttempts.runId, seeded.runId));
    const [run] = await database.db
      .select()
      .from(runs)
      .where(eq(runs.id, seeded.runId));

    expect(run.status).toBe("Review");
    expect(attempt).toMatchObject({
      status: "Succeeded",
      vars: payload,
      actionCompletion: {
        originalOutput: { kind: "value", value: payload },
      },
    });
    expect(attempt.stdout).not.toContain("maister:output");
  }, 60_000);
  it("owner-flow-node: the action result belongs to its exact attempt and immutable prompt", async () => {
    const seeded = await seedOwnerFlow([
      {
        id: "work",
        type: "ai_coding",
        action: {
          prompt: 'fixture-output:{"bytes":0,"text":"original node result"}',
        },
        transitions: { success: "done" },
      },
    ]);

    await runFlow(seeded.runId, {
      db: database.db,
      runtimeRoot: supervisor.runtimeRoot,
      executionHosts: createExecutionHosts({
        db: database.db as unknown as Db,
      }),
    });
    const attempts = await database.db
      .select()
      .from(nodeAttempts)
      .where(eq(nodeAttempts.runId, seeded.runId));
    const prompts = await database.db
      .select()
      .from(executionCommands)
      .where(
        and(
          eq(executionCommands.runId, seeded.runId),
          eq(executionCommands.kind, "session.prompt"),
        ),
      );

    expect(attempts).toHaveLength(1);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toMatchObject({
      requestSchema: "maister.command.request.v2",
      ownerKind: "flow_node_attempt",
      ownerRef: {
        variant: "node",
        nodeAttemptId: attempts[0].id,
        promptOrdinal: 0,
      },
      applicationState: "applied",
    });
    expect(prompts[0].completionAppliedAt).not.toBeNull();
    expect(attempts[0]).toMatchObject({
      status: "Succeeded",
      stdout: "original node result",
    });
  }, 60_000);
  it.each(["ai_judgment", "skill_check"] as const)(
    "owner-gate-%s: applies the exact evaluation once and retains the original prompt",
    async (kind) => {
      const seeded = await seedGate(kind);

      await runFlow(seeded.runId, {
        db: database.db,
        runtimeRoot: supervisor.runtimeRoot,
        executionHosts: createExecutionHosts({
          db: database.db as unknown as Db,
        }),
      });
      const [run] = await database.db
        .select()
        .from(runs)
        .where(eq(runs.id, seeded.runId));
      const evaluations = await database.db
        .select()
        .from(gateResults)
        .where(eq(gateResults.runId, seeded.runId));
      const attempts = await database.db
        .select()
        .from(nodeAttempts)
        .where(eq(nodeAttempts.runId, seeded.runId));
      const prompts = await database.db
        .select()
        .from(executionCommands)
        .where(
          and(
            eq(executionCommands.runId, seeded.runId),
            eq(executionCommands.kind, "session.prompt"),
          ),
        );

      expect(run.status).toBe("Review");
      expect(evaluations).toHaveLength(1);
      expect(evaluations[0]).toMatchObject({
        status: "passed",
        verdict: { verdict: "pass", reasons: ["original verdict"] },
      });
      expect(attempts).toHaveLength(1);
      expect(prompts).toHaveLength(1);
      expect(prompts[0]).toMatchObject({
        requestSchema: "maister.command.request.v2",
        ownerKind: "flow_node_attempt",
        ownerRef: {
          variant: kind === "skill_check" ? "gate_skill" : "gate_ai",
          nodeAttemptId: attempts[0].id,
          evaluationId: evaluations[0].id,
          gateId: "review",
          promptOrdinal: 0,
        },
        applicationState: "applied",
      });
      expect(prompts[0].requestCanonicalJson).toContain("original verdict");
      expect(prompts[0].completionAppliedAt).not.toBeNull();
    },
    60_000,
  );
  it.each([
    { kind: "ai_judgment", continuation: "resume" },
    { kind: "skill_check", continuation: "resume" },
    { kind: "ai_judgment", continuation: "fenced" },
    { kind: "skill_check", continuation: "fenced" },
  ] as const)(
    "owner-gate-$kind: SIGKILL before application recovers the original verdict ($continuation)",
    async ({ kind, continuation }) => {
      // The verdict itself crosses the 400 kB ACP chunk boundary.
      const seeded = await seedGate(kind, 1_999_983);
      const suffix = randomUUID().replaceAll("-", "");
      const trigger = `owner_pause_${suffix}`;
      const lockKey = Math.floor(Math.random() * 2_000_000_000) + 1;
      const lock = await database.pool.connect();
      let driver: ReturnType<typeof startDriver> | undefined;
      let ownerWorker: ReturnType<typeof startPromptOwnerWorker> | undefined;
      let graphWorker:
        | ReturnType<typeof startFlowContinuationWorker>
        | undefined;

      try {
        await lock.query("SELECT pg_advisory_lock(260906, $1)", [lockKey]);
        await database.pool.query(
          `CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.run_id = '${seeded.runId}' AND NEW.status IN ('passed', 'failed') THEN PERFORM pg_advisory_xact_lock(260906, ${lockKey}); END IF; RETURN NEW; END $$`,
        );
        await database.pool.query(
          `CREATE TRIGGER ${trigger} BEFORE UPDATE ON gate_results FOR EACH ROW EXECUTE FUNCTION ${trigger}()`,
        );
        driver = startDriver(seeded.runId);
        await expect
          .poll(
            async () => {
              const waiting = await database.pool.query(
                "SELECT count(*)::int AS count FROM pg_locks WHERE locktype = 'advisory' AND classid = 260906 AND objid = $1 AND NOT granted",
                [lockKey],
              );

              if (driver?.child.exitCode !== null)
                throw new Error(driver?.output());

              return waiting.rows[0].count as number;
            },
            { timeout: 30_000, interval: 25 },
          )
          .toBe(1);
        const [before] = await database.db
          .select()
          .from(executionCommands)
          .where(
            and(
              eq(executionCommands.runId, seeded.runId),
              eq(executionCommands.kind, "session.prompt"),
            ),
          );

        expect(
          {
            state: before.state,
            applicationState: before.applicationState,
            completionAppliedAt: before.completionAppliedAt,
          },
          `${driver.output()}\n${JSON.stringify(before.lastError)}`,
        ).toMatchObject({
          state: "succeeded",
          applicationState: "applying",
          completionAppliedAt: null,
        });
        driver.child.kill("SIGKILL");
        await driver.exited;
        await lock.query("SELECT pg_advisory_unlock(260906, $1)", [lockKey]);
        const [rolledBack] = await database.db
          .select()
          .from(gateResults)
          .where(eq(gateResults.runId, seeded.runId));

        expect(rolledBack.status).toBe("running");
        ownerWorker = startPromptOwnerWorker({
          db: database.db as unknown as Db,
          owners: flowPromptOwners,
        });
        await expect
          .poll(
            async () => {
              const [command] = await database.db
                .select()
                .from(executionCommands)
                .where(eq(executionCommands.id, before.id));

              return command.applicationState;
            },
            { timeout: 45_000 },
          )
          .toBe("applied");
        const loaded = await loadRun(database.db, seeded.runId);
        const attempts = await database.db
          .select()
          .from(nodeAttempts)
          .where(eq(nodeAttempts.runId, seeded.runId));
        const node = compileManifest(loaded.manifest).nodes.get("work");

        if (!node) throw new Error("seeded graph node missing");
        const context = buildContext({
          task: loaded.task,
          run: loaded.run,
          executor: loaded.executor,
          nodeAttempts: attempts,
          projectSlug: loaded.projectSlug,
        });

        expect(
          await runNodeGates(node, attempts[0].id, loaded, context, {
            db: database.db,
            runtimeRoot: supervisor.runtimeRoot,
            worktreePath: seeded.worktreePath,
          }),
        ).toMatchObject({ ok: true });
        const evaluations = await database.db
          .select()
          .from(gateResults)
          .where(eq(gateResults.runId, seeded.runId));

        expect(evaluations).toHaveLength(1);
        expect(evaluations[0]).toMatchObject({
          id: rolledBack.id,
          status: "passed",
          verdict: { verdict: "pass", reasons: ["original verdict"] },
        });
        const prompts = await database.db
          .select()
          .from(executionCommands)
          .where(
            and(
              eq(executionCommands.runId, seeded.runId),
              eq(executionCommands.kind, "session.prompt"),
            ),
          );

        expect(prompts).toHaveLength(1);
        expect(prompts[0]).toMatchObject({
          id: before.id,
          requestSha256: before.requestSha256,
          applicationState: "applied",
          applicationAttempts: 0,
        });
        if (continuation === "fenced") {
          await database.db.transaction((tx) =>
            mintAssignment(tx as unknown as Db, {
              runId: seeded.runId,
              hostId: before.executionHostId,
              reason: "recover",
            }),
          );
          expect(
            await runNodeGates(node, attempts[0].id, loaded, context, {
              db: database.db,
              runtimeRoot: supervisor.runtimeRoot,
              worktreePath: seeded.worktreePath,
            }),
          ).toEqual({ ok: false, fenced: true });

          return;
        }
        graphWorker = startFlowContinuationWorker({
          db: database.db as unknown as Db,
          runtimeRoot: supervisor.runtimeRoot,
        });
        await expect
          .poll(
            async () => {
              const [run] = await database.db
                .select()
                .from(runs)
                .where(eq(runs.id, seeded.runId));

              return run.status;
            },
            { timeout: 45_000 },
          )
          .toBe("Review");
        expect(
          await readFile(
            path.join(seeded.worktreePath, "gate-parent-count.txt"),
            "utf8",
          ),
        ).toBe("work\n");
        await graphWorker.stop();
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
        await graphWorker?.stop();
        await ownerWorker?.stop();
        await database.pool.query(
          `DROP TRIGGER IF EXISTS ${trigger} ON gate_results`,
        );
        await database.pool.query(`DROP FUNCTION IF EXISTS ${trigger}()`);
      }
    },
    90_000,
  );
  it("application failure preserves the running gate and its live session for repair", async () => {
    const seeded = await seedGate("ai_judgment");
    const trigger = `owner_fail_${randomUUID().replaceAll("-", "")}`;

    try {
      await database.pool.query(
        `CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.run_id = '${seeded.runId}' AND NEW.status IN ('passed', 'failed') THEN RAISE EXCEPTION 'gate application unavailable'; END IF; RETURN NEW; END $$`,
      );
      await database.pool.query(
        `CREATE TRIGGER ${trigger} BEFORE UPDATE ON gate_results FOR EACH ROW EXECUTE FUNCTION ${trigger}()`,
      );
      await runFlow(seeded.runId, {
        db: database.db,
        runtimeRoot: supervisor.runtimeRoot,
        executionHosts: createExecutionHosts({
          db: database.db as unknown as Db,
        }),
      });
      const [run] = await database.db
        .select()
        .from(runs)
        .where(eq(runs.id, seeded.runId));
      const evaluations = await database.db
        .select()
        .from(gateResults)
        .where(eq(gateResults.runId, seeded.runId));
      const commands = await database.db
        .select()
        .from(executionCommands)
        .where(eq(executionCommands.runId, seeded.runId));
      const prompts = commands.filter(
        (command) => command.kind === "session.prompt",
      );

      expect(run).toMatchObject({ status: "Running", currentStepId: "work" });
      expect(evaluations).toHaveLength(1);
      expect(evaluations[0]).toMatchObject({
        status: "running",
        verdict: null,
      });
      expect(prompts).toHaveLength(1);
      expect(prompts[0]).toMatchObject({
        state: "succeeded",
        applicationState: "poisoned",
        completionAppliedAt: null,
      });
      expect(
        commands.filter((command) => command.kind === "session.delete"),
      ).toHaveLength(0);
    } finally {
      await database.pool.query(
        `DROP TRIGGER IF EXISTS ${trigger} ON gate_results`,
      );
      await database.pool.query(`DROP FUNCTION IF EXISTS ${trigger}()`);
    }
  }, 60_000);
});
