import type { Db } from "@/lib/execution-host/db";
import type { RealSupervisor } from "@/test-support/real-supervisor";
import type { ProjectionWorker } from "@/lib/execution-host/events/projection-worker";
import type { FlowYamlV1 } from "@/lib/config.schema";

import { randomUUID } from "node:crypto";
import { fork, type ChildProcess } from "node:child_process";
import path from "node:path";

import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  agentTurns,
  artifactInstances,
  consensusRoundVerdicts,
  domainEvents,
  executionCommands,
  flowRevisions,
  flows,
  nodeAttempts,
  runs,
} from "@/lib/db/schema";
import { buildOrchestratorResumeConsumer } from "@/lib/domain-events/orchestrator-resume";
import { startPromptOwnerWorker } from "@/lib/execution-host/prompt-owner-recovery";
import { flowPromptOwners } from "@/lib/flows/graph/prompt-owner";
import { consensusDraftPromptOwners } from "@/lib/flows/graph/consensus/draft-prompt-owner";
import { runFlow } from "@/lib/flows/runner";
import { createExecutionHosts } from "@/lib/execution-host/client";
import { canonicalProjectors } from "@/lib/execution-host/events/projection-runtime";
import { startProjectionWorker } from "@/lib/execution-host/events/projection-worker";
import { stopRuntimeEventConsumers } from "@/lib/execution-host/events/consumer";
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
    databaseName: "consensus_prompt_owners",
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

const AXES = ["scope", "risk"] as const;

function verdictJson(verdict: "agree" | "disagree"): string {
  return JSON.stringify({
    verdict,
    axes: { scope: verdict === "agree", risk: verdict === "agree" },
    disagreements: [],
    confidence: 0.9,
  });
}

/** The mock adapter echoes the FIRST `fixture-output:` line of its prompt. A
 * draft body therefore carries the verifier's own fixture line, because the
 * verifier prompt embeds the target draft text verbatim. */
function consensusPrompt(verdict: "agree" | "disagree"): string {
  const draftBody = `\nfixture-output:${JSON.stringify({
    bytes: 0,
    text: verdictJson(verdict),
  })}`;

  return `fixture-output:${JSON.stringify({ bytes: 0, text: draftBody })}`;
}

async function seedConsensusFlow(prompt: string) {
  const name = randomUUID();
  const repoPath = await initRepo(`${supervisor.runtimeRoot}/repo-${name}`);
  const worktreePath = await addWorktree(
    repoPath,
    `${supervisor.runtimeRoot}/wt-${name}`,
    `maister/${name}`,
  );
  const nodes: FlowYamlV1["nodes"] = [
    {
      id: "decide",
      type: "consensus",
      prompt,
      participants: [
        { id: "architect", runner: "primary" },
        { id: "qa", runner: "primary" },
      ],
      material_axes: [...AXES],
      rounds: { mode: "single_pass", max: 1 },
      synthesizer: { runner: "primary" },
      transitions: { success: "done" },
    },
  ] as unknown as FlowYamlV1["nodes"];

  const manifest = {
    schemaVersion: 1,
    name: "consensus-owner-flow",
    compat: { engine_min: "1.5.0" },
    nodes,
  };
  const seeded = await seedGraphRun(database.db, manifest, {
    repoPath,
    flowRevision: true,
    workspace: {
      worktreePath,
      parentRepoPath: repoPath,
      branch: `maister/${name}`,
    },
  });

  // Every seeded project adds a platform runner, so intent auto-match becomes
  // ambiguous across suites: bind each slot to this run's concrete runner id.
  const bound = JSON.parse(
    JSON.stringify(manifest).replaceAll('"primary"', `"${seeded.executorId}"`),
  );

  await database.db
    .update(flowRevisions)
    .set({ manifest: bound })
    .where(eq(flowRevisions.id, seeded.flowRevisionId!));
  await database.db
    .update(flows)
    .set({ manifest: bound })
    .where(eq(flows.id, seeded.flowId));

  return seeded;
}

