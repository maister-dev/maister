import type { Db } from "@/lib/execution-host/db";
import type { RealSupervisor } from "@/test-support/real-supervisor";
import type { ProjectionWorker } from "@/lib/execution-host/events/projection-worker";
import type { FlowYamlV1 } from "@/lib/config.schema";

import { randomUUID } from "node:crypto";
import { fork, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  agentTurns,
  artifactInstances,
  consensusRoundVerdicts,
  domainEvents,
  executionCommands,
  flowRevisions,
  flows,
  hitlRequests,
  nodeAttempts,
  runs,
} from "@/lib/db/schema";
import { buildOrchestratorResumeConsumer } from "@/lib/domain-events/orchestrator-resume";
import { startPromptOwnerWorker } from "@/lib/execution-host/prompt-owner-recovery";
import { startAgentContinuationWorker } from "@/lib/agents/continuation-worker";
import { CANONICAL_PROJECTION_CONSUMERS } from "@/lib/execution-host/events/projection-consumers";
import { PromptIncarnationPending } from "@/lib/execution-host/prompt-incarnation";
import { SessionCreatePending } from "@/lib/execution-host/owned-session-create";
import { flowPromptOwners } from "@/lib/flows/graph/prompt-owner";
import { consensusDraftPromptOwners } from "@/lib/flows/graph/consensus/draft-prompt-owner";
import { verifyConsensusInputEvidence } from "@/lib/flows/graph/consensus/input-evidence";
import { recordConsensusVerdict } from "@/lib/flows/graph/consensus/ledger";
import {
  isConsensusHumanIntentApplied,
  markConsensusHumanIntentApplied,
  prepareConsensusHumanIntent,
  resolveConsensusHumanRequest,
} from "@/lib/flows/graph/consensus/human-decision";
import { runFlow } from "@/lib/flows/runner";
import { atomicWriteJson } from "@/lib/atomic";
import { markArtifactsStale } from "@/lib/flows/graph/artifact-store";
import { assertEvidenceReady } from "@/lib/flows/graph/evidence-readiness";
import { decodeConsensusResolutionSchema } from "@/lib/flows/consensus-resolution";
import { validateConsensusDecision } from "@/lib/flows/hitl-validate";
import { startFlowContinuationWorker } from "@/lib/flows/graph/continuation-worker";
import { resumeCrashedRun } from "@/lib/runs/recover";
import { runReconcileSweep } from "@/lib/reconcile";
import { createExecutionHosts } from "@/lib/execution-host/client";
import { canonicalProjectors } from "@/lib/execution-host/events/projection-runtime";
import { startProjectionWorker } from "@/lib/execution-host/events/projection-worker";
import { stopRuntimeEventConsumers } from "@/lib/execution-host/events/consumer";
import { resetRegistrarStateForTests } from "@/lib/execution-host/registrar";
import { resetResolverForTests } from "@/lib/execution-host/resolver";
import { seedGraphRun } from "@/test-support/graph-run-seed";
import { addWorktree, initRepo } from "@/test-support/git-fixture";
import {
  holdChildProjection,
  suppressIncarnations,
} from "@/test-support/projection-hold";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";
import {
  startRealSupervisor,
  useRealSupervisorUrl,
} from "@/test-support/real-supervisor";

// The draft launcher's yields leave no durable trace — a yield is precisely
// "write nothing" — so the cases below observe them at the seams that raise
// them. Each wrapper forwards to the real function unchanged and records, per
// run, how it settled; `until` resolves on the recording itself, not a clock.
const probe = vi.hoisted(() => {
  type Seam = "create" | "admission" | "session";
  const outcomes: Array<{ runId: string; seam: Seam; error: unknown }> = [];
  const waiters = new Set<() => void>();

  return {
    record(runId: string, seam: Seam, error: unknown): void {
      outcomes.push({ runId, seam, error });
      for (const wake of [...waiters]) wake();
    },
    /** Errors `seam` raised for `runId` (a settled session records `null`). */
    of(runId: string, seam: Seam): unknown[] {
      return outcomes
        .filter((outcome) => outcome.runId === runId && outcome.seam === seam)
        .map((outcome) => outcome.error);
    },
    until(predicate: () => boolean, timeoutMs: number): Promise<void> {
      return new Promise((resolve, reject) => {
        const check = (): void => {
          if (!predicate()) return;
          clearTimeout(timer);
          waiters.delete(check);
          resolve();
        };
        const timer = setTimeout(() => {
          waiters.delete(check);
          reject(
            new Error(
              `probe condition not reached in ${timeoutMs} ms; recorded ${JSON.stringify(
                outcomes.map((outcome) => ({
                  runId: outcome.runId,
                  seam: outcome.seam,
                  error:
                    (outcome.error as { details?: { reason?: unknown } } | null)
                      ?.details?.reason ?? String(outcome.error),
                })),
              )}`,
            ),
          );
        }, timeoutMs);

        waiters.add(check);
        check();
      });
    },
  };
});

vi.mock("@/lib/execution-host/owned-session-create", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/lib/execution-host/owned-session-create")
    >();

  return {
    ...actual,
    createOwnedSession: async (
      input: Parameters<typeof actual.createOwnedSession>[0],
    ) => {
      try {
        return await actual.createOwnedSession(input);
      } catch (error) {
        probe.record(input.client.assignment.runId, "create", error);
        throw error;
      }
    },
  };
});

vi.mock("@/lib/execution-host/prompt-incarnation", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/lib/execution-host/prompt-incarnation")
    >();

  return {
    ...actual,
    waitForPromptIncarnation: async (
      ...args: Parameters<typeof actual.waitForPromptIncarnation>
    ) => {
      try {
        return await actual.waitForPromptIncarnation(...args);
      } catch (error) {
        probe.record(args[1].assignment.runId, "admission", error);
        throw error;
      }
    },
  };
});

vi.mock("@/lib/agents/launch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/agents/launch")>();

  return {
    ...actual,
    startAgentSession: async (
      ...args: Parameters<typeof actual.startAgentSession>
    ) => {
      try {
        const result = await actual.startAgentSession(...args);

        probe.record(args[0], "session", null);

        return result;
      } catch (error) {
        probe.record(args[0], "session", error);
        throw error;
      }
    },
  };
});

let database: StartedPostgresTestDb;
let supervisor: RealSupervisor;
let worker: ProjectionWorker;
let restoreUrl: () => void = () => {};
let originalFlowCap: string | undefined;

