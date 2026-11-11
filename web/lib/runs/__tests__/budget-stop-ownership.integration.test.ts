import type { Db } from "@/lib/execution-host/db";
import type { RealSupervisor } from "@/test-support/real-supervisor";
import type { ProjectionWorker } from "@/lib/execution-host/events/projection-worker";

import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";

import {
  domainEvents,
  executionAssignments,
  executionCommands,
  hitlRequests,
  nodeAttempts,
  runs,
} from "@/lib/db/schema";
import { createExecutionHosts } from "@/lib/execution-host/client";
import { defaultTransport } from "@/lib/execution-host/default-transport";
import { stopRuntimeEventConsumers } from "@/lib/execution-host/events/consumer";
import { canonicalProjectors } from "@/lib/execution-host/events/projection-runtime";
import { startProjectionWorker } from "@/lib/execution-host/events/projection-worker";
import { resetRegistrarStateForTests } from "@/lib/execution-host/registrar";
import { resetResolverForTests } from "@/lib/execution-host/resolver";
import { MaisterError } from "@/lib/errors";
import { handleFlowPermission } from "@/lib/flows/graph/prompt-permission";
import { runFlow } from "@/lib/flows/runner";
import { appendManagerRunStreamEvent } from "@/lib/runs/run-stream-event";
import { runSweepTick } from "@/lib/runs/keepalive-sweeper";
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
let restoreUrl: () => void;

beforeAll(async () => {
  database = await startMainPostgresTestDb({
    databaseName: "budget_stop_owner",
  });
  supervisor = await startRealSupervisor({
    fixtureArgs: ["--hang-prompt", "--lines", "0"],
  });
  restoreUrl = useRealSupervisorUrl(supervisor.url);
  resetRegistrarStateForTests();
  resetResolverForTests();
  worker = startProjectionWorker({
    db: database.db as Db,
    projectors: canonicalProjectors,
  });
}, 180_000);

afterAll(async () => {
  await stopRuntimeEventConsumers();
  await worker?.stop();
  await supervisor?.kill();
  restoreUrl?.();
  await database?.stop();
});

