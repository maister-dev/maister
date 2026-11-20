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

import { stat } from "node:fs/promises";
import { disposeOperationalRun } from "@/lib/gc/operational-disposition";
import { reconcileHistoricalAgentLifecycle } from "@/lib/execution-host/events/lifecycle-projector";
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
import {
  mintAssignment,
  releaseAssignmentForRun,
} from "@/lib/execution-host/assignments";
import { MaisterError } from "@/lib/errors";
import { stopRuntimeEventConsumers } from "@/lib/execution-host/events/consumer";
import { PromptOwnerSchema } from "@/lib/execution-host/prompt-owner-contract";
import { applyPromptOwner } from "@/lib/execution-host/prompt-owner-application";
import {
  createPromptOwnerRegistry,
  PromptOwnerDeferred,
} from "@/lib/execution-host/prompt-owners";
import { countLiveRuns } from "@/lib/scheduler";
import { git } from "@/test-support/git-fixture";
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

async function seedUndispatchedOperationalResume(
  workspace: "worktree" | "repo_read" = "worktree",
  holdHistoricalExit = false,
) {
  const runId = await seedAgentRun(db, {
    runtimeRoot,
    definition: `---\nname: Operator\ndescription: Recovery fixture\nkind: operational\ncompletion: {contract: operational_v1}\nmode: session\nworkspace: ${workspace}\n${workspace === "repo_read" ? "workspace_ref: main\n" : ""}triggers: [manual]\nrisk_tier: read_only\nplatform_mcp: false\n---\nPerform the controlled operation.`,
    workspace,
    resultContract: null,
    operational: true,
  });
  const command = await detachPromptFromRun(runId);
  const client = await hosts.forRun(runId);
  expect(command.targetSessionId).toBeTruthy();
  if (holdHistoricalExit) fake.holdIngest();
  await client.checkpoint(command.targetSessionId!);
  if (!holdHistoricalExit) await fake.waitForCanonicalEvents();
  const [initial] = await db
    .select()
    .from(agentTurns)
    .where(eq(agentTurns.runId, runId));

  const resumed = await db.transaction(async (tx) => {
    await tx
      .update(agentTurns)
      .set({
        state: workspace === "repo_read" ? "applied" : "superseded",
        completedAt: new Date(),
      })
      .where(eq(agentTurns.id, initial.id));
    if (workspace === "repo_read")
      await releaseAssignmentForRun(tx, runId, "parked");
    const successor = await mintAssignment(tx, {
      runId,
      hostId: client.assignment.executionHostId,
      reason: "resume",
    });
    const [turn] = await tx
      .insert(agentTurns)
      .values({
        runId,
        ordinal: initial.ordinal + 1,
        variant: "resume",
        logicalKey: "incident-resume",
        prompt: initial.prompt,
        state: "claimed",
        executionAssignmentId: successor.id,
        assignmentEpoch: successor.epoch,
        runSessionId: initial.runSessionId,
      })
      .returning();
    await tx
      .update(runSessionIncarnations)
      .set({ state: "active", endedAt: null, terminalReason: null })
      .where(
        eq(runSessionIncarnations.executionAssignmentId, client.assignment.id),
      );
    return { successor, turn };
  });
  return { runId, command, client, resumed };
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

  it("IT-APR-09 Stop abandons a claimed resume without waiting for its historical checkpoint", async () => {
    const { runId, client, resumed } =
      await seedUndispatchedOperationalResume();
    const occupied = await countLiveRuns(db as never, "agent");

    expect(await client.sessionsForRun()).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ status: "live" })]),
    );
    expect(
      await db
        .select()
        .from(executionCommands)
        .where(
          eq(executionCommands.executionAssignmentId, resumed.successor.id),
        ),
    ).toEqual([]);

    await expect(
      stopWorkbenchRun(runId, {
        deps: {
          ...depsFromOptions(undefined),
          executionHosts: hosts,
          requireActiveSession: async () => ({ id: "controlled-stop-user" }),
          authorize: async () => undefined,
        },
      }),
    ).resolves.toMatchObject({
      ok: true,
      runStatus: "Abandoned",
      supervisorStopped: false,
    });
    const [turn] = await db
      .select()
      .from(agentTurns)
      .where(eq(agentTurns.id, resumed.turn.id));
    const [assignment] = await db
      .select()
      .from(executionAssignments)
      .where(eq(executionAssignments.id, resumed.successor.id));
    expect(turn.state).toBe("superseded");
    expect(assignment.state).toBe("released");
    expect(await countLiveRuns(db as never, "agent")).toBe(occupied - 1);
    expect(
      await db
        .select({
          actorType: domainEvents.actorType,
          actorId: domainEvents.actorId,
        })
        .from(domainEvents)
        .where(
          and(
            eq(domainEvents.runId, runId),
            eq(domainEvents.kind, "run.abandoned"),
          ),
        ),
    ).toEqual([{ actorType: "user", actorId: "controlled-stop-user" }]);
  }, 30_000);

  it("IT-APR-12 retains the abandoned checkout until historical evidence arrives", async () => {
    const { runId } = await seedUndispatchedOperationalResume(
      "repo_read",
      true,
    );
    const [run] = await db.select().from(runs).where(eq(runs.id, runId));
    const owner = run.operationalIntegrityBaseline?.owner;
    if (!owner || !("repoPath" in owner))
      throw new Error("expected frozen checkout");
    const checkout = owner.cwd;
    const stopped = await stopWorkbenchRun(runId, {
      deps: {
        ...depsFromOptions(undefined),
        executionHosts: hosts,
        requireActiveSession: async () => ({ id: "controlled-stop-user" }),
        authorize: async () => undefined,
      },
    });
    expect(stopped.runStatus).toBe("Abandoned");
    expect(await disposeOperationalRun(runId, { db, hosts })).toBe("deferred");
    expect(await stat(checkout)).toBeDefined();
    expect(
      await git(owner.repoPath, "worktree", "list", "--porcelain"),
    ).toContain(checkout);
    expect(fake.callsOf("releaseWorkspace")).toHaveLength(0);
    await fake.releaseIngest();
    await fake.waitForCanonicalEvents();
    const [pending] = await db.select().from(runs).where(eq(runs.id, runId));
    const due = pending.operationalCleanup?.dueAt;
    if (!due) throw new Error("expected a durable disposition retry");
    expect(
      await disposeOperationalRun(runId, {
        db,
        hosts,
        now: new Date(Date.parse(due) + 1),
      }),
    ).toBe("released");
    await expect(stat(checkout)).rejects.toMatchObject({ code: "ENOENT" });
    expect(
      await git(owner.repoPath, "worktree", "list", "--porcelain"),
    ).not.toContain(checkout);
    expect(fake.callsOf("releaseWorkspace")).toHaveLength(1);
    const [released] = await db.select().from(runs).where(eq(runs.id, runId));
    expect(released.operationalCleanup).toMatchObject({
      state: "released",
      releasedAt: expect.any(String),
    });
  }, 45_000);

  it("IT-APR-04 repairs an exact released predecessor after its projection cursor advanced", async () => {
    const { runId, command, resumed } =
      await seedUndispatchedOperationalResume();
    expect(await reconcileHistoricalAgentLifecycle(db, runId)).toBe(1);
    expect(await reconcileHistoricalAgentLifecycle(db, runId)).toBe(0);
    const [incarnation] = await db
      .select()
      .from(runSessionIncarnations)
      .where(
        eq(
          runSessionIncarnations.executionAssignmentId,
          command.executionAssignmentId,
        ),
      );
    expect(incarnation.state).toBe("checkpointed");
    expect(incarnation.endedAt).toBeInstanceOf(Date);
    const [run] = await db.select().from(runs).where(eq(runs.id, runId));
    expect(run.executionAssignmentId).toBe(resumed.successor.id);
  }, 30_000);

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
      const silenceLocalWake = vi
        .spyOn(runEventWakeBus, "wake")
        .mockImplementation(() => undefined);

      try {
        await fake.releaseIngest();
        await fake.waitForCanonicalEvents();
        // Simulate a commit in another process: no local EventEmitter wake.
        // Even an expired wait must read the committed exit before refusing it.
        await expect(
          waitForAgentCancellationExecutionQuiescent(
            db,
            owner,
            performance.now() - 1,
          ),
        ).resolves.toBeUndefined();
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
