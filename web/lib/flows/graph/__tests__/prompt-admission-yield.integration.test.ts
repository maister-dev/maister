// ADR-167 D5 amendment (2026-09-23) — a prompt-admission fence timeout is a
// YIELD, never a node failure. The window is forced for real: a test trigger
// suppresses the ACK-authored incarnation insert and the lifecycle projector is
// held, so no durable incarnation exists for the node's session. The driver
// must leave the attempt Running with its live session, and the production
// continuation worker must re-drive it once the incarnation becomes durable.
import type { Db } from "@/lib/execution-host/db";
import type { ExecutionCommand } from "@/lib/db/schema";
import type { FlowYamlV1 } from "@/lib/config.schema";
import type { RealSupervisor } from "@/test-support/real-supervisor";
import type { ProjectionWorker } from "@/lib/execution-host/events/projection-worker";

import { randomUUID } from "node:crypto";

import { and, eq, isNotNull } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  executionCommands,
  executionHosts,
  projectTokens,
  nodeAttempts,
  runMessages,
  runs,
} from "@/lib/db/schema";
import { verifyToken } from "@/lib/tokens/verify";
import { readCreateIntent } from "@/lib/execution-host/create-intent";
import { createExecutionHosts } from "@/lib/execution-host/client";
import { stopRuntimeEventConsumers } from "@/lib/execution-host/events/consumer";
import { CANONICAL_PROJECTION_CONSUMERS } from "@/lib/execution-host/events/projection-consumers";
import { canonicalProjectors } from "@/lib/execution-host/events/projection-runtime";
import { startProjectionWorker } from "@/lib/execution-host/events/projection-worker";
import { resetRegistrarStateForTests } from "@/lib/execution-host/registrar";
import { resetResolverForTests } from "@/lib/execution-host/resolver";
import { startFlowContinuationWorker } from "@/lib/flows/graph/continuation-worker";
import { runFlow } from "@/lib/flows/runner";
import { addWorktree, initRepo } from "@/test-support/git-fixture";
import { seedGraphRun } from "@/test-support/graph-run-seed";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";
import {
  holdProjection,
  suppressIncarnations,
} from "@/test-support/projection-hold";
import {
  startRealSupervisor,
  useRealSupervisorUrl,
} from "@/test-support/real-supervisor";

let database: StartedPostgresTestDb;
let supervisor: RealSupervisor;
let worker: ProjectionWorker;
let restoreUrl: () => void = () => {};
let priorRuntimeRoot: string | undefined;

beforeAll(async () => {
  database = await startMainPostgresTestDb({
    databaseName: "flow_prompt_admission_yield",
  });
  supervisor = await startRealSupervisor();
  restoreUrl = useRealSupervisorUrl(supervisor.url);
  resetRegistrarStateForTests();
  resetResolverForTests();
  worker = startProjectionWorker({
    db: database.db as unknown as Db,
    projectors: canonicalProjectors,
  });
  // The continuation worker re-enters through production `runFlow`, which
  // resolves the configured runtime root rather than taking one from a caller.
  priorRuntimeRoot = process.env.MAISTER_RUNTIME_ROOT;
  process.env.MAISTER_RUNTIME_ROOT = supervisor.runtimeRoot;
}, 180_000);

afterAll(async () => {
  await stopRuntimeEventConsumers();
  if (priorRuntimeRoot === undefined) delete process.env.MAISTER_RUNTIME_ROOT;
  else process.env.MAISTER_RUNTIME_ROOT = priorRuntimeRoot;
  restoreUrl();
  await worker?.stop();
  await supervisor?.kill();
  await database?.stop();
});

