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
  executionCommands,
  flowRevisions,
  flows,
  nodeAttempts,
  runs,
} from "@/lib/db/schema";
import { startPromptOwnerWorker } from "@/lib/execution-host/prompt-owner-recovery";
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
});