function drive(runId: string): Promise<unknown> {
  return runFlow(runId, {
    db: database.db,
    runtimeRoot: supervisor.runtimeRoot,
    executionHosts: createExecutionHosts({ db: database.db as unknown as Db }),
  });
}

/** Round 1 fans out real child agent runs. Wake the parent exactly the way the
 * production domain-event dispatcher does once every draft is terminal. */
async function settleDraftsAndResume(parentRunId: string): Promise<void> {
  await expect
    .poll(
      async () => {
        const children = await database.db
          .select({ status: runs.status })
          .from(runs)
          .where(eq(runs.parentRunId, parentRunId));

        return children.length === 2 &&
          children.every((child) => child.status === "Done")
          ? children.length
          : 0;
      },
      { timeout: 60_000, interval: 100 },
    )
    .toBe(2);
  const events = await database.db
    .select()
    .from(domainEvents)
    .where(eq(domainEvents.kind, "run.done"));
  const consumer = buildOrchestratorResumeConsumer({
    db: database.db,
    resumeFlow: (runId, options) =>
      runFlow(runId, {
        ...options,
        runtimeRoot: supervisor.runtimeRoot,
        executionHosts: createExecutionHosts({
          db: database.db as unknown as Db,
        }),
      }),
  });

  await consumer.handle(events);
}

