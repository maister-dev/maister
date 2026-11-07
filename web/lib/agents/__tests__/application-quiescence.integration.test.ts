import type { ExecutionCommand } from "@/lib/db/schema";
import type { Db } from "@/lib/execution-host/db";
import type { ExecutionHosts } from "@/lib/execution-host/client";
import type { FakeExecutionHost } from "@/test-support/fake-execution-host";
import type { PromptResult } from "@/lib/supervisor-client";
import type { RunResultContract } from "@/lib/run-results/types";

import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { and, eq } from "drizzle-orm";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { startAgentSession } from "@/lib/agents/launch";
import {
  assertAgentExecutionQuiescent,
  waitForAgentCancellationExecutionQuiescent,
} from "@/lib/agents/execution-quiescence";
import { runEventWakeBus } from "@/lib/execution-host/events/run-wake";
import {
  depsFromOptions,
  stopWorkbenchRun,
} from "@/lib/workbench-lifecycle/service";
import {
  agentPromptOwner,
  agentPromptOwners,
  stopAgentPromptSession,
} from "@/lib/agents/prompt-owner";
import {
  agentTurns,
  domainEvents,
  executionAssignments,
  executionCommands,
  runResults,
  runSessionIncarnations,
  runs,
} from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import { stopRuntimeEventConsumers } from "@/lib/execution-host/events/consumer";
import { PromptOwnerSchema } from "@/lib/execution-host/prompt-owner-contract";
import { applyPromptOwner } from "@/lib/execution-host/prompt-owner-application";
import {
  createPromptOwnerRegistry,
  PromptOwnerDeferred,
} from "@/lib/execution-host/prompt-owners";
import { countLiveRuns } from "@/lib/scheduler";
import { seedAgentRun } from "@/test-support/agent-run-seed";
import {
  createFakeExecutionHost,
  fakeExecutionHosts,
} from "@/test-support/fake-execution-host";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";
import { mkdtempReal } from "@/test-support/worktree-test-root";

let database: StartedPostgresTestDb;
let db: Db;
let runtimeRoot: string;
let fake: FakeExecutionHost;
let hosts: ExecutionHosts;
const previousWorktreesRoot = process.env.MAISTER_WORKTREES_ROOT;
const previousRuntimeRoot = process.env.MAISTER_RUNTIME_ROOT;

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));

const definition = `---\nname: Researcher\ndescription: d\nworkspace: none\nmode: session\nplatform_mcp: false\ntriggers:\n  - manual\nrisk_tier: read_only\n---\nResearch the repository\n`;
const resultContract: RunResultContract = {
  kind: "agent_profile",
  profileName: "research",
  schemaRef: "fixture@abcdef123456:research-result.v1",
  schemaVersion: 1,
  sha256: "f".repeat(64),
  required: true,
  schema: {
    schemaVersion: 1,
    fields: [{ name: "summary", type: "string", required: true }],
  },
  sourceFlowRevisionId: "rev-1",
};

beforeAll(async () => {
  database = await startMainPostgresTestDb({
    databaseName: "agent_application_quiescence",
  });
  db = database.db as unknown as Db;
  runtimeRoot = await mkdtempReal("agent-application-quiescence-");
  process.env.MAISTER_WORKTREES_ROOT = join(runtimeRoot, "worktrees");
  process.env.MAISTER_RUNTIME_ROOT = join(runtimeRoot, "manager");
}, 180_000);

beforeEach(async () => {
  fake = createFakeExecutionHost();
  fake.setPromptBehavior(() => new Promise(() => {}));
  ({ hosts } = await fakeExecutionHosts(db, { fake }));
});

afterEach(async () => {
  await fake.releaseIngest();
  await fake.waitForCanonicalEvents();
  await stopRuntimeEventConsumers();
});

