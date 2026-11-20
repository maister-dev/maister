import type { Db } from "@/lib/execution-host/db";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { and, eq, like, sql } from "drizzle-orm";
import pino from "pino";
import { expect, it, vi } from "vitest";

import * as schema from "@/lib/db/schema";
import {
  testPlatformRunnerRow,
  testRunnerSnapshot,
} from "@/lib/__tests__/runner-fixtures";
import { stopRuntimeEventConsumers } from "@/lib/execution-host/events/consumer";
import { canonicalProjectors } from "@/lib/execution-host/events/projection-runtime";
import { startProjectionWorker } from "@/lib/execution-host/events/projection-worker";
import { resetRegistrarStateForTests } from "@/lib/execution-host/registrar";
import { resetResolverForTests } from "@/lib/execution-host/resolver";
import { readContextSnapshot } from "@/lib/runs/context-reader";
import { initRepo, addWorktree } from "@/test-support/git-fixture";
import { seedGraphRun } from "@/test-support/graph-run-seed";
import { startMainPostgresTestDb } from "@/test-support/pg-container";
import {
  startRealSupervisor,
  useRealSupervisorUrl,
} from "@/test-support/real-supervisor";

const log = pino({ name: "context-provider-fixture" });
const userId = "context-provider-fixture";
const syntheticPrompt =
  "Respond with exactly OK. Do not use tools or read any files.";
let db: NodePgDatabase<typeof schema>;

vi.mock("@/lib/db/client", () => ({
  getDb: () => db,
  closeDb: async () => {},
}));
vi.mock("@/lib/authz", () => ({
  requireActiveSession: async () => ({
    id: userId,
    email: "context@example.test",
    role: "admin",
  }),
  requireProjectAction: async () => undefined,
}));