function startFixtureProcess(targetId: string): {
  child: ChildProcess;
  exited: Promise<number | null>;
  output: () => string;
} {
  const child = fork(
    path.resolve("test-support", "consensus-draft-process.ts"),
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

  return {
    child,
    exited: new Promise<number | null>((resolve, reject) => {
      child.once("exit", resolve);
      child.once("error", reject);
    }),
    output: () => output,
  };
}

/** Block the driver inside the write named by `predicate`, then SIGKILL it —
 * a real process death in that exact window, not a simulated failure. */
async function killAtDatabaseWrite(input: {
  table: string;
  event: string;
  predicate: string;
  runId: string;
}): Promise<void> {
  const trigger = `draft_pause_${randomUUID().replaceAll("-", "")}`;
  const lockKey = Math.floor(Math.random() * 2_000_000_000) + 1;
  const lock = await database.pool.connect();
  let driver: ReturnType<typeof startFixtureProcess> | undefined;

  try {
    await lock.query("SELECT pg_advisory_lock(270907, $1)", [lockKey]);
    await database.pool.query(
      `CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF ${input.predicate} THEN PERFORM pg_advisory_xact_lock(270907, ${lockKey}); END IF; RETURN NEW; END $$`,
    );
    await database.pool.query(
      `CREATE TRIGGER ${trigger} BEFORE ${input.event} ON ${input.table} FOR EACH ROW EXECUTE FUNCTION ${trigger}()`,
    );
    driver = startFixtureProcess(input.runId);
    await expect
      .poll(
        async () => {
          if (driver?.child.exitCode !== null)
            throw new Error(driver?.output());
          const waiting = await database.pool.query(
            "SELECT count(*)::int AS count FROM pg_locks WHERE locktype = 'advisory' AND classid = 270907 AND objid = $1 AND NOT granted",
            [lockKey],
          );

          return waiting.rows[0].count as number;
        },
        { timeout: 60_000, interval: 25 },
      )
      .toBeGreaterThan(0);
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

describe("Consensus prompt owners through the production graph driver", () => {
  it("owner-consensus-draft: the draft artifact comes from the durable command output", async () => {
    const seeded = await seedConsensusFlow(consensusPrompt("agree"));

    await drive(seeded.runId);
    await expect
      .poll(
        async () => {
          const children = await database.db
            .select({ status: runs.status })
            .from(runs)
            .where(eq(runs.parentRunId, seeded.runId));

          return children.length === 2 &&
            children.every((child) => child.status === "Done")
            ? children.length
            : 0;
        },
        { timeout: 60_000, interval: 100 },
      )
      .toBe(2);
    const [attempt] = await database.db
      .select()
      .from(nodeAttempts)
      .where(eq(nodeAttempts.runId, seeded.runId));
    const children = await database.db
      .select()
      .from(runs)
      .where(eq(runs.parentRunId, seeded.runId));

    for (const child of children) {
      const payload = child.triggerPayload as Record<string, unknown>;
      const [artifact] = await database.db
        .select()
        .from(artifactInstances)
        .where(
          eq(
            artifactInstances.id,
            `run:${child.id}:consensus-draft:${attempt.id}:${String(payload.participantId)}:r1`,
          ),
        );

      expect(artifact?.locator).toMatchObject({ kind: "inline" });
      expect((artifact.locator as { text: string }).text).toContain(
        "fixture-output:",
      );
      const [command] = await database.db
        .select()
        .from(executionCommands)
        .where(
          and(
            eq(executionCommands.runId, child.id),
            eq(executionCommands.kind, "session.prompt"),
          ),
        );

      expect(command?.ownerKind).toBe("agent_turn");
      expect(command?.ownerRef).toMatchObject({
        variant: "consensus_draft",
        nodeAttemptId: attempt.id,
        round: 1,
        participantId: payload.participantId,
      });
      expect(command?.applicationState).toBe("applied");
      const [turn] = await database.db
        .select()
        .from(agentTurns)
        .where(eq(agentTurns.runId, child.id));

      expect(turn).toMatchObject({
        variant: "consensus_draft",
        ordinal: 0,
        state: "applied",
        commandId: command.id,
      });
    }
  }, 180_000);
  it("owner-consensus-draft: process death before application keeps the original draft", async () => {
    const seeded = await seedConsensusFlow(consensusPrompt("agree"));

    await killAtDatabaseWrite({
      table: "artifact_instances",
      event: "INSERT",
      predicate: "NEW.node_id = 'consensus-draft'",
      runId: seeded.runId,
    });
    const childIds = (
      await database.db
        .select({ id: runs.id })
        .from(runs)
        .where(eq(runs.parentRunId, seeded.runId))
    ).map((child) => child.id);

    expect(childIds).toHaveLength(2);
    const draftCommands = async () =>
      database.db
        .select({
          state: executionCommands.state,
          applicationState: executionCommands.applicationState,
        })
        .from(executionCommands)
        .where(
          and(
            inArray(executionCommands.runId, childIds),
            eq(executionCommands.kind, "session.prompt"),
          ),
        );
    const draftArtifacts = async () =>
      database.db
        .select()
        .from(artifactInstances)
        .where(inArray(artifactInstances.runId, childIds));
    const stranded = await draftCommands();

    // The blocked participant's whole application rolled back with its process:
    // the host outcome survives, the draft artifact and completion do not.
    expect(stranded.every((command) => command.state === "succeeded")).toBe(
      true,
    );
    expect(
      stranded.filter((command) => command.applicationState !== "applied")
        .length,
    ).toBeGreaterThan(0);
    expect(await draftArtifacts()).not.toHaveLength(2);
    const worker = startPromptOwnerWorker({
      db: database.db as unknown as Db,
      owners: consensusDraftPromptOwners,
    });

    try {
      await expect
        .poll(async () => (await draftArtifacts()).length, {
          timeout: 60_000,
          interval: 100,
        })
        .toBe(2);
    } finally {
      await worker.stop();
    }
    const children = await database.db
      .select({ status: runs.status })
      .from(runs)
      .where(inArray(runs.id, childIds));

    expect(children.map((child) => child.status)).toEqual(["Done", "Done"]);
    for (const draft of await draftArtifacts())
      expect((draft.locator as { text: string }).text).toContain(
        "fixture-output:",
      );
    expect(
      (await draftCommands()).every(
        (command) => command.applicationState === "applied",
      ),
    ).toBe(true);
  }, 180_000);
  it("owner-consensus-verify: every matrix cell owns its own command", async () => {
    const seeded = await seedConsensusFlow(consensusPrompt("agree"));

    await drive(seeded.runId);
    await settleDraftsAndResume(seeded.runId);
    const [attempt] = await database.db
      .select()
      .from(nodeAttempts)
      .where(eq(nodeAttempts.runId, seeded.runId));
    const verdicts = await database.db
      .select()
      .from(consensusRoundVerdicts)
      .where(eq(consensusRoundVerdicts.nodeAttemptId, attempt.id));

    expect(verdicts).toHaveLength(2);
    const keys = new Set<string>();

    for (const verdict of verdicts) {
      expect(verdict.verdict).toBe("agree");
      const [command] = await database.db
        .select()
        .from(executionCommands)
        .where(
          and(
            eq(executionCommands.runId, seeded.runId),
            eq(
              executionCommands.logicalOperationKey,
              `flow_node_attempt:consensus_verifier:${verdict.id}`,
            ),
          ),
        );

      expect(command?.ownerKind).toBe("flow_node_attempt");
      expect(command?.ownerRef).toMatchObject({
        variant: "consensus_verifier",
        nodeAttemptId: attempt.id,
        round: verdict.round,
        verifierId: verdict.verifierKey,
        targetId: verdict.targetKey,
        verdictId: verdict.id,
      });
      expect(command?.applicationState).toBe("applied");
      keys.add(`${verdict.verifierKey}:${verdict.targetKey}:${verdict.round}`);
    }
    // One paid verification per matrix cell, never a cross-applied twin.
    expect(keys.size).toBe(2);
    const owned = await database.db
      .select({ ownerRef: executionCommands.ownerRef })
      .from(executionCommands)
      .where(
        and(
          eq(executionCommands.runId, seeded.runId),
          eq(executionCommands.ownerKind, "flow_node_attempt"),
        ),
      );

    expect(
      owned.filter(
        (command) =>
          (command.ownerRef as { variant?: string } | null)?.variant ===
          "consensus_verifier",
      ),
    ).toHaveLength(2);
  }, 180_000);
  it("owner-consensus-synthesis: the plan comes from its own applied generation", async () => {
    const seeded = await seedConsensusFlow(consensusPrompt("agree"));

    await drive(seeded.runId);
    await settleDraftsAndResume(seeded.runId);
    const [attempt] = await database.db
      .select()
      .from(nodeAttempts)
      .where(eq(nodeAttempts.runId, seeded.runId));
    const synthesisId = `run:${attempt.id}:consensus-synthesis:r1:consensus`;
    const [synthesis] = await database.db
      .select()
      .from(artifactInstances)
      .where(eq(artifactInstances.id, synthesisId));

    expect(synthesis?.locator).toMatchObject({ kind: "inline" });
    const planText = (synthesis.locator as { text: string }).text;

    expect(planText.trim()).not.toBe("");
    const [command] = await database.db
      .select()
      .from(executionCommands)
      .where(
        and(
          eq(executionCommands.runId, seeded.runId),
          eq(
            executionCommands.logicalOperationKey,
            `flow_node_attempt:consensus_synthesis:${synthesisId}`,
          ),
        ),
      );

    expect(command?.ownerKind).toBe("flow_node_attempt");
    expect(command?.ownerRef).toMatchObject({
      variant: "consensus_synthesis",
      nodeAttemptId: attempt.id,
      round: 1,
      synthesisId,
    });
    expect(command?.applicationState).toBe("applied");
    // The node's published plan is exactly its own generation's output.
    const [plan] = await database.db
      .select()
      .from(artifactInstances)
      .where(eq(artifactInstances.id, `run:${attempt.id}:consensus_plan`));

    expect((plan.locator as { text: string }).text).toBe(planText);
    expect(attempt.status).toBe("Succeeded");
  }, 180_000);
  it("owner-consensus-verify: a recorded cell cannot be rewritten or re-applied", async () => {
    const seeded = await seedConsensusFlow(consensusPrompt("disagree"));

    await drive(seeded.runId);
    await settleDraftsAndResume(seeded.runId);
    const [attempt] = await database.db
      .select()
      .from(nodeAttempts)
      .where(eq(nodeAttempts.runId, seeded.runId));
    const [run] = await database.db
      .select({ status: runs.status })
      .from(runs)
      .where(eq(runs.id, seeded.runId));

    // No consensus: the node escalates and both cells stay recorded.
    expect(run.status).toBe("NeedsInput");
    expect(attempt.status).toBe("NeedsInput");
    const cells = await database.db
      .select()
      .from(consensusRoundVerdicts)
      .where(eq(consensusRoundVerdicts.nodeAttemptId, attempt.id));

    expect(cells).toHaveLength(2);
    const victim = cells.find((cell) => cell.verifierKey === "qa")!;
    const source = cells.find((cell) => cell.verifierKey === "architect")!;
    const [command] = await database.db
      .select()
      .from(executionCommands)
      .where(
        and(
          eq(executionCommands.runId, seeded.runId),
          eq(
            executionCommands.logicalOperationKey,
            `flow_node_attempt:consensus_verifier:${source.id}`,
          ),
        ),
      );

    // Layer 1: an admitted command's cell identity is immutable in Postgres, so
    // one cell's paid output can never be re-pointed at its sibling.
    await expect(
      database.db
        .update(executionCommands)
        .set({
          ownerRef: {
            ...(command.ownerRef as Record<string, unknown>),
            verifierId: victim.verifierKey,
            targetId: victim.targetKey,
            verdictId: victim.id,
          } as NonNullable<typeof command.ownerRef>,
        })
        .where(eq(executionCommands.id, command.id)),
    ).rejects.toThrow(/immutable/);
    const original = {
      applicationState: command.applicationState,
      completionAppliedAt: command.completionAppliedAt,
    };

    try {
      // Layer 2: put the owner back in its live window and re-arm application.
      // Its own cell is already recorded, so the guard supersedes the replay
      // instead of writing the round a second verdict.
      await database.db
        .update(runs)
        .set({ status: "Running" })
        .where(eq(runs.id, seeded.runId));
      await database.db
        .update(nodeAttempts)
        .set({ status: "Running" })
        .where(eq(nodeAttempts.id, attempt.id));
      await database.db
        .update(executionCommands)
        .set({ applicationState: "pending", completionAppliedAt: null })
        .where(eq(executionCommands.id, command.id));
      const worker = startPromptOwnerWorker({
        db: database.db as unknown as Db,
        owners: flowPromptOwners,
      });

      try {
        await expect
          .poll(
            async () => {
              const [current] = await database.db
                .select({
                  applicationState: executionCommands.applicationState,
                })
                .from(executionCommands)
                .where(eq(executionCommands.id, command.id));

              return current.applicationState;
            },
            { timeout: 60_000, interval: 100 },
          )
          .toBe("superseded");
      } finally {
        await worker.stop();
      }
      const preserved = await database.db
        .select()
        .from(consensusRoundVerdicts)
        .where(eq(consensusRoundVerdicts.nodeAttemptId, attempt.id));

      expect(preserved).toHaveLength(2);
      for (const cell of cells) {
        const current = preserved.find((row) => row.id === cell.id);

        expect(current).toMatchObject({
          verifierKey: cell.verifierKey,
          targetKey: cell.targetKey,
          rawOutputArtifactId: cell.rawOutputArtifactId,
          verdict: cell.verdict,
        });
      }
    } finally {
      await database.db
        .update(executionCommands)
        .set(original)
        .where(eq(executionCommands.id, command.id));
      await database.db
        .update(runs)
        .set({ status: run.status })
        .where(eq(runs.id, seeded.runId));
      await database.db
        .update(nodeAttempts)
        .set({ status: attempt.status })
        .where(eq(nodeAttempts.id, attempt.id));
    }
  }, 180_000);
});