afterAll(async () => {
  if (previousWorktreesRoot === undefined)
    delete process.env.MAISTER_WORKTREES_ROOT;
  else process.env.MAISTER_WORKTREES_ROOT = previousWorktreesRoot;
  if (previousRuntimeRoot === undefined)
    delete process.env.MAISTER_RUNTIME_ROOT;
  else process.env.MAISTER_RUNTIME_ROOT = previousRuntimeRoot;
  await database?.stop();
});

async function detachedPrompt(
  contract: RunResultContract | null = null,
): Promise<ExecutionCommand> {
  const runId = await seedAgentRun(db, {
    runtimeRoot,
    definition,
    workspace: "none",
    resultContract: contract,
  });

  return detachPromptFromRun(runId);
}

async function detachPromptFromRun(runId: string): Promise<ExecutionCommand> {
  const { command, driving } = await beginInterruptedPrompt(runId);

  await driving;

  return command;
}

async function beginInterruptedPrompt(runId: string): Promise<
  Readonly<{
    command: ExecutionCommand;
    driving: ReturnType<typeof startAgentSession>;
  }>
> {
  const controller = new AbortController();
  const driving = startAgentSession(runId, {
    db,
    executionHosts: hosts,
    signal: controller.signal,
  });

  await expect
    .poll(
      async () => {
        const [command] = await db
          .select()
          .from(executionCommands)
          .where(
            and(
              eq(executionCommands.runId, runId),
              eq(executionCommands.kind, "session.prompt"),
            ),
          );

        return command?.state;
      },
      { timeout: 30_000, interval: 25 },
    )
    .toBe("accepted");
  controller.abort();
  const [command] = await db
    .select()
    .from(executionCommands)
    .where(
      and(
        eq(executionCommands.runId, runId),
        eq(executionCommands.kind, "session.prompt"),
      ),
    );

  return { command, driving };
}

async function completedDetachedPrompt(): Promise<ExecutionCommand> {
  let complete: ((result: PromptResult) => void) | undefined;

  fake.setPromptBehavior(
    () =>
      new Promise<PromptResult>((resolve) => {
        complete = resolve;
      }),
  );
  fake.setStreamEvents([
    {
      type: "session.update",
      sessionId: "fake",
      monotonicId: 1,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: '```json maister:output\n{"summary":"original answer"}\n```',
        },
      },
    },
  ]);
  const command = await detachedPrompt(resultContract);

  expect(complete).toBeDefined();
  complete!({ stopReason: "end_turn", meta: null });
  await fake.waitForCanonicalEvents();
  const [completed] = await db
    .select()
    .from(executionCommands)
    .where(eq(executionCommands.id, command.id));

  expect(completed).toMatchObject({
    state: "succeeded",
    completionAppliedAt: null,
  });

  return completed;
}

function stopOriginalSession(command: ExecutionCommand): Promise<void> {
  const owner = PromptOwnerSchema.parse({
    kind: command.ownerKind,
    ref: command.ownerRef,
  });

  if (owner.kind !== "agent_turn" || owner.ref.variant !== "initial")
    throw new Error("fixture requires an initial agent prompt");

  return stopAgentPromptSession(
    db,
    owner.ref,
    command.targetSessionId,
    command.id,
    AbortSignal.timeout(5_000),
  );
}

async function expectSlotRetained(
  command: ExecutionCommand,
  occupied: number,
): Promise<void> {
  expect(
    await db
      .select({ status: runs.status })
      .from(runs)
      .where(eq(runs.id, command.runId)),
  ).toEqual([{ status: "Running" }]);
  expect(
    await db
      .select({ state: executionAssignments.state })
      .from(executionAssignments)
      .where(eq(executionAssignments.id, command.executionAssignmentId)),
  ).toEqual([{ state: "active" }]);
  expect(await countLiveRuns(db as never, "agent")).toBe(occupied);
}

