import type { Db } from "@/lib/execution-host/db";
import type { RealSupervisor } from "@/test-support/real-supervisor";
import type { ProjectionWorker } from "@/lib/execution-host/events/projection-worker";

import { randomUUID } from "node:crypto";
import { fork, type ChildProcess } from "node:child_process";
import path from "node:path";

import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  executionCommands,
  gateResults,
  nodeAttempts,
  runs,
} from "@/lib/db/schema";
import { loadRun } from "@/lib/flows/graph/runner-core";
import { compileManifest } from "@/lib/flows/graph/compile";
import { buildContext } from "@/lib/flows/context";
import { runNodeGates } from "@/lib/flows/graph/gates-exec";
import { flowPromptOwners } from "@/lib/flows/graph/prompt-owner";
import { startPromptOwnerWorker } from "@/lib/execution-host/prompt-owner-recovery";
import { runFlow } from "@/lib/flows/runner";
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
    fixtureArgs: ["--hang", "--lines", "0"],
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

async function seedGate(kind: "ai_judgment" | "skill_check", prefixBytes = 0) {
  const name = randomUUID();
  const repoPath = await initRepo(`${supervisor.runtimeRoot}/repo-${name}`);
  const worktreePath = await addWorktree(
    repoPath,
    `${supervisor.runtimeRoot}/wt-${name}`,
    `maister/${name}`,
  );
  const prompt = `fixture-output:${JSON.stringify({
    bytes: prefixBytes,
    chunkSize: 400_000,
    text: '{"verdict":"pass","confidence":0.95,"reasons":["original verdict"]}',
  })}`;

  return seedGraphRun(
    database.db,
    {
      schemaVersion: 1,
      name: "owned-gates",
      compat: { engine_min: "1.1.0" },
      nodes: [
        {
          id: "work",
          type: "cli",
          action: { command: "echo work" },
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
      ],
    },
    {
      repoPath,
      flowRevision: true,
      workspace: {
        worktreePath,
        parentRepoPath: repoPath,
        branch: `maister/${name}`,
      },
    },
  );
}

function startDriver(runId: string): {
  child: ChildProcess;
  exited: Promise<number | null>;
  output: () => string;
} {
  const child = fork(
    path.resolve("test-support/flow-prompt-owner-process.ts"),
    [runId, supervisor.runtimeRoot],
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

describe("Flow prompt owners through the production graph driver", () => {
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
  it.each(["ai_judgment", "skill_check"] as const)(
    "owner-gate-%s: SIGKILL before application rolls back and an owner worker recovers the original verdict",
    async (kind) => {
      // The verdict itself crosses the 400 kB ACP chunk boundary.
      const seeded = await seedGate(kind, 1_999_983);
      const suffix = randomUUID().replaceAll("-", "");
      const trigger = `owner_pause_${suffix}`;
      const lockKey = Math.floor(Math.random() * 2_000_000_000) + 1;
      const lock = await database.pool.connect();
      let driver: ReturnType<typeof startDriver> | undefined;
      let ownerWorker: ReturnType<typeof startPromptOwnerWorker> | undefined;

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
