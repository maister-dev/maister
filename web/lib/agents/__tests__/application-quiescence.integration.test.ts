import type { ExecutionCommand } from "@/lib/db/schema";
import type { Db } from "@/lib/execution-host/db";
import type { ExecutionHosts } from "@/lib/execution-host/client";
import type { FakeExecutionHost } from "@/test-support/fake-execution-host";
import type { PromptResult } from "@/lib/supervisor-client";
import type { RunResultContract } from "@/lib/run-results/types";

import { randomUUID } from "node:crypto";
import { stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { and, eq, sql } from "drizzle-orm";
import { NextRequest } from "next/server";
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

import { POST as stopRunRoute } from "@/app/api/runs/[runId]/stop/route";
import { POST as abandonRunRoute } from "@/app/api/runs/[runId]/abandon/route";
import { POST as recheckContinuationRoute } from "@/app/api/runs/[runId]/operational/continuation/retry/route";
import { loadOperationalOutcome } from "@/lib/run-results/operational-projection";
import { requireProjectActionForUser } from "@/lib/authz";
import { disposeOperationalRun } from "@/lib/gc/operational-disposition";
import {
  projectCanonicalSessionLifecycle,
  reconcileHistoricalAgentLifecycle,
} from "@/lib/execution-host/events/lifecycle-projector";
import {
  claimAgentContinuation,
  recordAgentContinuationFailure,
  recoverAgentContinuationSettlement,
  settleAgentContinuation,
} from "@/lib/agents/continuation-episode";
import { startAgentSession } from "@/lib/agents/launch";
import { startAgentContinuationWorker } from "@/lib/agents/continuation-worker";
import { issueAgentRunToken } from "@/lib/agents/tokens";
import {
  inspectOperationalRun,
  operationalWorkspace,
} from "@/lib/agents/operational-context";
import { captureOperationalBaseline } from "@/lib/agents/operational-integrity";
import {
  assertAgentExecutionQuiescent,
  waitForAgentCancellationExecutionQuiescent,
} from "@/lib/agents/execution-quiescence";
import { runEventWakeBus } from "@/lib/execution-host/events/run-wake";
import {
  depsFromOptions,
  stopWorkbenchRun,
  stopWorkbenchRunForToken,
} from "@/lib/workbench-lifecycle/service";
import {
  agentPromptOwner,
  agentPromptOwners,
  stopAgentPromptSession,
} from "@/lib/agents/prompt-owner";
import {
  agentContinuationEpisodes,
  agentIncidentOccurrences,
  agentPreparationOperations,
  agentTurns,
  domainEvents,
  executionAssignments,
  executionCommands,
  projectTokens,
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
import { startPromptOwnerWorker } from "@/lib/execution-host/prompt-owner-recovery";
import {
  createPromptOwnerRegistry,
  PromptOwnerDeferred,
} from "@/lib/execution-host/prompt-owners";
import { countLiveRuns } from "@/lib/scheduler";
import { withRepositoryMutationFence } from "@/lib/project-config-persistence/repository-lock";
import { addDetachedWorktree } from "@/lib/worktree";
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
vi.mock("@/lib/authz", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/authz")>()),
  requireActiveSession: async () => ({ id: "controlled-stop-user" }),
  requireActiveUserById: async (id: string) => ({ id }),
  requireProjectAction: vi.fn(),
  requireProjectActionForUser: vi.fn(),
}));

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
  // Worker tests must see only the Runs and host receipts from their own scenario.
  await db.execute(sql`TRUNCATE TABLE runs CASCADE`);
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
  beforeLaunch?: (runId: string) => Promise<void>,
) {
  const runId = await seedAgentRun(db, {
    runtimeRoot,
    definition: `---\nname: Operator\ndescription: Recovery fixture\nkind: operational\ncompletion: {contract: operational_v1}\nmode: session\nworkspace: ${workspace}\n${workspace === "repo_read" ? "workspace_ref: main\n" : ""}triggers: [manual]\nrisk_tier: read_only\nplatform_mcp: false\n---\nPerform the controlled operation.`,
    workspace,
    resultContract: null,
    operational: true,
  });
  await beforeLaunch?.(runId);
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

async function freezeLegacyCheckout(runId: string): Promise<void> {
  const [seeded] = await db.select().from(runs).where(eq(runs.id, runId));
  const context = await operationalWorkspace(db, seeded);
  if (context.ownerKind !== "project")
    throw new Error("expected project checkout allocation");
  const { cwd, repoPath, projectSlug } = context;
  await addDetachedWorktree({
    projectRepoPath: repoPath,
    worktreePath: cwd,
    committish: "main",
  });
  const baseline = await captureOperationalBaseline(
    db,
    cwd,
    "ephemeral_checkout",
    {
      legacyEphemeral: true,
    },
  );
  await db
    .update(runs)
    .set({
      operationalIntegrityBaseline: {
        ...baseline,
        owner: { cwd, repoPath, projectSlug },
      },
    })
    .where(eq(runs.id, runId));
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

  it.each(["stop", "abandon", "token Stop"] as const)(
    "IT-APR-09 %s abandons a claimed resume without waiting for its historical checkpoint",
    async (action) => {
      const { runId, client, resumed } =
        await seedUndispatchedOperationalResume("worktree", true);
      const occupied = await countLiveRuns(db as never, "agent");
      const [run] = await db.select().from(runs).where(eq(runs.id, runId));
      if (!run.projectId || !run.agentId)
        throw new Error("expected a project agent Run owner");
      const { tokenId } = await issueAgentRunToken({
        db,
        runId,
        projectId: run.projectId,
        agentId: run.agentId,
      });

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

      const inventoryReads = fake.callsOf("listSessionsForRun").length;
      fake.loseResponseOnce("listSessionsForRun");
      await db.execute(sql`INSERT INTO users (id, email, role)
      VALUES ('controlled-stop-user', 'controlled-stop@example.test', 'admin')
      ON CONFLICT (id) DO NOTHING`);
      let cancellation: unknown;
      if (action === "token Stop") {
        cancellation = await stopWorkbenchRunForToken(runId, {
          projectId: run.projectId,
        });
      } else {
        const cancel = action === "stop" ? stopRunRoute : abandonRunRoute;
        const response = await cancel(
          new NextRequest(`http://localhost/api/runs/${runId}/${action}`, {
            method: "POST",
          }),
          { params: Promise.resolve({ runId }) },
        );
        expect(response.status).toBe(200);
        cancellation = await response.json();
      }
      expect(fake.callsOf("listSessionsForRun")).toHaveLength(inventoryReads);
      expect(cancellation).toMatchObject({
        ok: true,
        runStatus: "Abandoned",
        ...(action === "abandon" ? {} : { supervisorStopped: false }),
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
      expect(
        await db
          .select({ revokedAt: projectTokens.revoked_at })
          .from(projectTokens)
          .where(eq(projectTokens.id, tokenId)),
      ).toEqual([{ revokedAt: expect.any(Date) }]);
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
      ).toEqual([
        action === "token Stop"
          ? { actorType: "agent", actorId: run.agentId }
          : { actorType: "user", actorId: "controlled-stop-user" },
      ]);
    },
    30_000,
  );

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

  it("projects the exact successful checkpoint command when no session exit was ingested", async () => {
    const prompt = await completedDetachedPrompt();
    const runId = prompt.runId;
    const sessionId = prompt.targetSessionId!;
    const client = await hosts.forRun(runId);
    const session = fake.sessions.get(sessionId)!;
    session.status = "exited";
    await client.checkpoint(sessionId);
    const checkpoint = fake.callsOf("checkpointSession").at(-1)?.envelope;
    if (!checkpoint) throw new Error("expected a retained checkpoint command");
    const readState = async () => {
      const [incarnation] = await db
        .select({ state: runSessionIncarnations.state })
        .from(runSessionIncarnations)
        .where(eq(runSessionIncarnations.hostSessionId, sessionId));
      return incarnation?.state;
    };
    const publish = async (reportedSessionId: string, monotonicId: number) => {
      await fake.publishCanonical(checkpoint, sessionId, {
        type: "session.command",
        sessionId,
        monotonicId,
        commandId: checkpoint.command.id,
        kind: "session.checkpoint",
        phase: "completed",
        status: "succeeded",
        result: {
          sessionId: reportedSessionId,
          alreadyCheckpointed: true,
          monotonicId,
        },
      });
      await fake.waitForCanonicalEvents();
      await projectCanonicalSessionLifecycle({ db, runId });
    };
    await publish(randomUUID(), 1_000);
    expect(await readState()).toBe("active");
    await publish(sessionId, 1_001);
    expect(await readState()).toBe("checkpointed");
    await expect(
      assertAgentExecutionQuiescent(
        db,
        { id: runId, executionAssignmentId: client.assignment.id },
        undefined,
        hosts,
      ),
    ).resolves.toBeUndefined();
  }, 30_000);

  it("IT-APR-05 latches a definitive refusal and settles without a second preparation", async () => {
    const { runId, resumed } =
      await seedUndispatchedOperationalResume("repo_read");
    const [run] = await db.select().from(runs).where(eq(runs.id, runId));
    const owner = run.operationalIntegrityBaseline?.owner;
    expect(run.operationalIntegrityBaseline?.version).toBe(2);
    if (!owner) throw new Error("expected frozen checkout owner");
    await writeFile(
      join(owner.cwd, "new-source.ts"),
      "A foreign source mutation",
    );
    await startAgentSession(runId, { db, executionHosts: hosts });
    const attempts = await db
      .select()
      .from(agentPreparationOperations)
      .where(eq(agentPreparationOperations.assignmentId, resumed.successor.id));
    expect(attempts).toHaveLength(1);
    const [episode] = await db
      .select()
      .from(agentContinuationEpisodes)
      .where(eq(agentContinuationEpisodes.runId, runId));
    expect(episode).toMatchObject({
      state: "settlement",
      failure: { reason: "operational_integrity_refused" },
    });
    if ("kind" in owner) throw new Error("expected project checkout owner");
    await expect(
      withRepositoryMutationFence(owner.repoPath, async () => "released"),
    ).resolves.toBe("released");

    await startAgentSession(runId, { db, executionHosts: hosts });
    const [terminal] = await db.select().from(runs).where(eq(runs.id, runId));
    expect(terminal.status).toBe("Failed");
    expect(terminal.operationalTerminal?.reasonCodes).toContain(
      "operational_source_changed",
    );
    expect(
      await db
        .select({ reason: agentIncidentOccurrences.reasonCode })
        .from(agentIncidentOccurrences)
        .where(
          and(
            eq(agentIncidentOccurrences.runId, runId),
            eq(agentIncidentOccurrences.channel, "operational_terminal"),
          ),
        ),
    ).toEqual([{ reason: "operational_integrity_refused" }]);
    expect(
      await db
        .select()
        .from(agentPreparationOperations)
        .where(
          eq(agentPreparationOperations.assignmentId, resumed.successor.id),
        ),
    ).toHaveLength(1);
  }, 45_000);

  it("settles an unverifiable v1 continuation without changing its frozen witness", async () => {
    const { runId, resumed, command } = await seedUndispatchedOperationalResume(
      "repo_read",
      false,
      freezeLegacyCheckout,
    );
    const [before] = await db.select().from(runs).where(eq(runs.id, runId));
    expect(before.operationalIntegrityBaseline?.version).toBe(1);
    expect(await inspectOperationalRun(db, before)).toMatchObject({
      verdict: "clean",
    });
    const occupied = await countLiveRuns(db as never, "agent");
    await startAgentSession(runId, { db, executionHosts: hosts });
    expect(await recoverAgentContinuationSettlement(db, hosts, runId)).toBe(
      true,
    );
    expect(
      await applyPromptOwner({
        db,
        owners: agentPromptOwners,
        commandId: command.id,
        signal: AbortSignal.timeout(5_000),
      }),
    ).toBe("superseded");
    await startAgentSession(runId, { db, executionHosts: hosts });

    const [after] = await db.select().from(runs).where(eq(runs.id, runId));
    expect(after).toMatchObject({
      status: "Failed",
      operationalIntegrityBaseline: before.operationalIntegrityBaseline,
    });
    expect(after.operationalTerminal?.reasonCodes).toContain(
      "operational_legacy_baseline_unverifiable",
    );
    expect(await countLiveRuns(db as never, "agent")).toBe(occupied - 1);
    expect(
      await db
        .select()
        .from(agentPreparationOperations)
        .where(
          eq(agentPreparationOperations.assignmentId, resumed.successor.id),
        ),
    ).toHaveLength(0);
  }, 30_000);

  it("IT-APR-06 persists bounded, exclusive continuation admission across callers", async () => {
    const { runId, resumed, client } =
      await seedUndispatchedOperationalResume();
    let input = {
      runId,
      assignmentId: resumed.successor.id,
      logicalKey: resumed.turn.logicalKey,
    };
    const busy = new MaisterError("CONFLICT", "busy", {
      details: { reason: "operation_busy" },
    });
    for (let i = 1; i <= 5; i++) {
      const claims = await Promise.all([
        claimAgentContinuation(db, input),
        claimAgentContinuation(db, input),
      ]);
      const admitted = claims.filter((candidate) => candidate !== null);
      expect(admitted).toHaveLength(1);
      expect(admitted[0].attempts).toBe(i);
      if (i === 2) {
        // The worker dies before recording a failure. An expired claim spent its attempt.
        await db
          .update(agentContinuationEpisodes)
          .set({
            claimExpiresAt: sql`clock_timestamp() - interval '1 millisecond'`,
          })
          .where(eq(agentContinuationEpisodes.runId, runId));
        const successor = await db.transaction((tx) =>
          mintAssignment(tx, {
            runId,
            hostId: client.assignment.executionHostId,
            reason: "resume",
          }),
        );
        const [before] = await db
          .select()
          .from(agentContinuationEpisodes)
          .where(eq(agentContinuationEpisodes.runId, runId));
        await recordAgentContinuationFailure(db, admitted[0], busy, null, {
          runId,
        });
        expect(
          await db
            .select()
            .from(agentContinuationEpisodes)
            .where(eq(agentContinuationEpisodes.runId, runId)),
        ).toEqual([before]);
        input = { ...input, assignmentId: successor.id };
        continue;
      }
      await recordAgentContinuationFailure(db, admitted[0], busy, null, {
        runId,
      });
      if (i < 5) {
        expect(await claimAgentContinuation(db, input)).toBeNull();
        await db
          .update(agentContinuationEpisodes)
          .set({ dueAt: sql`clock_timestamp() - interval '1 millisecond'` })
          .where(eq(agentContinuationEpisodes.runId, runId));
      }
    }
    const settlement = await claimAgentContinuation(db, input);
    expect(settlement).toMatchObject({ state: "settlement", attempts: 5 });
    expect(settlement?.failure?.reason).toBe(
      "agent_continuation_attempts_exhausted",
    );
    if (!settlement) throw new Error("expected continuation settlement");
    await settleAgentContinuation(db, hosts, settlement);
    expect(await claimAgentContinuation(db, input)).toBeNull();
    expect(
      await db
        .select({ reason: agentIncidentOccurrences.reasonCode })
        .from(agentIncidentOccurrences)
        .where(eq(agentIncidentOccurrences.runId, runId)),
    ).toEqual([{ reason: "agent_continuation_attempts_exhausted" }]);
  }, 30_000);

  it("IT-APR-07 settles a historical prompt without opening its undispatched successor", async () => {
    const { runId, command, resumed } =
      await seedUndispatchedOperationalResume();
    await expect(
      applyPromptOwner({
        db,
        owners: agentPromptOwners,
        commandId: command.id,
        signal: AbortSignal.timeout(5_000),
      }),
    ).resolves.toBe("superseded");
    const [run] = await db.select().from(runs).where(eq(runs.id, runId));
    expect(run).toMatchObject({
      status: "Running",
      executionAssignmentId: resumed.successor.id,
    });
    const [retained] = await db
      .select()
      .from(executionCommands)
      .where(eq(executionCommands.id, command.id));
    expect(retained).toMatchObject({
      applicationState: "superseded",
      completionAppliedAt: null,
      applicationNextRetryAt: null,
    });
  }, 30_000);

  it.each([
    { limit: "age", ageMinutes: 16, priorAttempts: 0 },
    { limit: "count", ageMinutes: 1, priorAttempts: 9 },
  ])(
    "IT-APR-08 exhausts the prompt service budget by $limit without spending ordinary attempts",
    async ({ ageMinutes, priorAttempts }) => {
      const { command, runId } = await seedUndispatchedOperationalResume();
      const owners = createPromptOwnerRegistry([
        {
          ...agentPromptOwner,
          prepare: async () => {
            throw new MaisterError(
              "EXECUTOR_UNAVAILABLE",
              "test host unavailable",
              {
                details: { reason: "agent_execution_quiescence_unproven" },
              },
            );
          },
        },
      ]);
      await db
        .update(executionCommands)
        .set({
          applicationError: {
            phase: "prepare",
            reason: "prompt_owner_service_retry",
            deferredSince: new Date(
              Date.now() - ageMinutes * 60 * 1000,
            ).toISOString(),
            serviceRetryAttempts: priorAttempts,
          },
        })
        .where(eq(executionCommands.id, command.id));
      await expect(
        applyPromptOwner({
          db,
          owners,
          commandId: command.id,
          signal: AbortSignal.timeout(5_000),
        }),
      ).resolves.toBe("poisoned");
      const [retained] = await db
        .select()
        .from(executionCommands)
        .where(eq(executionCommands.id, command.id));
      expect(retained).toMatchObject({
        applicationState: "poisoned",
        applicationNextRetryAt: null,
        applicationAttempts: 0,
        applicationError: {
          reason: "operational_prompt_service_exhausted",
          serviceRetryAttempts: priorAttempts + 1,
        },
      });
      expect(
        await db
          .select({ reason: agentIncidentOccurrences.reasonCode })
          .from(agentIncidentOccurrences)
          .where(eq(agentIncidentOccurrences.runId, runId)),
      ).toEqual([{ reason: "operational_prompt_service_exhausted" }]);
    },
    30_000,
  );

  it.each(["historical-prompt-first", "continuation-first"] as const)(
    "IT-APR-11 converges after an owner handoff in %s ordering",
    async (order) => {
      const { runId, command, resumed } =
        await seedUndispatchedOperationalResume("repo_read");
      const [run] = await db.select().from(runs).where(eq(runs.id, runId));
      const checkout = run.operationalIntegrityBaseline?.owner?.cwd;
      if (!checkout) throw new Error("expected frozen checkout");
      await writeFile(join(checkout, "foreign"), "Changed retained source");
      const occupied = await countLiveRuns(db as never, "agent");
      const settleOriginalPrompt = async () => {
        const worker = startPromptOwnerWorker({
          db,
          owners: agentPromptOwners,
        });
        try {
          await expect
            .poll(
              async () => {
                const [retained] = await db
                  .select()
                  .from(executionCommands)
                  .where(eq(executionCommands.id, command.id));
                return retained.applicationState;
              },
              { timeout: 8_000 },
            )
            .toBe("superseded");
        } finally {
          await worker.stop();
        }
      };

      if (order === "historical-prompt-first") await settleOriginalPrompt();
      await startAgentSession(runId, { db, executionHosts: hosts });

      // A newly bound driver uses the persisted settlement, without reopening Git ownership.
      const restarted = (await fakeExecutionHosts(db, { fake })).hosts;
      const worker = startAgentContinuationWorker({
        db,
        executionHosts: restarted,
      });
      try {
        await expect
          .poll(
            async () => {
              const [settled] = await db
                .select()
                .from(runs)
                .where(eq(runs.id, runId));
              return settled.status;
            },
            { timeout: 8_000 },
          )
          .toBe("Failed");
      } finally {
        await worker.stop();
      }
      if (order === "continuation-first") await settleOriginalPrompt();
      await startAgentSession(runId, { db, executionHosts: restarted });

      const [settled] = await db.select().from(runs).where(eq(runs.id, runId));
      expect(settled.status).toBe("Failed");
      expect(await countLiveRuns(db as never, "agent")).toBe(occupied - 1);
      expect(
        await db
          .select()
          .from(executionCommands)
          .where(
            and(
              eq(executionCommands.executionAssignmentId, resumed.successor.id),
              eq(executionCommands.kind, "session.create"),
            ),
          ),
      ).toHaveLength(0);
      expect(
        await db
          .select()
          .from(agentPreparationOperations)
          .where(
            eq(agentPreparationOperations.assignmentId, resumed.successor.id),
          ),
      ).toHaveLength(1);
    },
    45_000,
  );

  it("publishes one terminal transition when Stop races a latched refusal", async () => {
    const { runId, resumed } =
      await seedUndispatchedOperationalResume("repo_read");
    const [run] = await db.select().from(runs).where(eq(runs.id, runId));
    const checkout = run.operationalIntegrityBaseline?.owner?.cwd;
    if (!checkout) throw new Error("expected frozen checkout");
    await writeFile(join(checkout, "foreign"), "Changed source before resume");
    await startAgentSession(runId, { db, executionHosts: hosts });

    await Promise.allSettled([
      recoverAgentContinuationSettlement(db, hosts, runId),
      stopRunRoute(
        new Request(`http://localhost/api/runs/${runId}/stop`, {
          method: "POST",
        }),
        { params: Promise.resolve({ runId }) },
      ),
    ]);

    const [settled] = await db.select().from(runs).where(eq(runs.id, runId));
    expect(["Abandoned", "Failed"]).toContain(settled.status);
    const [turn] = await db
      .select()
      .from(agentTurns)
      .where(eq(agentTurns.id, resumed.turn.id));
    expect(turn.state).toBe("superseded");
    const terminalEvents = await db
      .select({ kind: domainEvents.kind })
      .from(domainEvents)
      .where(
        and(
          eq(domainEvents.runId, runId),
          sql`${domainEvents.kind} IN ('run.abandoned', 'run.failed')`,
        ),
      );
    expect(terminalEvents).toEqual([
      {
        kind: settled.status === "Abandoned" ? "run.abandoned" : "run.failed",
      },
    ]);
    expect(
      await db
        .select()
        .from(executionCommands)
        .where(
          eq(executionCommands.executionAssignmentId, resumed.successor.id),
        ),
    ).toHaveLength(0);
  }, 30_000);

  it("advances due work while another Run is in backoff", async () => {
    const waiting = await seedUndispatchedOperationalResume();
    const claim = await claimAgentContinuation(db, {
      runId: waiting.runId,
      assignmentId: waiting.resumed.successor.id,
      logicalKey: waiting.resumed.turn.logicalKey,
    });
    if (!claim) throw new Error("expected first continuation claim");
    await recordAgentContinuationFailure(
      db,
      claim,
      new MaisterError("CONFLICT", "Repository is busy", {
        details: { reason: "operation_busy" },
      }),
      null,
      { runId: waiting.runId },
    );
    await db
      .update(agentContinuationEpisodes)
      .set({
        dueAt: sql`clock_timestamp() + interval '10 minutes'`,
      })
      .where(eq(agentContinuationEpisodes.runId, waiting.runId));

    const due = await seedUndispatchedOperationalResume("repo_read");
    const [run] = await db.select().from(runs).where(eq(runs.id, due.runId));
    const checkout = run.operationalIntegrityBaseline?.owner?.cwd;
    if (!checkout) throw new Error("expected frozen checkout");
    await writeFile(join(checkout, "foreign"), "Changed due source");

    const worker = startAgentContinuationWorker({ db, executionHosts: hosts });
    try {
      await expect
        .poll(
          async () => {
            const [settled] = await db
              .select()
              .from(runs)
              .where(eq(runs.id, due.runId));
            return settled.status;
          },
          { timeout: 8_000 },
        )
        .toBe("Failed");
    } finally {
      await worker.stop();
    }
    const [paused] = await db
      .select()
      .from(agentContinuationEpisodes)
      .where(eq(agentContinuationEpisodes.runId, waiting.runId));
    expect(paused).toMatchObject({ state: "backoff", attempts: 1 });
    expect(
      await db
        .select()
        .from(agentPreparationOperations)
        .where(
          eq(
            agentPreparationOperations.assignmentId,
            waiting.resumed.successor.id,
          ),
        ),
    ).toHaveLength(0);
  }, 30_000);

  it("parks settlement with one incident until historical exit evidence arrives", async () => {
    const { runId, resumed } = await seedUndispatchedOperationalResume(
      "repo_read",
      true,
    );
    const [run] = await db.select().from(runs).where(eq(runs.id, runId));
    const checkout = run.operationalIntegrityBaseline?.owner?.cwd;
    if (!checkout) throw new Error("expected frozen checkout");
    await writeFile(join(checkout, "foreign"), "Changed retained source");
    await startAgentSession(runId, { db, executionHosts: hosts });

    for (let attempt = 1; attempt <= 5; attempt++) {
      await expect(
        recoverAgentContinuationSettlement(db, hosts, runId),
      ).rejects.toMatchObject({
        code: "EXECUTOR_UNAVAILABLE",
        details: { reason: "agent_execution_quiescence_unproven" },
      });
      if (attempt < 5) {
        await db
          .update(agentContinuationEpisodes)
          .set({
            dueAt: sql`clock_timestamp() - interval '1 millisecond'`,
          })
          .where(eq(agentContinuationEpisodes.runId, runId));
      }
    }
    const [attention] = await db
      .select()
      .from(agentContinuationEpisodes)
      .where(eq(agentContinuationEpisodes.runId, runId));
    expect(attention).toMatchObject({
      state: "attention",
      settlementAttempts: 5,
    });
    await recoverAgentContinuationSettlement(db, hosts, runId);
    expect(
      await db
        .select()
        .from(agentIncidentOccurrences)
        .where(eq(agentIncidentOccurrences.runId, runId)),
    ).toHaveLength(1);

    await fake.releaseIngest();
    await fake.waitForCanonicalEvents();
    expect(await recoverAgentContinuationSettlement(db, hosts, runId)).toBe(
      true,
    );
    const [settled] = await db.select().from(runs).where(eq(runs.id, runId));
    expect(settled.status).toBe("Failed");
    expect(
      await db
        .select()
        .from(agentPreparationOperations)
        .where(
          eq(agentPreparationOperations.assignmentId, resumed.successor.id),
        ),
    ).toHaveLength(1);
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

  it("IT-APR-03 an absent host session and successful delete do not release an unconfirmed execution", async () => {
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

it("settles source refusal after create without admitting a prompt or preparing again", async () => {
  const { runId, resumed } =
    await seedUndispatchedOperationalResume("repo_read");
  const [run] = await db.select().from(runs).where(eq(runs.id, runId));
  const cwd = run.operationalIntegrityBaseline?.owner?.cwd;
  if (!cwd) throw new Error("no checkout");
  const remove = fake.onCall("createSession", () =>
    writeFile(join(cwd, "late-change"), "changed"),
  );
  try {
    await startAgentSession(runId, { db, executionHosts: hosts });
  } finally {
    remove();
  }
  expect(await recoverAgentContinuationSettlement(db, hosts, runId)).toBe(true);
  await startAgentSession(runId, { db, executionHosts: hosts });
  expect(
    await db
      .select()
      .from(agentPreparationOperations)
      .where(eq(agentPreparationOperations.assignmentId, resumed.successor.id)),
  ).toHaveLength(1);
  expect(
    await db
      .select({ status: runs.status, terminal: runs.operationalTerminal })
      .from(runs)
      .where(eq(runs.id, runId)),
  ).toMatchObject([
    {
      status: "Failed",
      terminal: {
        reasonCodes: expect.arrayContaining(["operational_integrity_refused"]),
      },
    },
  ]);
  expect(
    await db
      .select({ state: agentContinuationEpisodes.state })
      .from(agentContinuationEpisodes)
      .where(eq(agentContinuationEpisodes.runId, runId)),
  ).toEqual([{ state: "closed" }]);
  expect(
    await db
      .select({ kind: executionCommands.kind })
      .from(executionCommands)
      .where(eq(executionCommands.executionAssignmentId, resumed.successor.id)),
  ).toContainEqual({ kind: "session.create" });
  expect(
    await db
      .select({ kind: executionCommands.kind })
      .from(executionCommands)
      .where(eq(executionCommands.executionAssignmentId, resumed.successor.id)),
  ).not.toContainEqual({ kind: "session.prompt" });
}, 30_000);

it("reconciles a retired predecessor using its retained canonical checkpoint", async () => {
  const { runId, command, resumed } =
    await seedUndispatchedOperationalResume("repo_read");
  const { retireSupersededSessionIncarnations } =
    await import("@/lib/execution-host/session-binding");
  expect(
    await retireSupersededSessionIncarnations(db, {
      runSessionId: resumed.turn.runSessionId!,
      assignmentEpoch: resumed.successor.epoch,
      hostSessionId: randomUUID(),
    }),
  ).toBe(1);
  expect(await reconcileHistoricalAgentLifecycle(db, runId)).toBe(1);
  expect(
    await db
      .select({
        state: runSessionIncarnations.state,
        reason: runSessionIncarnations.terminalReason,
      })
      .from(runSessionIncarnations)
      .where(
        eq(
          runSessionIncarnations.executionAssignmentId,
          command.executionAssignmentId,
        ),
      ),
  ).toMatchObject([{ state: "exited", reason: { reason: "checkpoint" } }]);
  const { assertHistoricalAgentAssignmentsQuiescent } =
    await import("@/lib/agents/execution-quiescence");
  await expect(
    assertHistoricalAgentAssignmentsQuiescent(
      db,
      { id: runId, executionAssignmentId: resumed.successor.id },
      hosts,
    ),
  ).resolves.toBeUndefined();
});

it("a stale settlement cannot issue teardown to a successor assignment", async () => {
  const { runId, resumed, command } =
    await seedUndispatchedOperationalResume("repo_read");
  const [run] = await db.select().from(runs).where(eq(runs.id, runId));
  const cwd = run.operationalIntegrityBaseline?.owner?.cwd;
  if (!cwd) throw new Error("no checkout");
  await writeFile(join(cwd, "changed"), "changed");
  await startAgentSession(runId, { db, executionHosts: hosts });
  let newSession: string | undefined;
  const racingHosts: ExecutionHosts = {
    ...hosts,
    async forAssignment(assignment) {
      const client = await hosts.forAssignment(assignment);
      if (assignment.id !== command.executionAssignmentId) return client;
      return {
        ...client,
        async sessionsForRun() {
          const oldInventory = await client.sessionsForRun();
          if (newSession) return oldInventory;
          const successor = await db.transaction(async (tx) => {
            await tx
              .update(agentTurns)
              .set({ state: "superseded", completedAt: new Date() })
              .where(eq(agentTurns.id, resumed.turn.id));
            const next = await mintAssignment(tx, {
              runId,
              hostId: client.host.id,
              reason: "resume",
            });
            const [turn] = await tx
              .insert(agentTurns)
              .values({
                runId,
                ordinal: resumed.turn.ordinal + 1,
                variant: "resume",
                logicalKey: "review-newer-resume",
                prompt: resumed.turn.prompt,
                state: "claimed",
                executionAssignmentId: next.id,
                assignmentEpoch: next.epoch,
                runSessionId: resumed.turn.runSessionId,
              })
              .returning();
            return { next, turn };
          });
          const current = await hosts.forAssignment(successor.next);
          await current.ensureWorkspace();
          const previous = fake.sessions.get(command.targetSessionId!)!;
          if (!previous) throw new Error("no prior host identity");
          newSession = randomUUID();
          fake.sessions.set(newSession, {
            ...previous,
            sessionId: newSession,
            assignmentId: successor.next.id,
            assignmentEpoch: successor.next.epoch,
            status: "live",
          });
          return oldInventory;
        },
      };
    },
  };
  await expect(
    recoverAgentContinuationSettlement(db, racingHosts, runId),
  ).rejects.toMatchObject({ details: { reason: "assignment_fenced" } });
  expect(newSession).toBeTruthy();
  expect(
    fake.callsOf("deleteSession").map(({ args }) => args[0]),
  ).not.toContain(newSession);
  expect(fake.sessions.get(newSession!)?.status).toBe("live");
}, 30_000);

it("an authorized recheck retries only settlement after host inventory recovers", async () => {
  const { runId, resumed } =
    await seedUndispatchedOperationalResume("repo_read");
  const [run] = await db.select().from(runs).where(eq(runs.id, runId));
  const cwd = run.operationalIntegrityBaseline?.owner?.cwd;
  if (!cwd) throw new Error("expected checkout");
  await writeFile(join(cwd, "changed"), "changed");
  await startAgentSession(runId, { db, executionHosts: hosts });
  for (let attempt = 1; attempt <= 5; attempt++) {
    fake.failOnce(
      "listSessionsForRun",
      new MaisterError("EXECUTOR_UNAVAILABLE", "process proof unavailable", {
        details: { reason: "session_process_owner_unconfirmed" },
      }),
    );
    await expect(
      recoverAgentContinuationSettlement(db, hosts, runId),
    ).rejects.toMatchObject({
      details: { reason: "session_process_owner_unconfirmed" },
    });
    if (attempt < 5) {
      await db
        .update(agentContinuationEpisodes)
        .set({ dueAt: sql`clock_timestamp() - interval '1 millisecond'` })
        .where(eq(agentContinuationEpisodes.runId, runId));
    }
  }
  const attention = (await loadOperationalOutcome(db, runId))
    ?.continuationAttention;
  expect(attention).toMatchObject({
    assignmentEpoch: resumed.successor.epoch,
    reason: "operational_integrity_refused",
    blockedReason: "session_process_owner_unconfirmed",
  });
  if (!attention) throw new Error("expected visible continuation attention");
  const recheck = (observation: string) =>
    recheckContinuationRoute(
      new NextRequest(
        `http://localhost/api/runs/${runId}/operational/continuation/retry`,
        {
          method: "POST",
          body: JSON.stringify({ observation }),
        },
      ),
      { params: Promise.resolve({ runId }) },
    );
  vi.mocked(requireProjectActionForUser).mockRejectedValueOnce(
    new MaisterError("UNAUTHORIZED", "Recovery requires project access"),
  );
  expect((await recheck(attention.observation)).status).toBe(403);
  expect((await recheck(attention.observation)).status).toBe(202);
  fake.failOnce(
    "listSessionsForRun",
    new MaisterError("EXECUTOR_UNAVAILABLE", "process proof unavailable", {
      details: { reason: "session_process_owner_unconfirmed" },
    }),
  );
  await expect(
    recoverAgentContinuationSettlement(db, hosts, runId),
  ).rejects.toMatchObject({
    details: { reason: "session_process_owner_unconfirmed" },
  });
  const repeated = (await loadOperationalOutcome(db, runId))
    ?.continuationAttention;
  if (!repeated) throw new Error("expected attention after one failed recheck");
  const stale = await recheck(attention.observation);
  expect(stale.status).toBe(409);
  await expect(stale.json()).resolves.toMatchObject({
    code: "CONFLICT",
    details: { reason: "agent_continuation_attention_stale" },
  });
  expect((await recheck(repeated.observation)).status).toBe(202);
  expect(await recoverAgentContinuationSettlement(db, hosts, runId)).toBe(true);
  expect(
    await db
      .select({ status: runs.status })
      .from(runs)
      .where(eq(runs.id, runId)),
  ).toEqual([{ status: "Failed" }]);
  expect(
    (await loadOperationalOutcome(db, runId))?.continuationAttention,
  ).toBeUndefined();
  expect(
    await db
      .select()
      .from(agentPreparationOperations)
      .where(eq(agentPreparationOperations.assignmentId, resumed.successor.id)),
  ).toHaveLength(1);
  expect(
    await db
      .select()
      .from(agentIncidentOccurrences)
      .where(eq(agentIncidentOccurrences.runId, runId)),
  ).toHaveLength(1);
}, 30_000);