it.each(["run", "tree", "node_duration"] as const)(
  "%s stop retains terminal ownership when DELETE interrupts an accepted ACP prompt",
  async (scope) => {
    const nodeDuration = scope === "node_duration";
    const db = database.db as Db;
    const name = randomUUID();
    const repoPath = await initRepo(`${supervisor.runtimeRoot}/repo-${name}`);
    const worktreePath = await addWorktree(
      repoPath,
      `${supervisor.runtimeRoot}/wt-${name}`,
      `maister/${name}`,
    );
    const seeded = await seedGraphRun(
      database.db,
      {
        schemaVersion: 1,
        name: "budget-stop-owner",
        nodes: [
          {
            id: "work",
            type: "ai_coding",
            ...(nodeDuration
              ? { settings: { limits: { maxDurationMinutes: 1 } } }
              : {}),
            action: { prompt: "Wait for the budget stop" },
            transitions: { success: "done" },
          },
        ],
      },
      {
        repoPath,
        flowRevision: true,
        run: {
          executionPolicy: {
            preset: "supervised",
            overrides: {
              budget: nodeDuration ? {} : { [scope]: { maxTokens: 100 } },
              onBudgetBreach: "terminate",
            },
          },
        },
        workspace: {
          worktreePath,
          parentRepoPath: repoPath,
          branch: `maister/${name}`,
        },
      },
    );
    const hosts = createExecutionHosts({ db });
    const controller = new AbortController();
    let releaseDelete: () => void = () => {};
    let sweeping: Promise<unknown> | undefined;
    const errors: unknown[] = [];
    const driving = runFlow(seeded.runId, {
      db,
      runtimeRoot: supervisor.runtimeRoot,
      executionHosts: hosts,
      signal: controller.signal,
    });

    void driving.catch((error: unknown) => {
      errors.push(error);
    });
    try {
      await expect
        .poll(
          async () => {
            if (errors.length) throw errors[0];
            const [prompt] = await db
              .select()
              .from(executionCommands)
              .where(
                and(
                  eq(executionCommands.runId, seeded.runId),
                  eq(executionCommands.kind, "session.prompt"),
                ),
              );

            return prompt?.state;
          },
          { timeout: 30_000 },
        )
        .toBe("accepted");
      if (nodeDuration)
        await db
          .update(nodeAttempts)
          .set({ startedAt: new Date(Date.now() - 120_000) })
          .where(eq(nodeAttempts.runId, seeded.runId));
      await appendManagerRunStreamEvent(db, {
        runId: seeded.runId,
        sourceKey: `budget-stop:${seeded.runId}`,
        event: {
          type: "usage.recorded",
          data: {
            sessionName: "default",
            model: "fixture",
            inputTokens: 200,
            outputTokens: 0,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            resumed: false,
          },
        },
      });
      let deleteReached = false;
      const released = new Promise<void>((resolve) => {
        releaseDelete = resolve;
      });
      const transport = defaultTransport();
      const budgetHosts = createExecutionHosts({
        db,
        transport: {
          ...transport,
          deleteSession: async (...args) => {
            const result = await transport.deleteSession(...args);

            deleteReached = true;
            await released;

            return result;
          },
        },
      });
      const unavailableHosts = createExecutionHosts({
        db,
        transport: {
          ...transport,
          deleteSession: async () => {
            throw new MaisterError(
              "EXECUTOR_UNAVAILABLE",
              "controlled unconfirmed shutdown",
            );
          },
        },
      });

      await runSweepTick({ db, executionHosts: unavailableHosts });
      const [retryable] = await db
        .select()
        .from(runs)
        .where(eq(runs.id, seeded.runId));

      expect(retryable.status).toBe("Running");
      expect(retryable.budgetState?.termination?.id).toBeDefined();
      if (!nodeDuration)
        expect(retryable.budgetState?.notified?.[scope]).not.toBe("terminate");
      const [pendingPrompt] = await db
        .select()
        .from(executionCommands)
        .where(
          and(
            eq(executionCommands.runId, seeded.runId),
            eq(executionCommands.kind, "session.prompt"),
          ),
        );
      const owner = pendingPrompt.ownerRef;

      if (!owner || owner.variant !== "node")
        throw new Error("fixture requires the current node prompt");
      await handleFlowPermission({
        db,
        client: await hosts.forRun(seeded.runId),
        owner: {
          variant: "node",
          nodeAttemptId: owner.nodeAttemptId,
          promptOrdinal: owner.promptOrdinal,
        },
        hostSessionId: pendingPrompt.targetSessionId!,
        stepId: "work",
        prompt: "Late permission while stopping",
        event: {
          type: "session.permission_request",
          sessionId: pendingPrompt.targetSessionId!,
          monotonicId: 1,
          requestId: "late-budget-permission",
          options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
          toolCall: { toolCallId: "late-tool", title: "Read", kind: "read" },
        },
      });
      expect(
        await db
          .select()
          .from(hitlRequests)
          .where(eq(hitlRequests.runId, seeded.runId)),
      ).toHaveLength(0);
      expect(
        (await db.select().from(runs).where(eq(runs.id, seeded.runId)))[0]
          .status,
      ).toBe("Running");
      // Once accepted, the exact stop cause survives a changing meter/policy.
      await db
        .update(runs)
        .set({
          executionPolicy: { preset: "supervised", overrides: { budget: {} } },
        })
        .where(eq(runs.id, seeded.runId));
      sweeping = runSweepTick({ db, executionHosts: budgetHosts });
      void sweeping.catch((error: unknown) => {
        errors.push(error);
      });
      await expect
        .poll(
          () => {
            if (errors.length) throw errors[0];

            return deleteReached;
          },
          { timeout: 30_000 },
        )
        .toBe(true);
      await driving;
      expect(
        await db
          .select({ id: executionCommands.id })
          .from(executionCommands)
          .where(
            and(
              eq(executionCommands.runId, seeded.runId),
              eq(executionCommands.kind, "session.delete"),
            ),
          ),
      ).toHaveLength(2);
      const [held] = await db
        .select()
        .from(runs)
        .where(eq(runs.id, seeded.runId));
      const [assignment] = await db
        .select()
        .from(executionAssignments)
        .where(eq(executionAssignments.id, held.executionAssignmentId!));

      expect(held.budgetState?.termination?.id).toBe(
        retryable.budgetState?.termination?.id,
      );
      expect(held.status).toBe("Running");
      expect(assignment.state).toBe("active");
      if (!nodeDuration)
        expect(held.budgetState?.notified?.[scope]).not.toBe("terminate");
    } catch (error) {
      errors.push(error);
    } finally {
      releaseDelete();
      controller.abort();
      const outcomes = await Promise.allSettled([
        driving,
        ...(sweeping ? [sweeping] : []),
      ]);

      for (const outcome of outcomes)
        if (outcome.status === "rejected" && !errors.includes(outcome.reason))
          errors.push(outcome.reason);
    }
    if (errors.length)
      throw new AggregateError(errors, "Budget stop qualification failed");
    const [settled] = await db
      .select()
      .from(runs)
      .where(eq(runs.id, seeded.runId));
    const attempts = await db
      .select()
      .from(nodeAttempts)
      .where(eq(nodeAttempts.runId, seeded.runId));
    const events = await db
      .select()
      .from(domainEvents)
      .where(
        and(
          eq(domainEvents.runId, seeded.runId),
          eq(domainEvents.kind, "run.failed"),
        ),
      );

    expect(settled.status).toBe("Failed");
    if (!nodeDuration)
      expect(settled.budgetState?.notified?.[scope]).toBe("terminate");
    expect(attempts).toHaveLength(1);
    const code = nodeDuration ? "PRECONDITION" : "BUDGET_EXCEEDED";

    expect(attempts[0].errorCode).toBe(code);
    expect(events).toHaveLength(1);
    expect(events[0].payload.cause).toMatchObject({
      code,
      reason: nodeDuration ? "max_duration" : "budget_breach",
      source: "sweeper",
    });
  },
  60_000,
);