async function seedPromptFlow(nodes: FlowYamlV1["nodes"]) {
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
      name: "admission-yield",
      compat: { engine_min: "1.6.0" },
      nodes,
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

/** No incarnation row can be written for this run while the trigger exists:
 * neither the ACK nor the projector can produce the durable admission row. */
async function commandsOf(runId: string, kind: ExecutionCommand["kind"]) {
  return database.db
    .select()
    .from(executionCommands)
    .where(
      and(eq(executionCommands.runId, runId), eq(executionCommands.kind, kind)),
    );
}

describe("prompt admission fence timeout on the flow path", () => {
  it("A2: yields with the attempt Running and its session alive, then the continuation worker re-drives it once", async () => {
    const seeded = await seedPromptFlow([
      {
        id: "work",
        type: "ai_coding",
        action: { prompt: "hello" },
        transitions: { success: "done" },
      },
    ]);
    const runId = seeded.runId;
    const release = await holdProjection(database.pool, {
      consumerName: CANONICAL_PROJECTION_CONSUMERS.lifecycle,
      runId,
    });
    const allowIncarnations = (
      await suppressIncarnations(database.pool, { runId })
    ).release;
    let continuation: ReturnType<typeof startFlowContinuationWorker> | null =
      null;

    try {
      await runFlow(runId, {
        db: database.db,
        runtimeRoot: supervisor.runtimeRoot,
        executionHosts: createExecutionHosts({
          db: database.db as unknown as Db,
        }),
      });

      const [run] = await database.db
        .select()
        .from(runs)
        .where(eq(runs.id, runId));
      const attempts = await database.db
        .select()
        .from(nodeAttempts)
        .where(eq(nodeAttempts.runId, runId));

      // A yield writes no node failure and no new attempt...
      expect(run.status).toBe("Running");
      expect(attempts).toHaveLength(1);
      expect(attempts[0]).toMatchObject({ status: "Running", endedAt: null });
      // ...keeps the live session for the re-drive and admits no prompt.
      expect(await commandsOf(runId, "session.delete")).toEqual([]);
      expect(await commandsOf(runId, "session.prompt")).toEqual([]);

      await allowIncarnations();
      await release();
      continuation = startFlowContinuationWorker({
        db: database.db as unknown as Db,
        executionHosts: createExecutionHosts({
          db: database.db as unknown as Db,
        }),
      });

      await expect
        .poll(
          async () =>
            (
              await database.db
                .select({ status: runs.status })
                .from(runs)
                .where(eq(runs.id, runId))
            )[0]?.status,
          { timeout: 120_000, interval: 250 },
        )
        .toBe("Review");
      expect(await commandsOf(runId, "session.prompt")).toHaveLength(1);
      // The re-drive re-records the same dispatch key, which is idempotent.
      expect(
        await database.db
          .select({ id: runMessages.id })
          .from(runMessages)
          .where(
            and(
              eq(runMessages.runId, runId),
              eq(runMessages.nodeAttemptId, attempts[0].id),
              isNotNull(runMessages.promptDispatchKey),
            ),
          ),
      ).toHaveLength(1);
    } finally {
      await continuation?.stop();
      await allowIncarnations();
      await release();
    }
  }, 360_000);

  it("preserves the live session credential on admission replay and retires it at completion", async () => {
    const seeded = await seedPromptFlow([
      {
        id: "coordinate",
        type: "orchestrator",
        action: {
          prompt:
            'fixture-output:{"bytes":0,"text":"coordinator turn","terminalDelayMs":10000}',
        },
        transitions: { success: "done" },
      },
    ]);
    const runId = seeded.runId;
    const release = await holdProjection(database.pool, {
      consumerName: CANONICAL_PROJECTION_CONSUMERS.lifecycle,
      runId,
    });
    const { release: allowIncarnations } = await suppressIncarnations(
      database.pool,
      { runId },
    );
    let continuation: ReturnType<typeof startFlowContinuationWorker> | null =
      null;

    try {
      await runFlow(runId, {
        db: database.db,
        runtimeRoot: supervisor.runtimeRoot,
        executionHosts: createExecutionHosts({
          db: database.db as unknown as Db,
        }),
      });
      const creates = await commandsOf(runId, "session.create");

      expect(creates).toHaveLength(1);
      const [host] = await database.db
        .select({ hostKey: executionHosts.hostKey })
        .from(executionHosts)
        .where(eq(executionHosts.id, creates[0].executionHostId));
      const payload = readCreateIntent(creates[0], host.hostKey).envelope
        .payload;
      const secret = payload.mcpServers?.find(
        (server) => server.name === "maister",
      )?.env?.MAISTER_PROJECT_TOKEN;

      // Keep the private descriptor and credential out of assertion output.
      expect(typeof secret).toBe("string");
      const original = await verifyToken(secret!, database.db as unknown as Db);
      const frozenDigest = creates[0].createIntent?.requestSha256;

      expect(await commandsOf(runId, "session.prompt")).toHaveLength(0);

      await allowIncarnations();
      await release();
      continuation = startFlowContinuationWorker({
        db: database.db as unknown as Db,
        executionHosts: createExecutionHosts({
          db: database.db as unknown as Db,
        }),
      });
      await expect
        .poll(async () => (await commandsOf(runId, "session.prompt")).length, {
          timeout: 60_000,
          interval: 100,
        })
        .toBe(1);
      const current = await verifyToken(secret!, database.db as unknown as Db);

      expect(current.tokenId).toBe(original.tokenId);
      expect(
        (await commandsOf(runId, "session.create"))[0].createIntent
          ?.requestSha256,
      ).toEqual(frozenDigest);
      expect(
        await database.db
          .select({ id: projectTokens.id })
          .from(projectTokens)
          .where(eq(projectTokens.bound_run_id, runId)),
      ).toHaveLength(1);

      await expect
        .poll(
          async () =>
            (
              await database.db
                .select({ status: runs.status })
                .from(runs)
                .where(eq(runs.id, runId))
            )[0]?.status,
          { timeout: 120_000, interval: 250 },
        )
        .toBe("Review");
      const tokens = await database.db
        .select({
          id: projectTokens.id,
          revokedAt: projectTokens.revoked_at,
          reason: projectTokens.revocation_reason,
        })
        .from(projectTokens)
        .where(eq(projectTokens.bound_run_id, runId));

      expect(tokens).toHaveLength(1);
      expect(tokens[0].revokedAt).not.toBeNull();
      expect(tokens[0].reason).toBe("revoked");
    } finally {
      await continuation?.stop();
      await allowIncarnations();
      await release();
    }
  }, 360_000);

  it("mints a distinct credential for a genuinely new owned node session", async () => {
    const seeded = await seedPromptFlow([
      {
        id: "first",
        type: "orchestrator",
        action: {
          prompt: 'fixture-output:{"bytes":0,"text":"first turn"}',
        },
        transitions: { success: "second" },
      },
      {
        id: "second",
        type: "orchestrator",
        action: {
          prompt:
            'fixture-output:{"bytes":0,"text":"second turn","terminalDelayMs":10000}',
        },
        transitions: { success: "done" },
      },
    ]);
    const driving = runFlow(seeded.runId, {
      db: database.db,
      runtimeRoot: supervisor.runtimeRoot,
      executionHosts: createExecutionHosts({
        db: database.db as unknown as Db,
      }),
    });

    try {
      await expect
        .poll(
          async () => (await commandsOf(seeded.runId, "session.prompt")).length,
          { timeout: 60_000, interval: 100 },
        )
        .toBe(2);
      const tokens = await database.db
        .select({
          id: projectTokens.id,
          nodeAttemptId: projectTokens.knowledge_node_attempt_id,
          revokedAt: projectTokens.revoked_at,
          reason: projectTokens.revocation_reason,
        })
        .from(projectTokens)
        .where(eq(projectTokens.bound_run_id, seeded.runId));

      expect(tokens).toHaveLength(2);
      expect(new Set(tokens.map((token) => token.nodeAttemptId)).size).toBe(2);
      expect(tokens.filter((token) => token.revokedAt === null)).toHaveLength(
        1,
      );
      // Completing the first coordinator already closed its delegation family.
      expect(tokens.find((token) => token.revokedAt !== null)?.reason).toBe(
        "revoked",
      );
      const creates = await commandsOf(seeded.runId, "session.create");

      expect(creates).toHaveLength(2);
      for (const command of creates) {
        const [host] = await database.db
          .select({ hostKey: executionHosts.hostKey })
          .from(executionHosts)
          .where(eq(executionHosts.id, command.executionHostId));
        const payload = readCreateIntent(command, host.hostKey).envelope
          .payload;
        const secret = payload.mcpServers?.find(
          (server) => server.name === "maister",
        )?.env?.MAISTER_PROJECT_TOKEN;

        expect(typeof secret).toBe("string");
        if (
          payload.nodeAttemptId ===
          tokens.find((token) => token.revokedAt === null)?.nodeAttemptId
        ) {
          const actor = await verifyToken(
            secret!,
            database.db as unknown as Db,
          );

          expect(actor.tokenId).toBe(
            tokens.find((token) => token.revokedAt === null)?.id,
          );
        } else {
          await expect(
            verifyToken(secret!, database.db as unknown as Db),
          ).rejects.toMatchObject({ kind: "revoked" });
        }
      }
      await driving;
      const [run] = await database.db
        .select({ status: runs.status })
        .from(runs)
        .where(eq(runs.id, seeded.runId));

      expect(run.status).toBe("Review");
    } finally {
      await driving;
    }
  }, 120_000);
});