beforeAll(async () => {
  // Every case seeds its own project and leaves its parent parked; the global
  // flow cap is not under test here and would defer later cases' wakes.
  originalFlowCap = process.env.MAISTER_MAX_CONCURRENT_RUNS;
  process.env.MAISTER_MAX_CONCURRENT_RUNS = "64";
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
  if (originalFlowCap === undefined)
    delete process.env.MAISTER_MAX_CONCURRENT_RUNS;
  else process.env.MAISTER_MAX_CONCURRENT_RUNS = originalFlowCap;
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

async function seedConsensusFlow(
  prompt: string,
  rounds: { mode: "single_pass" | "iterate"; max: number } = {
    mode: "single_pass",
    max: 1,
  },
) {
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
      rounds,
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

async function replaceConsensusPrompt(
  flowRevisionId: string,
  flowId: string,
  prompt: string,
): Promise<void> {
  const [revision] = await database.db
    .select({ manifest: flowRevisions.manifest })
    .from(flowRevisions)
    .where(eq(flowRevisions.id, flowRevisionId));
  const manifest = structuredClone(revision.manifest) as {
    nodes: Array<{ prompt: string }>;
  };

  manifest.nodes[0].prompt = prompt;
  await database.db
    .update(flowRevisions)
    .set({ manifest })
    .where(eq(flowRevisions.id, flowRevisionId));
  await database.db.update(flows).set({ manifest }).where(eq(flows.id, flowId));
}

function drive(runId: string): Promise<unknown> {
  return runFlow(runId, {
    db: database.db,
    runtimeRoot: supervisor.runtimeRoot,
    executionHosts: createExecutionHosts({ db: database.db as unknown as Db }),
  });
}

async function waitForDraftsDone(parentRunId: string): Promise<void> {
  await expect
    .poll(
      async () => {
        const children = await database.db
          .select({ status: runs.status })
          .from(runs)
          .where(eq(runs.parentRunId, parentRunId));

        return (
          children.length === 2 &&
          children.every((child) => child.status === "Done")
        );
      },
      { timeout: 60_000, interval: 100 },
    )
    .toBe(true);
}

/** A BEFORE INSERT trigger with the given plpgsql body; returns its remover. */
async function installInsertTrigger(
  table: string,
  body: string,
): Promise<() => Promise<void>> {
  const trigger = `consensus_trigger_${randomUUID().replaceAll("-", "")}`;

  await database.pool.query(
    `CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ${body} END $$`,
  );
  await database.pool.query(
    `CREATE TRIGGER ${trigger} BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION ${trigger}()`,
  );

  return async () => {
    await database.pool.query(`DROP TRIGGER IF EXISTS ${trigger} ON ${table}`);
    await database.pool.query(`DROP FUNCTION IF EXISTS ${trigger}()`);
  };
}

/** Round 1 fans out real child agent runs. Wake the parent exactly the way the
 * production domain-event dispatcher does once every draft is terminal. */
async function settleDraftsAndResume(
  parentRunId: string,
  status: "Done" | "Failed" = "Done",
  nodeAttemptId?: string,
  round = 1,
): Promise<void> {
  const matchingChildren = async () =>
    (
      await database.db
        .select({
          id: runs.id,
          status: runs.status,
          triggerPayload: runs.triggerPayload,
        })
        .from(runs)
        .where(eq(runs.parentRunId, parentRunId))
    ).filter(
      (child) =>
        (
          child.triggerPayload as {
            nodeAttemptId?: string;
            round?: number;
          } | null
        )?.round === round &&
        (!nodeAttemptId ||
          (child.triggerPayload as { nodeAttemptId?: string } | null)
            ?.nodeAttemptId === nodeAttemptId),
    );

  try {
    await expect
      .poll(
        async () => {
          const children = await matchingChildren();

          return children.length === 2 &&
            children.every((child) => child.status === status)
            ? children.length
            : 0;
        },
        { timeout: 60_000, interval: 100 },
      )
      .toBe(2);
  } catch (error) {
    const children = await matchingChildren();

    throw new Error(
      `draft settlement for ${parentRunId}: ${JSON.stringify(children.map(({ id, status: childStatus, triggerPayload }) => ({ id, status: childStatus, triggerPayload })))}`,
      { cause: error },
    );
  }
  const childIds = (await matchingChildren()).map((child) => child.id);
  const events = await database.db
    .select()
    .from(domainEvents)
    .where(
      and(
        eq(domainEvents.kind, status === "Done" ? "run.done" : "run.failed"),
        inArray(domainEvents.runId, childIds),
      ),
    );
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

/** Force the prompt-admission timeout window for every draft child of
 * `parentRunId`: their incarnation inserts are dropped (and counted, so the
 * re-drive cadence is observable), and their lifecycle cursor is pre-claimed so
 * the projector cannot run into the dropped row. Release restores both. */
async function holdChildAdmission(parentRunId: string) {
  const incarnations = await suppressIncarnations(database.pool, {
    parentRunId,
  });
  const releaseProjection = await holdChildProjection(database.pool, {
    consumerName: CANONICAL_PROJECTION_CONSUMERS.lifecycle,
    parentRunId,
  });

  return {
    recentAttempts: incarnations.recentAttempts,
    async release(): Promise<void> {
      await incarnations.release();
      await releaseProjection();
    },
  };
}

async function childRuns(parentRunId: string) {
  return database.db
    .select({ id: runs.id, status: runs.status })
    .from(runs)
    .where(eq(runs.parentRunId, parentRunId));
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
  it("P0-5: delayed verifier application keeps the node live until owner recovery", async () => {
    const seeded = await seedConsensusFlow(consensusPrompt("agree"));

    await drive(seeded.runId);
    await waitForDraftsDone(seeded.runId);
    const dropTrigger = await installInsertTrigger(
      "consensus_round_verdicts",
      "RAISE EXCEPTION 'held consensus verifier application';",
    );

    const resuming = settleDraftsAndResume(seeded.runId);
    let resumeOutcome: "pending" | "fulfilled" | "rejected" = "pending";

    void resuming.then(
      () => {
        resumeOutcome = "fulfilled";
      },
      () => {
        resumeOutcome = "rejected";
      },
    );

    try {
      await expect
        .poll(
          async () => {
            const commands = await database.db
              .select()
              .from(executionCommands)
              .where(
                and(
                  eq(executionCommands.runId, seeded.runId),
                  eq(executionCommands.kind, "session.prompt"),
                ),
              );

            return commands.some(
              (command) =>
                (command.ownerRef as { variant?: string } | null)?.variant ===
                  "consensus_verifier" &&
                command.applicationAttempts >= 1 &&
                command.applicationState !== "applied",
            );
          },
          { timeout: 30_000, interval: 100 },
        )
        .toBe(true);
      // The driver has yielded (its traversal returned) before the node state
      // is read: a pending application leaves it Running, never Failed.
      await expect
        .poll(() => resumeOutcome, { timeout: 10_000, interval: 100 })
        .toBe("fulfilled");
      const [run] = await database.db
        .select({ status: runs.status })
        .from(runs)
        .where(eq(runs.id, seeded.runId));
      const [attempt] = await database.db
        .select({ status: nodeAttempts.status })
        .from(nodeAttempts)
        .where(eq(nodeAttempts.runId, seeded.runId));

      expect(run.status).toBe("Running");
      expect(attempt.status).toBe("Running");
    } finally {
      await dropTrigger();
    }

    const owners = startPromptOwnerWorker({
      db: database.db as unknown as Db,
      owners: flowPromptOwners,
    });
    const continuation = startFlowContinuationWorker({
      db: database.db as unknown as Db,
      runtimeRoot: supervisor.runtimeRoot,
      executionHosts: createExecutionHosts({
        db: database.db as unknown as Db,
      }),
    });

    try {
      await resuming;
      await expect
        .poll(
          async () => {
            const [run] = await database.db
              .select({ status: runs.status })
              .from(runs)
              .where(eq(runs.id, seeded.runId));

            return run.status;
          },
          { timeout: 60_000, interval: 100 },
        )
        .toBe("Review");
      const verifierCommands = await database.db
        .select({ ownerRef: executionCommands.ownerRef })
        .from(executionCommands)
        .where(eq(executionCommands.runId, seeded.runId));

      expect(
        verifierCommands.filter(
          (command) =>
            (command.ownerRef as { variant?: string } | null)?.variant ===
            "consensus_verifier",
        ),
      ).toHaveLength(2);
      const liveSessions = await createExecutionHosts({
        db: database.db as unknown as Db,
      })
        .local()
        .listSessions();

      expect(
        liveSessions.filter(
          (session) =>
            session.runId === seeded.runId && session.status === "live",
        ),
      ).toHaveLength(0);
    } finally {
      await continuation.stop();
      await owners.stop();
    }
  }, 180_000);
  it("P0-5: delayed synthesis application yields and resumes through the owner workers", async () => {
    const seeded = await seedConsensusFlow(consensusPrompt("agree"));

    await drive(seeded.runId);
    await waitForDraftsDone(seeded.runId);
    const dropTrigger = await installInsertTrigger(
      "artifact_instances",
      "IF NEW.id LIKE '%:consensus-synthesis:%' AND NEW.id NOT LIKE '%:input' THEN RAISE EXCEPTION 'held consensus synthesis application'; END IF; RETURN NEW;",
    );
    const resuming = settleDraftsAndResume(seeded.runId);
    let resumeOutcome: "pending" | "fulfilled" | "rejected" = "pending";

    void resuming.then(
      () => {
        resumeOutcome = "fulfilled";
      },
      () => {
        resumeOutcome = "rejected";
      },
    );

    try {
      await expect
        .poll(
          async () => {
            const commands = await database.db
              .select()
              .from(executionCommands)
              .where(eq(executionCommands.runId, seeded.runId));

            return commands.some(
              (command) =>
                (command.ownerRef as { variant?: string } | null)?.variant ===
                  "consensus_synthesis" &&
                command.applicationAttempts >= 1 &&
                command.applicationState !== "applied",
            );
          },
          { timeout: 30_000, interval: 100 },
        )
        .toBe(true);
      // The driver has yielded (its traversal returned) before the node state
      // is read: a pending application leaves it Running, never Failed.
      await expect
        .poll(() => resumeOutcome, { timeout: 10_000, interval: 100 })
        .toBe("fulfilled");
      const [run] = await database.db
        .select({ status: runs.status })
        .from(runs)
        .where(eq(runs.id, seeded.runId));
      const [attempt] = await database.db
        .select({ status: nodeAttempts.status })
        .from(nodeAttempts)
        .where(eq(nodeAttempts.runId, seeded.runId));

      expect(run.status).toBe("Running");
      expect(attempt.status).toBe("Running");
    } finally {
      await dropTrigger();
    }

    const owners = startPromptOwnerWorker({
      db: database.db as unknown as Db,
      owners: flowPromptOwners,
    });
    const continuation = startFlowContinuationWorker({
      db: database.db as unknown as Db,
      runtimeRoot: supervisor.runtimeRoot,
      executionHosts: createExecutionHosts({
        db: database.db as unknown as Db,
      }),
    });

    try {
      await resuming;
      await expect
        .poll(
          async () => {
            const [run] = await database.db
              .select({ status: runs.status })
              .from(runs)
              .where(eq(runs.id, seeded.runId));

            return run.status;
          },
          { timeout: 60_000, interval: 100 },
        )
        .toBe("Review");
      const synthesisCommands = await database.db
        .select({ ownerRef: executionCommands.ownerRef })
        .from(executionCommands)
        .where(eq(executionCommands.runId, seeded.runId));

      expect(
        synthesisCommands.filter(
          (command) =>
            (command.ownerRef as { variant?: string } | null)?.variant ===
            "consensus_synthesis",
        ),
      ).toHaveLength(1);
      const liveSessions = await createExecutionHosts({
        db: database.db as unknown as Db,
      })
        .local()
        .listSessions();

      expect(
        liveSessions.filter(
          (session) =>
            session.runId === seeded.runId && session.status === "live",
        ),
      ).toHaveLength(0);
    } finally {
      await continuation.stop();
      await owners.stop();
    }
  }, 180_000);
  it("P0-5: poisoned verifier application ends in owner-poisoned crash", async () => {
    const seeded = await seedConsensusFlow(consensusPrompt("agree"));

    await drive(seeded.runId);
    const dropTrigger = await installInsertTrigger(
      "consensus_round_verdicts",
      "RAISE EXCEPTION 'poison consensus verifier application';",
    );

    const resuming = settleDraftsAndResume(seeded.runId);
    const owners = startPromptOwnerWorker({
      db: database.db as unknown as Db,
      owners: flowPromptOwners,
    });

    try {
      await expect
        .poll(
          async () => {
            const commands = await database.db
              .select()
              .from(executionCommands)
              .where(
                and(
                  eq(executionCommands.runId, seeded.runId),
                  eq(executionCommands.kind, "session.prompt"),
                ),
              );
            const verifier = commands.find(
              (command) =>
                (command.ownerRef as { variant?: string } | null)?.variant ===
                "consensus_verifier",
            );

            return verifier?.applicationAttempts ?? 0;
          },
          { timeout: 30_000, interval: 100 },
        )
        .toBeGreaterThan(0);

      for (let attempt = 1; attempt < 5; attempt += 1) {
        await database.db
          .update(executionCommands)
          .set({ applicationNextRetryAt: sql`clock_timestamp()` })
          .where(
            and(
              eq(executionCommands.runId, seeded.runId),
              eq(executionCommands.applicationState, "pending"),
            ),
          );
        await expect
          .poll(
            async () => {
              const commands = await database.db
                .select({ attempts: executionCommands.applicationAttempts })
                .from(executionCommands)
                .where(
                  and(
                    eq(executionCommands.runId, seeded.runId),
                    eq(executionCommands.kind, "session.prompt"),
                    sql`${executionCommands.ownerRef}->>'variant' = 'consensus_verifier'`,
                  ),
                );

              return Math.max(
                0,
                ...commands.map((command) => command.attempts),
              );
            },
            { timeout: 30_000, interval: 100 },
          )
          .toBeGreaterThan(attempt);
      }

      await resuming;
      const commands = await database.db
        .select()
        .from(executionCommands)
        .where(eq(executionCommands.runId, seeded.runId));

      expect(
        commands.some(
          (command) =>
            (command.ownerRef as { variant?: string } | null)?.variant ===
              "consensus_verifier" &&
            command.applicationState === "poisoned" &&
            command.applicationAttempts === 5,
        ),
      ).toBe(true);
      await runReconcileSweep({
        db: database.db,
        executionHosts: createExecutionHosts({
          db: database.db as unknown as Db,
        }),
      });
      const [run] = await database.db
        .select({ status: runs.status })
        .from(runs)
        .where(eq(runs.id, seeded.runId));

      const crashed = await database.db
        .select({ payload: domainEvents.payload })
        .from(domainEvents)
        .where(
          and(
            eq(domainEvents.runId, seeded.runId),
            eq(domainEvents.kind, "run.crashed"),
          ),
        );

      expect(run.status).toBe("Crashed");
      expect(
        crashed.map((event) => (event.payload as { reason?: string }).reason),
      ).toEqual(["owner-poisoned"]);
    } finally {
      await owners.stop();
      await dropTrigger();
    }
  }, 180_000);
  it("P0-5: a consensus command quarantined after application crashes owner-poisoned", async () => {
    const seeded = await seedConsensusFlow(consensusPrompt("disagree"));

    await drive(seeded.runId);
    await settleDraftsAndResume(seeded.runId);
    const [attempt] = await database.db
      .select()
      .from(nodeAttempts)
      .where(eq(nodeAttempts.runId, seeded.runId));
    const [verifier] = await database.db
      .select()
      .from(executionCommands)
      .where(
        and(
          eq(executionCommands.runId, seeded.runId),
          sql`${executionCommands.ownerRef}->>'variant' = 'consensus_verifier'`,
        ),
      );

    expect(verifier.applicationState).toBe("applied");
    // `quarantine()` keeps a conflict found AFTER application `applied` and
    // records only the reason; the node is back in its live window.
    await database.db
      .update(executionCommands)
      .set({
        applicationError: {
          reason: "prompt_terminal_conflict",
          phase: "prepare",
          causeCode: "terminal_evidence_mismatch",
        },
      })
      .where(eq(executionCommands.id, verifier.id));
    await database.db
      .update(runs)
      .set({ status: "Running" })
      .where(eq(runs.id, seeded.runId));
    await database.db
      .update(nodeAttempts)
      .set({ status: "Running" })
      .where(eq(nodeAttempts.id, attempt.id));
    await runReconcileSweep({
      db: database.db,
      executionHosts: createExecutionHosts({
        db: database.db as unknown as Db,
      }),
    });
    const [run] = await database.db
      .select({ status: runs.status })
      .from(runs)
      .where(eq(runs.id, seeded.runId));
    const crashed = await database.db
      .select({ payload: domainEvents.payload })
      .from(domainEvents)
      .where(
        and(
          eq(domainEvents.runId, seeded.runId),
          eq(domainEvents.kind, "run.crashed"),
        ),
      );

    expect(run.status).toBe("Crashed");
    expect(
      crashed.map((event) => (event.payload as { reason?: string }).reason),
    ).toEqual(["owner-poisoned"]);
  }, 180_000);
  it("P0-5: full 60 kB drafts and verbose verifier JSON survive owner application", async () => {
    const tail = "DRAFT-LAST-LINE-P0-5";
    const verdict = `${"reasoning ".repeat(4_000)}${verdictJson("agree")}`;
    const draftBody = `fixture-output:${JSON.stringify({ bytes: 0, text: verdict })}\n${"d".repeat(18_000)}\n${tail}`;
    const prompt = `fixture-output:${JSON.stringify({ bytes: 0, text: draftBody })}`;
    const seeded = await seedConsensusFlow(prompt);

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
    const commands = await database.db
      .select()
      .from(executionCommands)
      .where(
        and(
          eq(executionCommands.runId, seeded.runId),
          eq(executionCommands.kind, "session.prompt"),
        ),
      );

    expect(verdicts).toHaveLength(2);
    expect(verdicts.every((cell) => cell.verdict === "agree")).toBe(true);
    for (const cell of verdicts) {
      const command = commands.find(
        (row) =>
          (row.ownerRef as { verdictId?: string } | null)?.verdictId ===
          cell.id,
      );

      expect(command?.requestCanonicalJson).toContain(tail);
    }
  }, 180_000);
  it("P0-5: verifier output past 1 MiB is technical even with valid trailing JSON", async () => {
    const body = `fixture-output:${JSON.stringify({ bytes: 1024 * 1024 + 1, text: verdictJson("agree"), chunkSize: 131_071 })}`;
    const seeded = await seedConsensusFlow(
      `fixture-output:${JSON.stringify({ bytes: 0, text: body })}`,
    );

    await drive(seeded.runId);
    await settleDraftsAndResume(seeded.runId);
    const [attempt] = await database.db
      .select({ id: nodeAttempts.id })
      .from(nodeAttempts)
      .where(eq(nodeAttempts.runId, seeded.runId));
    const cells = await database.db
      .select()
      .from(consensusRoundVerdicts)
      .where(eq(consensusRoundVerdicts.nodeAttemptId, attempt.id));

    expect(cells).toHaveLength(2);
    expect(
      cells.every((cell) => cell.errorCode === "output_cap_exceeded"),
    ).toBe(true);
    expect(cells.every((cell) => cell.verdict === "disagree")).toBe(true);
  }, 180_000);
  it("P0-5: max_tokens drafts remain partial evidence and cost no verifier turn", async () => {
    const body = "An unfinished but useful draft";
    const prompt = `fixture-output:${JSON.stringify({ bytes: 0, text: body, stopReason: "max_tokens" })}`;
    const seeded = await seedConsensusFlow(prompt);

    await drive(seeded.runId);
    await settleDraftsAndResume(seeded.runId, "Failed");
    const [attempt] = await database.db
      .select()
      .from(nodeAttempts)
      .where(eq(nodeAttempts.runId, seeded.runId));
    const [run] = await database.db
      .select({ status: runs.status })
      .from(runs)
      .where(eq(runs.id, seeded.runId));
    const children = await database.db
      .select()
      .from(runs)
      .where(eq(runs.parentRunId, seeded.runId));
    const verdicts = await database.db
      .select()
      .from(consensusRoundVerdicts)
      .where(eq(consensusRoundVerdicts.nodeAttemptId, attempt.id));
    const verifierCommands = await database.db
      .select()
      .from(executionCommands)
      .where(
        and(
          eq(executionCommands.runId, seeded.runId),
          eq(executionCommands.kind, "session.prompt"),
        ),
      );

    expect(run.status).toBe("NeedsInput");
    expect(verdicts).toHaveLength(2);
    expect(verdicts.every((cell) => cell.errorCode === "draft_partial")).toBe(
      true,
    );
    expect(verifierCommands).toHaveLength(0);
    for (const child of children) {
      const payload = child.triggerPayload as { participantId: string };
      const [artifact] = await database.db
        .select()
        .from(artifactInstances)
        .where(
          eq(
            artifactInstances.id,
            `run:${child.id}:consensus-draft:${attempt.id}:${payload.participantId}:r1`,
          ),
        );

      expect(artifact?.locator).toMatchObject({
        kind: "inline",
        text: body,
        partial: true,
        stopReason: "max_tokens",
      });
    }
  }, 180_000);
  it("P0-5: all-partial drafts spend a drafter round instead of reporting no text", async () => {
    const prompt = `fixture-output:${JSON.stringify({ bytes: 0, text: "partial plan", stopReason: "max_tokens" })}`;
    const seeded = await seedConsensusFlow(prompt, { mode: "iterate", max: 2 });

    await drive(seeded.runId);
    await settleDraftsAndResume(seeded.runId, "Failed");
    await expect
      .poll(
        async () => {
          const children = await database.db
            .select({ triggerPayload: runs.triggerPayload })
            .from(runs)
            .where(eq(runs.parentRunId, seeded.runId));

          return children.filter(
            (child) =>
              (child.triggerPayload as { round?: number } | null)?.round === 2,
          ).length;
        },
        { timeout: 30_000, interval: 100 },
      )
      .toBe(2);
    const [attempt] = await database.db
      .select({ id: nodeAttempts.id })
      .from(nodeAttempts)
      .where(eq(nodeAttempts.runId, seeded.runId));
    const roundOneCells = await database.db
      .select()
      .from(consensusRoundVerdicts)
      .where(
        and(
          eq(consensusRoundVerdicts.nodeAttemptId, attempt.id),
          eq(consensusRoundVerdicts.round, 1),
        ),
      );
    const requests = await database.db
      .select({ id: hitlRequests.id })
      .from(hitlRequests)
      .where(eq(hitlRequests.runId, seeded.runId));

    expect(roundOneCells).toHaveLength(2);
    expect(
      roundOneCells.every((cell) => cell.errorCode === "draft_partial"),
    ).toBe(true);
    expect(requests).toHaveLength(0);
    await settleDraftsAndResume(seeded.runId, "Failed", attempt.id, 2);
    await expect
      .poll(
        async () => {
          const [run] = await database.db
            .select({ status: runs.status })
            .from(runs)
            .where(eq(runs.id, seeded.runId));

          return run.status;
        },
        { timeout: 30_000, interval: 100 },
      )
      .toBe("NeedsInput");
  }, 180_000);
  it("P0-5: over-bound target is labeled in the verdict and debate stays JSON", async () => {
    const body = `fixture-output:${JSON.stringify({ bytes: 0, text: verdictJson("agree") })}\n${"z".repeat(70_000)}`;
    const seeded = await seedConsensusFlow(
      `fixture-output:${JSON.stringify({ bytes: 0, text: body })}`,
    );

    await drive(seeded.runId);
    await settleDraftsAndResume(seeded.runId);
    const [attempt] = await database.db
      .select()
      .from(nodeAttempts)
      .where(eq(nodeAttempts.runId, seeded.runId));
    const cells = await database.db
      .select()
      .from(consensusRoundVerdicts)
      .where(eq(consensusRoundVerdicts.nodeAttemptId, attempt.id));
    const commands = await database.db
      .select()
      .from(executionCommands)
      .where(
        and(
          eq(executionCommands.runId, seeded.runId),
          eq(executionCommands.kind, "session.prompt"),
        ),
      );
    const [debate] = await database.db
      .select()
      .from(artifactInstances)
      .where(eq(artifactInstances.id, `run:${attempt.id}:debate_log`));

    expect(cells).toHaveLength(2);
    for (const cell of cells) {
      expect(cell.verdict).toBe("agree");
      expect(cell.disagreements).toMatchObject({
        version: 1,
        truncated: true,
        textBounds: expect.objectContaining({ cap: 65_536 }),
      });
      const command = commands.find(
        (row) =>
          (row.ownerRef as { verdictId?: string } | null)?.verdictId ===
          cell.id,
      );

      expect(command?.requestCanonicalJson).toContain(
        "consensus text truncated: dropped",
      );
    }
    const synthesisCommand = commands.find(
      (row) =>
        (row.ownerRef as { variant?: string } | null)?.variant ===
        "consensus_synthesis",
    );
    const [synthesis] = await database.db
      .select()
      .from(artifactInstances)
      .where(
        eq(
          artifactInstances.id,
          `run:${attempt.id}:consensus-synthesis:r1:consensus`,
        ),
      );

    expect(synthesisCommand?.requestCanonicalJson).toContain(
      "consensus text truncated: dropped",
    );
    expect(synthesis.locator).toMatchObject({
      truncated: true,
      inputTextBounds: { cap: 65_536 },
    });
    const synthesisId = `run:${attempt.id}:consensus-synthesis:r1:consensus`;
    const [prepared] = await database.db
      .select()
      .from(artifactInstances)
      .where(eq(artifactInstances.id, `${synthesisId}:input`));
    const expectedOwner = {
      generationId: synthesisId,
      nodeAttemptId: attempt.id,
      round: 1,
      role: "synthesis" as const,
    };

    expect(
      await verifyConsensusInputEvidence(
        database.db as unknown as Db,
        synthesisCommand!,
        expectedOwner,
      ),
    ).toMatchObject({ textBounds: { droppedBytes: expect.any(Number) } });
    if (prepared.locator.kind !== "inline")
      throw new Error("consensus input evidence must be inline");
    const originalLocator = prepared.locator;
    const forged = JSON.parse(originalLocator.text) as Record<string, unknown>;

    await database.db
      .update(artifactInstances)
      .set({
        locator: {
          kind: "inline",
          text: JSON.stringify({ ...forged, valueSha256: "0".repeat(64) }),
        },
      })
      .where(eq(artifactInstances.id, prepared.id));
    await expect(
      verifyConsensusInputEvidence(
        database.db as unknown as Db,
        synthesisCommand!,
        expectedOwner,
      ),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      details: { causeCode: "consensus_input_request_mismatch" },
    });
    await database.db
      .update(artifactInstances)
      .set({ locator: originalLocator })
      .where(eq(artifactInstances.id, prepared.id));
    await database.db
      .update(artifactInstances)
      .set({
        locator: {
          kind: "inline",
          text: JSON.stringify({ ...forged, valueSpan: undefined }),
        },
      })
      .where(eq(artifactInstances.id, prepared.id));
    await expect(
      verifyConsensusInputEvidence(
        database.db as unknown as Db,
        synthesisCommand!,
        expectedOwner,
      ),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      details: { causeCode: "consensus_input_evidence_schema" },
    });
    await database.db
      .update(artifactInstances)
      .set({ locator: originalLocator })
      .where(eq(artifactInstances.id, prepared.id));
    expect(() =>
      JSON.parse((debate.locator as { text: string }).text),
    ).not.toThrow();
  }, 180_000);
  it("P0-5: HITL commits a round debate artifact and partial-safe choices together", async () => {
    const seeded = await seedConsensusFlow(consensusPrompt("disagree"));

    await drive(seeded.runId);
    await settleDraftsAndResume(seeded.runId);
    const [attempt] = await database.db
      .select()
      .from(nodeAttempts)
      .where(eq(nodeAttempts.runId, seeded.runId));
    const [request] = await database.db
      .select()
      .from(hitlRequests)
      .where(
        and(
          eq(hitlRequests.runId, seeded.runId),
          eq(hitlRequests.stepId, "decide"),
        ),
      );
    const hitlSchema = request?.schema as {
      nodeAttemptId: string;
      debateLog: { artifactRef: string; artifactRunId: string };
      drafts: Array<{ artifactRef: string; artifactRunId: string }>;
    };
    const [debate] = await database.db
      .select()
      .from(artifactInstances)
      .where(eq(artifactInstances.id, hitlSchema.debateLog.artifactRef));

    expect(request).toBeDefined();
    expect(hitlSchema.nodeAttemptId).toBe(attempt.id);
    expect(hitlSchema.debateLog.artifactRunId).toBe(seeded.runId);
    expect(debate?.locator.kind).toBe("inline");
    expect(() =>
      JSON.parse((debate.locator as { text: string }).text),
    ).not.toThrow();
    expect(hitlSchema.drafts).toHaveLength(2);
    expect(
      hitlSchema.drafts.every((draft) => draft.artifactRunId !== seeded.runId),
    ).toBe(true);
    await database.db
      .update(hitlRequests)
      .set({
        response: { decision: "re-run-round" },
        respondedAt: new Date(),
      })
      .where(eq(hitlRequests.id, request.id));
    await database.db
      .update(runs)
      .set({ status: "Running" })
      .where(eq(runs.id, seeded.runId));
    await database.db
      .update(nodeAttempts)
      .set({ status: "Running" })
      .where(eq(nodeAttempts.id, attempt.id));
    const source = await resolveConsensusHumanRequest(
      database.db as unknown as Db,
      {
        runId: seeded.runId,
        nodeId: "decide",
        nodeAttemptId: attempt.id,
        decision: "re-run-round",
      },
    );
    const intent = await prepareConsensusHumanIntent(
      database.db as unknown as Db,
      {
        runId: seeded.runId,
        nodeId: "decide",
        nodeAttemptId: attempt.id,
        attempt: attempt.attempt,
        ...source,
      },
    );

    expect(intent).toMatchObject({
      hitlRequestId: request.id,
      sourceRound: 1,
      targetRound: 2,
    });
    expect(
      await prepareConsensusHumanIntent(database.db as unknown as Db, {
        runId: seeded.runId,
        nodeId: "decide",
        nodeAttemptId: attempt.id,
        attempt: attempt.attempt,
        ...source,
      }),
    ).toEqual(intent);
    await expect(
      prepareConsensusHumanIntent(database.db as unknown as Db, {
        runId: seeded.runId,
        nodeId: "decide",
        nodeAttemptId: attempt.id,
        attempt: attempt.attempt,
        ...source,
        responseDigest: "changed-response",
      }),
    ).rejects.toThrow("intent changed on replay");
    await markConsensusHumanIntentApplied(database.db as unknown as Db, {
      runId: seeded.runId,
      nodeId: "decide",
      attempt: attempt.attempt,
      intent,
    });
    expect(
      await isConsensusHumanIntentApplied(database.db as unknown as Db, intent),
    ).toBe(true);
  }, 180_000);
  async function consensusRequests(runId: string) {
    return database.db
      .select()
      .from(hitlRequests)
      .where(
        and(eq(hitlRequests.runId, runId), eq(hitlRequests.stepId, "decide")),
      );
  }

  it("P0-5: a HITL creation replayed after its commit adopts the same request and evidence", async () => {
    // Partial drafts record unpaid fail-closed cells, whose axes the writer
    // builds in manifest order and jsonb returns in storage order.
    const prompt = `fixture-output:${JSON.stringify({ bytes: 0, text: "An unfinished draft", stopReason: "max_tokens" })}`;
    const seeded = await seedConsensusFlow(prompt);

    await drive(seeded.runId);
    await settleDraftsAndResume(seeded.runId, "Failed");
    const [attempt] = await database.db
      .select()
      .from(nodeAttempts)
      .where(eq(nodeAttempts.runId, seeded.runId));
    const before = await consensusRequests(seeded.runId);
    const debate = async () =>
      database.db
        .select()
        .from(artifactInstances)
        .where(
          and(
            eq(artifactInstances.runId, seeded.runId),
            eq(artifactInstances.artifactDefId, "consensus-round-debate"),
          ),
        );
    const [debateBefore] = await debate();
    const schema = decodeConsensusResolutionSchema(before[0]?.schema);

    expect(before).toHaveLength(1);
    expect(schema).toMatchObject({
      escalationReason: "single_pass",
      nodeAttemptId: attempt.id,
    });
    expect(schema?.drafts.map((draft) => draft.classification)).toEqual([
      "partial",
      "partial",
    ]);
    expect(
      validateConsensusDecision({ decision: "pick-draft-1" }, before[0].schema)
        .ok,
    ).toBe(true);
    expect(debateBefore.requiredFor ?? []).not.toContain("review");

    // Death after the HITL transaction committed but before the runner parked
    // the node: the run and attempt are still the Running pair it re-enters.
    await database.db
      .update(runs)
      .set({ status: "Running" })
      .where(eq(runs.id, seeded.runId));
    await database.db
      .update(nodeAttempts)
      .set({ status: "Running" })
      .where(eq(nodeAttempts.id, attempt.id));
    await drive(seeded.runId);
    const after = await consensusRequests(seeded.runId);
    const [run] = await database.db
      .select({ status: runs.status })
      .from(runs)
      .where(eq(runs.id, seeded.runId));
    const debates = await debate();

    expect(run.status).toBe("NeedsInput");
    expect(after.map((request) => request.id)).toEqual(
      before.map((request) => request.id),
    );
    expect(debates).toHaveLength(1);
    expect(debates[0].locator).toEqual(debateBefore.locator);

    // Answered and consumed, then a death before the node settled: re-entry
    // must ask again rather than park on a request nobody can answer.
    await database.db
      .update(hitlRequests)
      .set({ response: { decision: "abort" }, respondedAt: new Date() })
      .where(eq(hitlRequests.id, before[0].id));
    await database.db
      .update(runs)
      .set({ status: "Running" })
      .where(eq(runs.id, seeded.runId));
    await database.db
      .update(nodeAttempts)
      .set({ status: "Running" })
      .where(eq(nodeAttempts.id, attempt.id));
    await drive(seeded.runId);
    const reasked = await consensusRequests(seeded.runId);

    expect(reasked).toHaveLength(2);
    expect(
      reasked.filter((request) => request.respondedAt === null),
    ).toHaveLength(1);

    // A rework stales the node's evidence; the HITL-only debate must not then
    // stand as a required-but-missing review deliverable.
    await markArtifactsStale(seeded.runId, ["decide"], database.db);
    const readiness = await assertEvidenceReady(
      seeded.runId,
      "review",
      database.db,
    );

    expect(readiness.reasons.join("\n")).not.toContain(
      "consensus-round-debate",
    );
  }, 180_000);
  it("P0-5: HITL disagreement summaries stay bounded after whole-output parsing", async () => {
    const verdict = JSON.stringify({
      verdict: "disagree",
      axes: { scope: false, risk: true },
      disagreements: [
        {
          axis: "scope",
          claim: `${"c".repeat(3_000)}CLAIM-TAIL`,
          counter_evidence: "see the draft",
        },
      ],
      confidence: 0.5,
    });
    const draftBody = `\nfixture-output:${JSON.stringify({ bytes: 0, text: verdict })}`;
    const seeded = await seedConsensusFlow(
      `fixture-output:${JSON.stringify({ bytes: 0, text: draftBody })}`,
    );

    await drive(seeded.runId);
    await settleDraftsAndResume(seeded.runId);
    const [request] = await consensusRequests(seeded.runId);
    const summaries = decodeConsensusResolutionSchema(
      request.schema,
    )?.disagreements.map((row) => row.summary ?? "");

    expect(summaries?.length).toBeGreaterThan(0);
    for (const summary of summaries ?? []) {
      expect(Buffer.byteLength(summary, "utf8")).toBeLessThanOrEqual(1024);
      expect(summary).not.toContain("CLAIM-TAIL");
      expect(summary).toContain("cap 1024 bytes]");
    }
  }, 180_000);
  it("P0-5: a rerun that dies before its applied marker adopts its round on replay", async () => {
    const draftBody = `\nfixture-output:${JSON.stringify({ bytes: 0, text: "not-json" })}`;
    const seeded = await seedConsensusFlow(
      `fixture-output:${JSON.stringify({ bytes: 0, text: draftBody })}`,
      { mode: "iterate", max: 2 },
    );

    await drive(seeded.runId);
    await settleDraftsAndResume(seeded.runId);
    const [request] = await consensusRequests(seeded.runId);
    const inputPath = path.join(
      supervisor.runtimeRoot,
      ".maister",
      seeded.slug,
      "runs",
      seeded.runId,
      "input-decide.json",
    );

    expect(
      decodeConsensusResolutionSchema(request.schema)?.escalationReason,
    ).toBe("technical_only");
    // The respond route's durable writes: the input artifact, then the stamp.
    await atomicWriteJson(inputPath, { decision: "re-run-round" });
    await database.db
      .update(hitlRequests)
      .set({ response: { decision: "re-run-round" }, respondedAt: new Date() })
      .where(eq(hitlRequests.id, request.id));
    await killAtDatabaseWrite({
      table: "artifact_instances",
      event: "INSERT",
      predicate: "NEW.artifact_def_id = 'consensus-human-intent-applied'",
      runId: seeded.runId,
    });
    const children = async (round: number) =>
      (
        await database.db
          .select({ id: runs.id, triggerPayload: runs.triggerPayload })
          .from(runs)
          .where(eq(runs.parentRunId, seeded.runId))
      ).filter(
        (child) =>
          (child.triggerPayload as { round?: number } | null)?.round === round,
      );
    const applied = async () =>
      database.db
        .select({ id: artifactInstances.id })
        .from(artifactInstances)
        .where(
          and(
            eq(artifactInstances.runId, seeded.runId),
            eq(
              artifactInstances.artifactDefId,
              "consensus-human-intent-applied",
            ),
          ),
        );
    const roundTwo = (await children(2)).map((child) => child.id).sort();

    expect(roundTwo).toHaveLength(2);
    expect(await applied()).toHaveLength(0);
    expect(existsSync(inputPath)).toBe(true);
    await database.pool.query(
      "SELECT pg_sleep(greatest(0, extract(epoch from flow_driver_lease_expires_at - clock_timestamp())) + 0.25) FROM runs WHERE id = $1",
      [seeded.runId],
    );
    await drive(seeded.runId);

    try {
      expect((await children(2)).map((child) => child.id).sort()).toEqual(
        roundTwo,
      );
      expect(await children(3)).toHaveLength(0);
      expect(await applied()).toHaveLength(1);
      expect(existsSync(inputPath)).toBe(false);
    } finally {
      // The killed driver dispatched these drafts; with no agent recovery
      // worker in this suite they would hold the agent pool for later cases.
      await database.db
        .update(runs)
        .set({ status: "Abandoned", endedAt: new Date() })
        .where(inArray(runs.id, roundTwo));
    }
  }, 240_000);
  it("P0-5: verifier-only invalid JSON escalates without spending another draft round", async () => {
    const draftBody = `\nfixture-output:${JSON.stringify({ bytes: 0, text: "not-json" })}`;
    const prompt = `fixture-output:${JSON.stringify({ bytes: 0, text: draftBody })}`;
    const seeded = await seedConsensusFlow(prompt, { mode: "iterate", max: 2 });

    await drive(seeded.runId);
    await settleDraftsAndResume(seeded.runId);
    const [run] = await database.db
      .select({ status: runs.status })
      .from(runs)
      .where(eq(runs.id, seeded.runId));
    const [request] = await database.db
      .select()
      .from(hitlRequests)
      .where(
        and(
          eq(hitlRequests.runId, seeded.runId),
          eq(hitlRequests.stepId, "decide"),
        ),
      );

    expect(request).toBeDefined();
    const requestSchema = request.schema as {
      round: number;
      technicalFailures: Array<{ errorCode: string; parseStatus: string }>;
    };
    const children = await database.db
      .select({ id: runs.id })
      .from(runs)
      .where(eq(runs.parentRunId, seeded.runId));

    expect(run.status).toBe("NeedsInput");
    expect(requestSchema.round).toBe(1);
    expect(requestSchema.technicalFailures).toHaveLength(2);
    expect(
      requestSchema.technicalFailures.every(
        (failure) => failure.errorCode === "invalid_json",
      ),
    ).toBe(true);
    expect(children).toHaveLength(2);
  }, 180_000);
  it("P0-5: incomplete synthesis keeps its text and Recover mints a fresh generation", async () => {
    const originalPrompt = consensusPrompt("agree");
    const seeded = await seedConsensusFlow(originalPrompt);

    await drive(seeded.runId);
    // This test changes the immutable fixture's authored prompt between the
    // draft and synthesis drives so the same adapter can return a different
    // terminal stop reason for synthesis without changing supervisor code.
    await waitForDraftsDone(seeded.runId);
    await replaceConsensusPrompt(
      seeded.flowRevisionId!,
      seeded.flowId,
      `fixture-output:${JSON.stringify({ bytes: 0, text: "partial synthesis text", stopReason: "max_tokens" })}`,
    );
    await settleDraftsAndResume(seeded.runId);
    const [failed] = await database.db
      .select()
      .from(nodeAttempts)
      .where(eq(nodeAttempts.runId, seeded.runId));
    const oldSynthesisId = `run:${failed.id}:consensus-synthesis:r1:consensus`;
    const [oldSynthesis] = await database.db
      .select()
      .from(artifactInstances)
      .where(eq(artifactInstances.id, oldSynthesisId));
    const [crashed] = await database.db
      .select({ status: runs.status })
      .from(runs)
      .where(eq(runs.id, seeded.runId));

    expect(crashed.status).toBe("Crashed");
    expect(failed).toMatchObject({ status: "Failed", errorCode: "CRASH" });
    expect(oldSynthesis.locator).toMatchObject({
      kind: "inline",
      text: "partial synthesis text",
      partial: true,
      reason: "consensus_synthesis_incomplete",
      stopReason: "max_tokens",
    });
    if (oldSynthesis.locator.kind !== "inline")
      throw new Error("incomplete synthesis requires inline evidence");
    const hosts = createExecutionHosts({ db: database.db as unknown as Db });
    const recover = () =>
      resumeCrashedRun(seeded.runId, {
        db: database.db as unknown as Db,
        executionHosts: hosts,
        runFlow: (runId, options) =>
          runFlow(runId, {
            ...options,
            runtimeRoot: supervisor.runtimeRoot,
            executionHosts: hosts,
          }),
      });

    await database.db
      .update(artifactInstances)
      .set({ locator: { ...oldSynthesis.locator, reason: "unrelated" } })
      .where(eq(artifactInstances.id, oldSynthesisId));
    expect((await recover()).state).toBe("discard-only");
    await database.db
      .update(artifactInstances)
      .set({ locator: oldSynthesis.locator })
      .where(eq(artifactInstances.id, oldSynthesisId));
    // A missing witness cannot authorize the redispatch either.
    await database.db
      .delete(artifactInstances)
      .where(eq(artifactInstances.id, oldSynthesisId));
    expect((await recover()).state).toBe("discard-only");
    await database.db.insert(artifactInstances).values(oldSynthesis);
    const commands = await database.db
      .select()
      .from(executionCommands)
      .where(
        and(
          eq(executionCommands.runId, seeded.runId),
          eq(executionCommands.kind, "session.prompt"),
        ),
      );
    const synthesisCommand = commands.find(
      (command) =>
        (command.ownerRef as { synthesisId?: string } | null)?.synthesisId ===
        oldSynthesisId,
    );

    expect(synthesisCommand).toBeDefined();
    await database.db
      .update(executionCommands)
      .set({
        applicationError: {
          reason: "prompt_terminal_conflict",
          phase: "prepare",
          causeCode: "terminal_evidence_mismatch",
        },
      })
      .where(eq(executionCommands.id, synthesisCommand!.id));
    expect((await recover()).state).toBe("discard-only");
    await database.db
      .update(executionCommands)
      .set({ applicationError: synthesisCommand!.applicationError })
      .where(eq(executionCommands.id, synthesisCommand!.id));
    const preRecoverAttempts = await database.db
      .select({ id: nodeAttempts.id })
      .from(nodeAttempts)
      .where(eq(nodeAttempts.runId, seeded.runId));

    expect(preRecoverAttempts).toHaveLength(1);
    await replaceConsensusPrompt(
      seeded.flowRevisionId!,
      seeded.flowId,
      originalPrompt,
    );
    const result = await recover();

    expect(result.state).toBe("redispatched");
    const attempts = await database.db
      .select()
      .from(nodeAttempts)
      .where(eq(nodeAttempts.runId, seeded.runId));

    expect(attempts).toHaveLength(2);
    expect(attempts[1].id).not.toBe(failed.id);
    await settleDraftsAndResume(seeded.runId, "Done", attempts[1].id);
    const newSynthesisId = `run:${attempts[1].id}:consensus-synthesis:r1:consensus`;
    const [newSynthesis] = await database.db
      .select()
      .from(artifactInstances)
      .where(eq(artifactInstances.id, newSynthesisId));
    const [retainedOld] = await database.db
      .select()
      .from(artifactInstances)
      .where(eq(artifactInstances.id, oldSynthesisId));

    expect((newSynthesis.locator as { text: string }).text.trim()).not.toBe("");
    expect(retainedOld.locator).toMatchObject({
      partial: true,
      text: "partial synthesis text",
    });

    // Stale witness: a later attempt that crashes for another reason cannot
    // borrow the first attempt's incomplete-synthesis evidence.
    await database.db
      .update(nodeAttempts)
      .set({ status: "Failed", errorCode: "CRASH" })
      .where(eq(nodeAttempts.id, attempts[1].id));
    await database.db
      .update(runs)
      .set({
        status: "Crashed",
        currentStepId: null,
        resumeTargetStepId: "decide",
      })
      .where(eq(runs.id, seeded.runId));
    expect((await recover()).state).toBe("discard-only");
  }, 180_000);
  it("P0-5: an empty end_turn synthesis is a named recoverable crash", async () => {
    const seeded = await seedConsensusFlow(consensusPrompt("agree"));

    await drive(seeded.runId);
    await waitForDraftsDone(seeded.runId);
    await replaceConsensusPrompt(
      seeded.flowRevisionId!,
      seeded.flowId,
      `fixture-output:${JSON.stringify({ bytes: 0, text: "", stopReason: "end_turn" })}`,
    );
    await settleDraftsAndResume(seeded.runId);
    const [run] = await database.db
      .select({ status: runs.status })
      .from(runs)
      .where(eq(runs.id, seeded.runId));
    const [attempt] = await database.db
      .select()
      .from(nodeAttempts)
      .where(eq(nodeAttempts.runId, seeded.runId));
    const [synthesis] = await database.db
      .select()
      .from(artifactInstances)
      .where(
        eq(
          artifactInstances.id,
          `run:${attempt.id}:consensus-synthesis:r1:consensus`,
        ),
      );

    expect(run.status).toBe("Crashed");
    expect(attempt).toMatchObject({ status: "Failed", errorCode: "CRASH" });
    expect(synthesis.locator).toMatchObject({
      kind: "inline",
      text: "",
      partial: true,
      reason: "consensus_synthesis_incomplete",
      stopReason: "end_turn",
    });
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

      // Layer 3: the runtime's unpaid fail-closed write loses to the applied
      // cell. It gets the stored cell back and cannot rewrite the paid turn's
      // raw-output evidence.
      const [rawBefore] = await database.db
        .select({ locator: artifactInstances.locator })
        .from(artifactInstances)
        .where(eq(artifactInstances.id, source.rawOutputArtifactId!));
      const kept = await recordConsensusVerdict({
        db: database.db as unknown as Db,
        runId: seeded.runId,
        nodeId: "decide",
        nodeAttemptId: attempt.id,
        attempt: attempt.attempt,
        round: source.round,
        verifierId: source.verifierKey,
        targetParticipantId: source.targetKey,
        result: {
          parseStatus: "invalid_json",
          verdict: "disagree",
          axes: { scope: false, risk: false },
          disagreements: [],
        },
        rawOutput: "fail-closed overwrite attempt",
        errorCode: "CRASH",
      });
      const [rawAfter] = await database.db
        .select({ locator: artifactInstances.locator })
        .from(artifactInstances)
        .where(eq(artifactInstances.id, source.rawOutputArtifactId!));

      expect(kept).toMatchObject({
        verdict: source.verdict,
        parseStatus: source.parseStatus,
      });
      expect(kept.errorCode).not.toBe("CRASH");
      expect(rawAfter.locator).toEqual(rawBefore.locator);
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
  // ADR-167 D5 amendment (2026-09-23): a draft child whose session has no
  // durable incarnation yet must YIELD, never finalize Failed; the agent
  // continuation worker re-drives the claimed turn once the incarnation exists.
  it("owner-consensus-draft: a create another caller holds yields the draft child, and the agent worker finishes it", async () => {
    const seeded = await seedConsensusFlow(consensusPrompt("agree"));
    const claim = `test_claimed_child_create_${randomUUID().replaceAll("-", "")}`;
    const childCreates = () =>
      database.db
        .select({ id: executionCommands.id })
        .from(executionCommands)
        .innerJoin(runs, eq(runs.id, executionCommands.runId))
        .where(
          and(
            eq(runs.parentRunId, seeded.runId),
            eq(executionCommands.kind, "session.create"),
          ),
        );

    // Another caller's live claim on the create (the agent continuation
    // worker's, in production): a launcher that meets it gets
    // SessionCreatePending before any delivery.
    await database.pool.query(
      `CREATE FUNCTION ${claim}() RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN
         IF NEW.kind = 'session.create' AND EXISTS (
           SELECT 1 FROM runs r WHERE r.id = NEW.run_id AND r.parent_run_id = '${seeded.runId}'
         ) THEN NEW.next_attempt_at := clock_timestamp() + interval '1 hour'; END IF;
         RETURN NEW;
       END $$`,
    );
    await database.pool.query(
      `CREATE TRIGGER ${claim} BEFORE INSERT ON execution_commands FOR EACH ROW EXECUTE FUNCTION ${claim}()`,
    );
    try {
      await drive(seeded.runId);
      const children = await childRuns(seeded.runId);

      expect(children).toHaveLength(2);
      // Each launcher has returned: whatever it did with the claim is final.
      await probe.until(
        () => children.every((child) => probe.of(child.id, "session").length),
        60_000,
      );
      for (const child of children) {
        // It yielded on the held create — before any prompt admission.
        expect(probe.of(child.id, "session")).toEqual([null]);
        expect(probe.of(child.id, "admission")).toEqual([]);
        const [pending] = probe.of(child.id, "create");

        expect(pending).toBeInstanceOf(SessionCreatePending);
        expect(pending).toMatchObject({
          code: "PRECONDITION",
          details: { reason: "session_create_pending" },
        });
      }
      expect(
        (await childRuns(seeded.runId)).map((child) => child.status),
      ).toEqual(["Running", "Running"]);
      expect(await childCreates()).toHaveLength(2);
    } finally {
      await database.pool.query(
        `DROP TRIGGER IF EXISTS ${claim} ON execution_commands`,
      );
      await database.pool.query(`DROP FUNCTION IF EXISTS ${claim}()`);
    }

    // The claim lapses; the worker re-drives each claimed turn on its create.
    await database.pool.query(
      `UPDATE execution_commands c SET next_attempt_at = NULL FROM runs r
        WHERE r.id = c.run_id AND r.parent_run_id = $1 AND c.kind = 'session.create'`,
      [seeded.runId],
    );
    const agents = startAgentContinuationWorker({
      db: database.db as unknown as Db,
      executionHosts: createExecutionHosts({
        db: database.db as unknown as Db,
      }),
    });

    try {
      await settleDraftsAndResume(seeded.runId);
      expect(await childCreates()).toHaveLength(2);
    } finally {
      await agents.stop();
    }
  }, 300_000);

  it("owner-consensus-draft: an admission fence timeout yields the draft child and the agent worker re-drives it", async () => {
    const seeded = await seedConsensusFlow(consensusPrompt("agree"));
    const fault = await holdChildAdmission(seeded.runId);
    let agents: ReturnType<typeof startAgentContinuationWorker> | null = null;

    try {
      await drive(seeded.runId);
      const children = await childRuns(seeded.runId);

      expect(children).toHaveLength(2);
      // The launcher's admission waits out its whole fence budget (~60 s) with
      // no durable incarnation. Await the launcher's return itself, with no
      // re-driver running yet, so it alone decides what happened.
      await probe.until(
        () => children.every((child) => probe.of(child.id, "session").length),
        150_000,
      );
      for (const child of children) {
        // The create went through (the create-pending yield never fired); the
        // admission fence timed out, and the launcher returned without failing.
        expect(probe.of(child.id, "create")).toEqual([]);
        expect(probe.of(child.id, "session")).toEqual([null]);
        const admission = probe.of(child.id, "admission");

        expect(admission).toHaveLength(1);
        expect(admission[0]).toBeInstanceOf(PromptIncarnationPending);
        expect(admission[0]).toMatchObject({
          code: "EXECUTOR_UNAVAILABLE",
          details: { reason: "prompt_incarnation_pending", runId: child.id },
        });
      }
      expect(
        (await childRuns(seeded.runId)).map((child) => child.status),
      ).toEqual(["Running", "Running"]);

      agents = startAgentContinuationWorker({
        db: database.db as unknown as Db,
        executionHosts: createExecutionHosts({
          db: database.db as unknown as Db,
        }),
      });
      // Let the worker re-drive each child twice while the fault holds.
      await probe.until(
        () =>
          children.every((child) => probe.of(child.id, "session").length >= 3),
        120_000,
      );
      // Each re-drive pass is bounded by the worker's 5 s abort, never a spin.
      for (const count of await fault.recentAttempts(10_000))
        expect(count).toBeLessThan(3);

      await fault.release();
      await settleDraftsAndResume(seeded.runId);
      for (const child of children) {
        const prompts = await database.db
          .select({ id: executionCommands.id })
          .from(executionCommands)
          .where(
            and(
              eq(executionCommands.runId, child.id),
              eq(executionCommands.kind, "session.prompt"),
            ),
          );

        expect(prompts).toHaveLength(1);
        // A `created` live incarnation dispatches; it never opens a second session.
        expect(
          await database.db
            .select({ id: executionCommands.id })
            .from(executionCommands)
            .where(
              and(
                eq(executionCommands.runId, child.id),
                eq(executionCommands.kind, "session.create"),
              ),
            ),
        ).toHaveLength(1);
      }
    } finally {
      await agents?.stop();
      await fault.release();
    }
  }, 360_000);
});
