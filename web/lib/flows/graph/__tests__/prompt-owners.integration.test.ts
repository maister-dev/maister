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
  nodeAttempts,
  runs,
} from "@/lib/db/schema";
import { loadRun } from "@/lib/flows/graph/runner-core";
import { compileManifest } from "@/lib/flows/graph/compile";
import { buildContext } from "@/lib/flows/context";
import { runNodeGates } from "@/lib/flows/graph/gates-exec";
import { flowPromptOwners } from "@/lib/flows/graph/prompt-owner";
import { startFlowContinuationWorker } from "@/lib/flows/graph/continuation-worker";
import { startPromptOwnerWorker } from "@/lib/execution-host/prompt-owner-recovery";
import { runFlow } from "@/lib/flows/runner";
import { buildOrchestratorResumeConsumer } from "@/lib/domain-events/orchestrator-resume";
import { createExecutionHosts } from "@/lib/execution-host/client";
import { mintAssignment } from "@/lib/execution-host/assignments";
import { canonicalProjectors } from "@/lib/execution-host/events/projection-runtime";
import { startProjectionWorker } from "@/lib/execution-host/events/projection-worker";
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
): {
  child: ChildProcess;
  exited: Promise<number | null>;
  output: () => string;
} {
  const child = fork(
    path.resolve("test-support", script),
    [targetId, supervisor.runtimeRoot],
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
  const trigger = `attempt_pause_${randomUUID().replaceAll("-", "")}`;
  const lockKey = Math.floor(Math.random() * 2_000_000_000) + 1;
  const lock = await database.pool.connect();
  let driver: ReturnType<typeof startDriver> | undefined;

  try {
    await lock.query("SELECT pg_advisory_lock(260908, $1)", [lockKey]);
    await database.pool.query(
      `CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF ${predicate} THEN PERFORM pg_advisory_xact_lock(260908, ${lockKey}); END IF; RETURN NEW; END $$`,
    );
    await database.pool.query(
      `CREATE TRIGGER ${trigger} BEFORE INSERT OR UPDATE ON node_attempts FOR EACH ROW EXECUTE FUNCTION ${trigger}()`,
    );
    driver = launch();
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
      `DROP TRIGGER IF EXISTS ${trigger} ON node_attempts`,
    );
    await database.pool.query(`DROP FUNCTION IF EXISTS ${trigger}()`);
  }
}

describe("Flow prompt owners through the production graph driver", () => {
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