describe("agent application quiescence", () => {
  it("applies the original successful result after more than six minutes of deferred teardown, including exit arriving during preparation", async () => {
    const command = await completedDetachedPrompt();
    const occupied = await countLiveRuns(db as never, "agent");
    const apply = () =>
      applyPromptOwner({
        db,
        owners: agentPromptOwners,
        commandId: command.id,
        signal: AbortSignal.timeout(10_000),
      });

    fake.holdIngest();
    expect(await apply()).toBe("deferred");
    const [deferred] = await db
      .select()
      .from(executionCommands)
      .where(eq(executionCommands.id, command.id));
    const deferredSince = new Date(Date.now() - 393_000).toISOString();

    expect(deferred).toMatchObject({
      applicationState: "pending",
      applicationAttempts: 0,
      completionAppliedAt: null,
      applicationClaimOwner: null,
      applicationClaimExpiresAt: null,
    });
    await db
      .update(executionCommands)
      .set({
        applicationNextRetryAt: null,
        applicationError: { ...deferred.applicationError!, deferredSince },
      })
      .where(eq(executionCommands.id, command.id));
    const exitArrivesDuringPreparation = createPromptOwnerRegistry([
      {
        ...agentPromptOwner,
        prepare: async (input) => {
          try {
            return await agentPromptOwner.prepare(input);
          } catch (error) {
            if (error instanceof PromptOwnerDeferred)
              await fake.releaseIngest();
            throw error;
          }
        },
      },
    ]);

    expect(
      await applyPromptOwner({
        db,
        owners: exitArrivesDuringPreparation,
        commandId: command.id,
        signal: AbortSignal.timeout(10_000),
      }),
    ).toBe("deferred");
    const [stalled] = await db
      .select()
      .from(executionCommands)
      .where(eq(executionCommands.id, command.id));

    expect(stalled).toMatchObject({
      state: "succeeded",
      applicationState: "pending",
      applicationAttempts: 0,
      applicationClaimOwner: null,
      applicationClaimExpiresAt: null,
      completionAppliedAt: null,
      applicationError: {
        reason: "prompt_owner_stalled",
        classification: "deferred",
        stage: "session_teardown",
        deferredSince,
      },
    });
    expect(stalled.applicationNextRetryAt).not.toBeNull();
    await expectSlotRetained(command, occupied);
    expect(
      await db
        .select()
        .from(runResults)
        .where(eq(runResults.runId, command.runId)),
    ).toHaveLength(0);
    await db
      .update(executionCommands)
      .set({ applicationNextRetryAt: null })
      .where(eq(executionCommands.id, command.id));
    expect(await apply()).toBe("applied");
    expect(await apply()).toBe("deferred");
    expect(
      await db
        .select({ status: runs.status })
        .from(runs)
        .where(eq(runs.id, command.runId)),
    ).toEqual([{ status: "Done" }]);
    expect(
      await db
        .select({ validity: runResults.validity, value: runResults.value })
        .from(runResults)
        .where(eq(runResults.runId, command.runId)),
    ).toEqual([{ validity: "valid", value: { summary: "original answer" } }]);
    expect(
      await db
        .select({ state: agentTurns.state, commandId: agentTurns.commandId })
        .from(agentTurns)
        .where(eq(agentTurns.runId, command.runId)),
    ).toEqual([{ state: "applied", commandId: command.id }]);
    const [applied] = await db
      .select()
      .from(executionCommands)
      .where(eq(executionCommands.id, command.id));

    expect(applied).toMatchObject({
      applicationState: "applied",
      applicationAttempts: 0,
      applicationClaimOwner: null,
      applicationClaimExpiresAt: null,
    });
    expect(applied.completionAppliedAt).not.toBeNull();
    expect(fake.callsOf("deleteSession")).toHaveLength(1);
    expect(
      await db
        .select({ id: executionCommands.id })
        .from(executionCommands)
        .where(
          and(
            eq(executionCommands.runId, command.runId),
            eq(executionCommands.kind, "session.prompt"),
          ),
        ),
    ).toEqual([{ id: command.id }]);
    expect(
      await db
        .select({ kind: domainEvents.kind })
        .from(domainEvents)
        .where(
          and(
            eq(domainEvents.runId, command.runId),
            eq(domainEvents.kind, "run.done"),
          ),
        ),
    ).toEqual([{ kind: "run.done" }]);
    expect(
      await db
        .select()
        .from(domainEvents)
        .where(
          and(
            eq(domainEvents.runId, command.runId),
            eq(domainEvents.kind, "run.failed"),
          ),
        ),
    ).toHaveLength(0);
  });

  it("operational Stop retains its owner until the exact delayed canonical exit commits", async () => {
    const runId = await seedAgentRun(db, {
      runtimeRoot,
      definition:
        "---\nname: Operator\ndescription: controlled delayed exit\nkind: operational\ncompletion: {contract: operational_v1}\nmode: session\nworkspace: worktree\ntriggers: [manual]\nrisk_tier: read_only\nplatform_mcp: false\n---\nPerform the controlled operation.",
      workspace: "worktree",
      resultContract: null,
      operational: true,
    });
    const { command, driving } = await beginInterruptedPrompt(runId);
    const occupied = await countLiveRuns(db as never, "agent");

    fake.holdIngest();
    let settled = false;
    let stopError: unknown;
    const stopping = stopWorkbenchRun(runId, {
      deps: {
        ...depsFromOptions(undefined),
        executionHosts: hosts,
        requireActiveSession: async () => ({ id: "controlled-stop-user" }),
        authorize: async () => undefined,
      },
    }).then(
      (result) => {
        settled = true;

        return result;
      },
      (error: unknown) => {
        settled = true;
        stopError = error;
        throw error;
      },
    );

    void stopping.catch(() => undefined);
    try {
      await expect
        .poll(() => settled || runEventWakeBus.waiterCount(runId) > 0, {
          timeout: 2_000,
        })
        .toBe(true);
      if (stopError instanceof Error) throw stopError;
      expect(runEventWakeBus.waiterCount(runId)).toBeGreaterThan(0);
      expect(fake.callsOf("deleteSession")).toHaveLength(1);
      expect(settled).toBe(false);
      await expectSlotRetained(command, occupied);
      const owner = {
        id: runId,
        executionAssignmentId: command.executionAssignmentId,
      };

      await expect(
        waitForAgentCancellationExecutionQuiescent(
          db,
          owner,
          performance.now() + 20,
        ),
      ).rejects.toMatchObject({
        details: { reason: "agent_execution_quiescence_unproven" },
      });
      await expect(
        waitForAgentCancellationExecutionQuiescent(
          db,
          { ...owner, executionAssignmentId: randomUUID() },
          performance.now() + 20,
        ),
      ).rejects.toMatchObject({
        details: { reason: "agent_execution_quiescence_unproven" },
      });
      await expectSlotRetained(command, occupied);
      const missedWake = waitForAgentCancellationExecutionQuiescent(
        db,
        owner,
        performance.now() + 80,
      );
      const silenceLocalWake = vi
        .spyOn(runEventWakeBus, "wake")
        .mockImplementation(() => undefined);

      try {
        await fake.releaseIngest();
        // Simulate a commit in another process: no local EventEmitter wake.
        // The final strict deadline read must find the actual durable exit.
        await expect(missedWake).resolves.toBeUndefined();
      } finally {
        silenceLocalWake.mockRestore();
      }
      runEventWakeBus.wake(runId);
      await expect(stopping).resolves.toMatchObject({
        ok: true,
        runStatus: "Abandoned",
        supervisorStopped: true,
      });
      expect(fake.callsOf("deleteSession")).toHaveLength(1);
      expect(
        await db
          .select({ status: runs.status })
          .from(runs)
          .where(eq(runs.id, runId)),
      ).toEqual([{ status: "Abandoned" }]);
      expect(
        await db
          .select({ state: executionAssignments.state })
          .from(executionAssignments)
          .where(eq(executionAssignments.id, command.executionAssignmentId)),
      ).toEqual([{ state: "released" }]);
    } finally {
      await fake.releaseIngest();
      if (
        command.targetSessionId &&
        fake.sessions.get(command.targetSessionId)?.status === "live"
      ) {
        const client = await hosts.forRun(runId, { teardown: true });

        await client.deleteSession(command.targetSessionId);
      }
      await stopping.catch(() => undefined);
      await driving;
    }
  });

  it("reuses a successful delete while canonical teardown is delayed, then catches up", async () => {
    const command = await completedDetachedPrompt();
    const occupied = await countLiveRuns(db as never, "agent");

    fake.holdIngest();
    await expect(stopOriginalSession(command)).rejects.toMatchObject({
      details: { causeCode: "agent_session_teardown_pending" },
    });
    await expect(stopOriginalSession(command)).rejects.toMatchObject({
      details: { causeCode: "agent_session_teardown_pending" },
    });
    expect(fake.callsOf("deleteSession")).toHaveLength(1);
    expect(
      await db
        .select({ state: executionCommands.state })
        .from(executionCommands)
        .where(
          and(
            eq(executionCommands.runId, command.runId),
            eq(executionCommands.kind, "session.delete"),
          ),
        ),
    ).toEqual([{ state: "succeeded" }]);
    await expectSlotRetained(command, occupied);
    await fake.releaseIngest();
    await expect(stopOriginalSession(command)).resolves.toBeUndefined();
    expect(fake.callsOf("deleteSession")).toHaveLength(1);
    expect(
      await db
        .select({ state: runSessionIncarnations.state })
        .from(runSessionIncarnations)
        .where(eq(runSessionIncarnations.runId, command.runId)),
    ).toEqual([{ state: "exited" }]);
  });

  it("an absent host session and successful delete do not release an unconfirmed execution", async () => {
    const command = await detachedPrompt();
    const occupied = await countLiveRuns(db as never, "agent");
    const session = fake.sessions.get(command.targetSessionId!);

    expect(session).toBeDefined();
    try {
      fake.sessions.delete(command.targetSessionId!);
      await expect(stopOriginalSession(command)).rejects.toMatchObject({
        details: { causeCode: "agent_session_teardown_pending" },
      });
      await expect(
        assertAgentExecutionQuiescent(db, {
          id: command.runId,
          executionAssignmentId: command.executionAssignmentId,
        }),
      ).rejects.toMatchObject({
        details: { reason: "agent_execution_quiescence_unproven" },
      });
      await expectSlotRetained(command, occupied);
    } finally {
      // Restore the host fixture so its pending promise can be stopped and
      // drained; the assertions above deliberately observed no exit event.
      fake.sessions.set(command.targetSessionId!, session!);
      const client = await hosts.forAssignment({
        id: command.executionAssignmentId,
      });

      await client.deleteSession(command.targetSessionId!);
    }
  });

  it("failed teardown keeps the run and assignment live until a safe retry", async () => {
    const command = await detachedPrompt();
    const occupied = await countLiveRuns(db as never, "agent");

    fake.failOnce(
      "deleteSession",
      new MaisterError("EXECUTOR_UNAVAILABLE", "fixture teardown unavailable", {
        details: { reason: "fixture_teardown_unavailable" },
      }),
    );
    await expect(stopOriginalSession(command)).rejects.toMatchObject({
      details: { reason: "fixture_teardown_unavailable" },
    });
    await expectSlotRetained(command, occupied);
    await expect(
      assertAgentExecutionQuiescent(db, {
        id: command.runId,
        executionAssignmentId: command.executionAssignmentId,
      }),
    ).rejects.toMatchObject({
      details: { reason: "agent_execution_quiescence_unproven" },
    });
    await expect(stopOriginalSession(command)).resolves.toBeUndefined();
  });
});