// This separate opt-in lane submits only synthetic prompts to configured local
// provider sessions. The normal integration suite never uses credentials.
it.skipIf(process.env.MAISTER_CONTEXT_PROVIDER_FIXTURE !== "1").each([
  ["claude", "claude-sonnet-4-6", "claude-agent-acp"],
  ["codex", "gpt-6.1-terra", "codex-acp"],
] as const)(
  "provider context through MAIster scratch and Flow on %s",
  async (adapter, model, binary) => {
    const database = await startMainPostgresTestDb({
      databaseName: `context_provider_${adapter}`,
    });

    db = database.db;
    const server = await startRealSupervisor({
      env: {
        [`MAISTER_ADAPTER_BINARY_${adapter.toUpperCase()}`]: resolve(
          "../supervisor/node_modules/.bin",
          binary,
        ),
      },
    });
    const restore = useRealSupervisorUrl(server.url);
    const worker = startProjectionWorker({
      db: db as unknown as Db,
      projectors: canonicalProjectors,
    });
    const previousEnv = {
      DB_URL: process.env.DB_URL,
      MAISTER_RUNTIME_ROOT: process.env.MAISTER_RUNTIME_ROOT,
      MAISTER_WORKTREES_ROOT: process.env.MAISTER_WORKTREES_ROOT,
    };

    process.env.DB_URL = database.databaseUrl;
    process.env.MAISTER_RUNTIME_ROOT = server.runtimeRoot;
    process.env.MAISTER_WORKTREES_ROOT = resolve(
      server.runtimeRoot,
      "worktrees",
    );
    resetResolverForTests();
    resetRegistrarStateForTests();

    try {
      const { launchScratchRunStaged, sendScratchUserMessage } =
        await import("@/lib/scratch-runs/service");
      const { runFlow } = await import("@/lib/flows/runner");
      const repo = await initRepo(resolve(server.runtimeRoot, "repo"));
      const projectId = randomUUID();
      const runnerId = randomUUID();
      const runnerSnapshot = {
        ...testRunnerSnapshot(runnerId, adapter),
        model,
      };

      await db.insert(schema.users).values({
        id: userId,
        email: "context@example.test",
        role: "member",
        accountStatus: "active",
      });
      await db.insert(schema.projects).values({
        id: projectId,
        slug: "context-provider",
        name: "Context provider",
        repoPath: repo,
        taskKey: "CTX",
      });
      await db
        .insert(schema.platformAcpRunners)
        .values({ ...testPlatformRunnerRow(runnerId, adapter), model });
      await db
        .insert(schema.platformRuntimeSettings)
        .values({ id: "singleton", defaultRunnerId: runnerId });
      const stages = launchScratchRunStaged({
        userId,
        body: {
          projectId,
          baseBranch: "main",
          reasoningEffort: "high",
          prompt: syntheticPrompt,
          attachments: [],
        },
      });
      let result = await stages.next();

      while (!result.done) result = await stages.next();
      const scratchId = result.value.runId;
      const readScratch = () =>
        readContextSnapshot(db as unknown as Db, scratchId);

      await expect
        .poll(async () => (await readScratch()).usage, { timeout: 15_000 })
        .not.toBeNull();
      const before = (await readScratch()).usage;

      try {
        await sendScratchUserMessage({
          runId: scratchId,
          body: { content: "/compact", attachments: [] },
        });
      } catch (error) {
        const commands = await db
          .select({
            state: schema.executionCommands.state,
            code: sql<
              string | null
            >`${schema.executionCommands.lastError}->>'code'`,
            reason: sql<
              string | null
            >`${schema.executionCommands.lastError}->'details'->>'reason'`,
          })
          .from(schema.executionCommands)
          .where(eq(schema.executionCommands.runId, scratchId));
        const [scratch] = await db
          .select({
            status: schema.scratchRuns.dialogStatus,
            errorCode: schema.scratchRuns.errorCode,
          })
          .from(schema.scratchRuns)
          .where(eq(schema.scratchRuns.runId, scratchId));

        const outputFailure =
          (await server.logTail(32_768)).match(
            /"outputFailure":"([a-z_]{1,80})"/g,
          ) ?? [];

        log.info(
          { adapter, scratch, commands, outputFailure },
          "provider-context-failure",
        );
        throw error;
      }
      await expect
        .poll(async () => (await readScratch()).completedCompactions, {
          timeout: 15_000,
        })
        .toBe(1);
      const after = (await readScratch()).usage;

      if (after === null) {
        await sendScratchUserMessage({
          runId: scratchId,
          body: { content: syntheticPrompt, attachments: [] },
        });
        await expect
          .poll(async () => (await readScratch()).usage, { timeout: 15_000 })
          .not.toBeNull();
      }
      const markers = await db
        .select({ id: schema.runMessages.id })
        .from(schema.runMessages)
        .where(
          and(
            eq(schema.runMessages.runId, scratchId),
            like(schema.runMessages.projectionToolKey, "compaction:%"),
          ),
        );

      expect(markers).toHaveLength(1);

      const flowRepo = await initRepo(resolve(server.runtimeRoot, "flow-repo"));
      const branch = "context-flow";
      const worktree = await addWorktree(
        flowRepo,
        resolve(server.runtimeRoot, "flow-worktree"),
        branch,
      );
      const flow = await seedGraphRun(
        db as unknown as NodePgDatabase,
        {
          schemaVersion: 1,
          name: "Provider context smoke",
          compat: { engine_min: "1.1.0" },
          nodes: [
            {
              id: "work",
              type: "ai_coding",
              action: { prompt: syntheticPrompt },
              transitions: { success: "done" },
            },
          ],
        },
        {
          agent: adapter,
          repoPath: flowRepo,
          flowRevision: true,
          workspace: {
            worktreePath: worktree,
            parentRepoPath: flowRepo,
            branch,
          },
        },
      );

      await db
        .update(schema.runSessions)
        .set({ runnerId, runnerSnapshot })
        .where(eq(schema.runSessions.runId, flow.runId));
      await runFlow(flow.runId, { db, runtimeRoot: server.runtimeRoot });
      const [flowRun] = await db
        .select({ status: schema.runs.status })
        .from(schema.runs)
        .where(eq(schema.runs.id, flow.runId));

      expect(flowRun.status).toBe("Review");
      const [attempt] = await db
        .select({ id: schema.nodeAttempts.id })
        .from(schema.nodeAttempts)
        .where(eq(schema.nodeAttempts.runId, flow.runId));
      const readFlow = () =>
        readContextSnapshot(db as unknown as Db, flow.runId, attempt.id);

      await expect
        .poll(async () => (await readFlow()).usage, { timeout: 15_000 })
        .not.toBeNull();
      const flowUsage = (await readFlow()).usage;

      log.info(
        {
          adapter,
          model,
          scratch: {
            before,
            after,
            latest: (await readScratch()).usage,
            markers: markers.length,
          },
          flow: { usage: flowUsage },
        },
        "provider-context-observed",
      );
    } finally {
      await stopRuntimeEventConsumers();
      restore();
      await worker.stop();
      await server.stop();
      await database.stop();
      for (const [key, value] of Object.entries(previousEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  },
  240_000,
);
