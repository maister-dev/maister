import "server-only";

import type {
  RunSessionIncarnation,
  ExecutionAssignment,
} from "@/lib/db/schema";
import type { Db } from "@/lib/execution-host/db";
import type { BoundClient } from "@/lib/execution-host/client";
import type { ExecutionHostTransport } from "@/lib/execution-host/contracts";
import type { PromptOwnerAdmission } from "@/lib/execution-host/ledger";
import type { PromptOwner } from "@/lib/execution-host/prompt-owner-contract";
import type { AgentFinalizationApplication } from "./finalization";
import type { AgentParkApplication } from "./park";

import { and, eq } from "drizzle-orm";
import pino from "pino";

import { prepareAgentRunFinalization } from "./finalization";
import { applyPersistentAgentPark, afterPersistentAgentPark } from "./park";
import { requireAgentPermissionCompletion } from "./permission";
import {
  assertAgentResumeTurn,
  lockAgentPermissionResult,
  acknowledgeAgentPermissionResult,
} from "./permission-resume";

import {
  executionCommands,
  runs,
  runSessions,
  runSessionIncarnations,
  agentTurns,
} from "@/lib/db/schema";
import {
  lockCurrentSessionAssignment,
  staleSessionBinding,
} from "@/lib/execution-host/session-binding";
import {
  createPromptOwnerRegistry,
  definePromptOwnerAdapter,
  PromptOwnerInvariantError,
  PromptOwnerDeferred,
} from "@/lib/execution-host/prompt-owners";
import {
  appendSentinelOutput,
  emptySentinelOutput,
  finishSentinelOutput,
} from "@/lib/flows/graph/node-output-stream";
import { agentMessageText } from "@/lib/run-transcript/agent-text";
import { createExecutionHosts } from "@/lib/execution-host/client";
import { nodeOutputMaxBytes } from "@/lib/instance-config";
import { MaisterError } from "@/lib/errors";
import { readPromptRequest } from "@/lib/execution-host/command-request";
import { waitForPromptCompletion } from "@/lib/execution-host/deliverer";

const log = pino({
  name: "agent-prompt-owner",
  level: process.env.LOG_LEVEL ?? "info",
});

type InitialAgentRef = Extract<
  Extract<PromptOwner, { kind: "agent_turn" }>["ref"],
  { variant: "initial" }
>;
type AdmittedAgentRef = Extract<
  Extract<PromptOwner, { kind: "agent_turn" }>["ref"],
  {
    variant:
      | "initial"
      | "resume"
      | "rework"
      | "live_message"
      | "persistent_message";
  }
>;
type AgentPromptSession = Pick<
  InitialAgentRef,
  | "version"
  | "runId"
  | "assignmentId"
  | "assignmentEpoch"
  | "runSessionId"
  | "incarnationId"
> &
  Readonly<{ placementReason: ExecutionAssignment["placementReason"] }>;

export function initialAgentPromptKey(assignmentId: string): string {
  return `agent_turn:initial:${assignmentId}:0`;
}

async function lockAgentPromptSession(
  tx: Db,
  client: BoundClient,
  hostSessionId: string,
): Promise<AgentPromptSession> {
  const runId = client.assignment.runId;
  const assignment = await lockCurrentSessionAssignment(tx, {
    runId,
    assignmentId: client.assignment.id,
  });

  if (!assignment) throw staleSessionBinding(runId, client.assignment.id);
  const [run] = await tx.select().from(runs).where(eq(runs.id, runId));

  if (run?.runKind !== "agent" || run.status !== "Running")
    throw new PromptOwnerInvariantError("agent_initial_admission_generation");
  const [binding] = await tx
    .select({ session: runSessions, incarnation: runSessionIncarnations })
    .from(runSessions)
    .innerJoin(
      runSessionIncarnations,
      eq(runSessionIncarnations.runSessionId, runSessions.id),
    )
    .where(
      and(
        eq(runSessions.runId, runId),
        eq(runSessions.executionAssignmentId, assignment.id),
        eq(runSessions.hostSessionId, hostSessionId),
        eq(runSessionIncarnations.hostSessionId, hostSessionId),
        eq(runSessionIncarnations.executionAssignmentId, assignment.id),
        eq(runSessionIncarnations.assignmentEpoch, assignment.epoch),
        eq(runSessionIncarnations.executionHostId, assignment.executionHostId),
        eq(runSessionIncarnations.state, "active"),
      ),
    )
    .for("update")
    .limit(1);

  if (!binding)
    throw new PromptOwnerInvariantError("agent_initial_admission_session");

  return {
    version: 1,
    runId,
    assignmentId: assignment.id,
    assignmentEpoch: assignment.epoch,
    runSessionId: binding.session.id,
    incarnationId: binding.incarnation.id,
    placementReason: assignment.placementReason,
  };
}

/** One first prompt belongs to the already persisted launch generation. */
export async function admitInitialAgentPrompt(
  tx: Db,
  client: BoundClient,
  hostSessionId: string,
): Promise<PromptOwnerAdmission> {
  const { placementReason, ...session } = await lockAgentPromptSession(
    tx,
    client,
    hostSessionId,
  );

  if (!["launch", "legacy_backfill"].includes(placementReason))
    throw new PromptOwnerInvariantError("agent_initial_admission_generation");

  return {
    owner: {
      kind: "agent_turn",
      ref: {
        ...session,
        variant: "initial",
        turnId: session.assignmentId,
        promptOrdinal: 0,
      },
    },
    logicalOperationKey: initialAgentPromptKey(session.assignmentId),
  };
}

export async function admitAgentMessagePrompt(
  tx: Db,
  client: BoundClient,
  hostSessionId: string,
  turnId: string,
): Promise<PromptOwnerAdmission> {
  const [turn] = await tx
    .select()
    .from(agentTurns)
    .where(eq(agentTurns.id, turnId));

  if (!turn || !["live_message", "persistent_message"].includes(turn.variant))
    throw new PromptOwnerInvariantError("agent_message_variant");

  return admitAgentTurnPrompt(tx, client, hostSessionId, turnId);
}

export async function admitAgentTurnPrompt(
  tx: Db,
  client: BoundClient,
  hostSessionId: string,
  turnId: string,
): Promise<PromptOwnerAdmission> {
  const { placementReason, ...session } = await lockAgentPromptSession(
    tx,
    client,
    hostSessionId,
  );

  void placementReason;
  const [turn] = await tx
    .select()
    .from(agentTurns)
    .where(eq(agentTurns.id, turnId))
    .for("update");

  if (
    !turn ||
    !["claimed", "dispatched"].includes(turn.state) ||
    turn.runId !== session.runId ||
    turn.executionAssignmentId !== session.assignmentId ||
    turn.assignmentEpoch !== session.assignmentEpoch ||
    turn.runSessionId !== session.runSessionId
  )
    throw new PromptOwnerInvariantError("agent_message_admission_generation");
  await assertAgentResumeTurn(tx, turn, client.assignment);
  if (
    turn.variant === "initial" &&
    (turn.id !== session.assignmentId || turn.ordinal !== 0)
  )
    throw new PromptOwnerInvariantError("agent_initial_turn_identity");
  const logicalOperationKey =
    turn.variant === "initial"
      ? initialAgentPromptKey(session.assignmentId)
      : `agent_turn:${turn.variant}:${turn.id}:${turn.ordinal}`;
  const source = { ...session, turnId: turn.id, promptOrdinal: turn.ordinal };
  const ref: AdmittedAgentRef =
    turn.variant === "live_message" || turn.variant === "persistent_message"
      ? { ...source, variant: turn.variant, messageId: turn.id }
      : { ...source, variant: turn.variant };

  return {
    owner: {
      kind: "agent_turn",
      ref,
    },
    logicalOperationKey,
    assertCommit: async () => {
      const [command] = await tx
        .select()
        .from(executionCommands)
        .where(
          and(
            eq(executionCommands.runId, turn.runId),
            eq(executionCommands.logicalOperationKey, logicalOperationKey),
          ),
        );

      if (
        !command ||
        readPromptRequest(command, client.host.hostKey).payload.prompt !==
          turn.prompt
      )
        throw new PromptOwnerInvariantError(
          "agent_message_original_prompt_changed",
        );
      if (turn.commandId !== null && turn.commandId !== command.id)
        throw new PromptOwnerInvariantError("agent_message_command_changed");
      await tx
        .update(agentTurns)
        .set({
          state: "dispatched",
          commandId: command.id,
          incarnationId: session.incarnationId,
          updatedAt: new Date(),
        })
        .where(eq(agentTurns.id, turn.id));
    },
  };
}

async function lockAgentBinding(
  tx: Db,
  ref: AdmittedAgentRef,
  targetSessionId: string | null,
  commandId: string,
): Promise<Readonly<{
  state: RunSessionIncarnation["state"];
  persistent: boolean;
}> | null> {
  if (
    ref.variant === "initial" &&
    (ref.turnId !== ref.assignmentId || ref.promptOrdinal !== 0)
  )
    throw new PromptOwnerInvariantError("agent_initial_turn_identity");
  const historical = await lockAgentPermissionResult(tx, ref.runId, commandId);

  if (historical) return historical;
  const [sourceCommand] = await tx
    .select()
    .from(executionCommands)
    .where(eq(executionCommands.id, commandId));

  if (sourceCommand) await requireAgentPermissionCompletion(tx, sourceCommand);
  const assignment = await lockCurrentSessionAssignment(tx, {
    runId: ref.runId,
    assignmentId: ref.assignmentId,
  });

  if (!assignment || assignment.epoch !== ref.assignmentEpoch) return null;
  if (
    ref.variant === "initial" &&
    !["launch", "legacy_backfill"].includes(assignment.placementReason)
  )
    return null;
  {
    const [turn] = await tx
      .select()
      .from(agentTurns)
      .where(eq(agentTurns.id, ref.turnId))
      .for("update");

    if (
      ("messageId" in ref && ref.messageId !== ref.turnId) ||
      (!turn && ref.variant !== "initial") ||
      (turn &&
        (turn.state !== "dispatched" ||
          turn.commandId !== commandId ||
          turn.runId !== ref.runId ||
          turn.variant !== ref.variant ||
          turn.ordinal !== ref.promptOrdinal ||
          turn.executionAssignmentId !== ref.assignmentId ||
          turn.assignmentEpoch !== ref.assignmentEpoch ||
          turn.runSessionId !== ref.runSessionId ||
          turn.incarnationId !== ref.incarnationId))
    )
      return null;
    if (turn) await assertAgentResumeTurn(tx, turn, assignment);
  }
  const [run] = await tx.select().from(runs).where(eq(runs.id, ref.runId));

  if (
    run?.runKind !== "agent" ||
    !["Running", "NeedsInput"].includes(run.status)
  )
    return null;
  const [binding] = await tx
    .select({
      id: runSessionIncarnations.id,
      state: runSessionIncarnations.state,
    })
    .from(runSessions)
    .innerJoin(
      runSessionIncarnations,
      eq(runSessionIncarnations.runSessionId, runSessions.id),
    )
    .where(
      and(
        eq(runSessions.id, ref.runSessionId),
        eq(runSessions.runId, ref.runId),
        eq(runSessions.executionAssignmentId, assignment.id),
        eq(runSessions.hostSessionId, targetSessionId ?? ""),
        eq(runSessionIncarnations.id, ref.incarnationId),
        eq(runSessionIncarnations.executionAssignmentId, assignment.id),
        eq(runSessionIncarnations.assignmentEpoch, assignment.epoch),
        eq(runSessionIncarnations.executionHostId, assignment.executionHostId),
        eq(runSessionIncarnations.hostSessionId, targetSessionId ?? ""),
      ),
    )
    .for("update")
    .limit(1);

  return binding ? { state: binding.state, persistent: run.persistent } : null;
}

async function lockAgentOwner(
  tx: Db,
  ref: AdmittedAgentRef,
  targetSessionId: string | null,
  commandId: string,
  persistent: boolean,
): Promise<boolean> {
  const binding = await lockAgentBinding(tx, ref, targetSessionId, commandId);

  if (!binding || binding.persistent !== persistent) return false;
  if (binding.state === "active" || binding.state === "created")
    throw new PromptOwnerDeferred("agent_session_teardown_pending");

  return binding.state === "exited" || binding.state === "crashed";
}

/** Close only the completed turn's current process before workspace inspection.
 * The exact target and assignment fence also protect a concurrent replacement.
 */
async function stopAgentPromptSession(
  db: Db,
  ref: AdmittedAgentRef,
  targetSessionId: string | null,
  commandId: string,
): Promise<void> {
  const binding = await db.transaction((tx) =>
    lockAgentBinding(tx, ref, targetSessionId, commandId),
  );

  if (binding?.state !== "active" && binding?.state !== "created") return;
  if (!targetSessionId)
    throw new PromptOwnerInvariantError("agent_cleanup_session_missing");
  const client = await createExecutionHosts({ db }).forAssignment({
    id: ref.assignmentId,
  });

  await client.deleteSession(targetSessionId);
  log.debug(
    {
      runId: ref.runId,
      assignmentId: ref.assignmentId,
      incarnationId: ref.incarnationId,
    },
    "agent-prompt-session-closed",
  );
}

async function acknowledgeAgentMessage(
  tx: Db,
  ref: AdmittedAgentRef,
  commandId: string,
): Promise<void> {
  const [applied] = await tx
    .update(agentTurns)
    .set({ state: "applied", completedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(agentTurns.id, ref.turnId),
        eq(agentTurns.runId, ref.runId),
        eq(agentTurns.commandId, commandId),
        eq(agentTurns.state, "dispatched"),
      ),
    )
    .returning({ id: agentTurns.id });

  if (!applied && ref.variant !== "initial")
    throw new PromptOwnerInvariantError("agent_message_acknowledgment_changed");
  await acknowledgeAgentPermissionResult(tx, ref.runId, commandId);
}

async function supersedeAgentMessage(
  tx: Db,
  ref: AdmittedAgentRef,
  commandId: string,
): Promise<"superseded"> {
  await tx
    .update(agentTurns)
    .set({
      state: "superseded",
      completedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(agentTurns.id, ref.turnId),
        eq(agentTurns.runId, ref.runId),
        eq(agentTurns.commandId, commandId),
        eq(agentTurns.state, "dispatched"),
      ),
    );

  return "superseded";
}

export const agentPromptOwner = definePromptOwnerAdapter(
  "agent_turn",
  async ({ db, owner, command, outcome }) => {
    const ref = owner.ref;

    if (
      ref.variant !== "initial" &&
      ref.variant !== "resume" &&
      ref.variant !== "rework" &&
      ref.variant !== "live_message" &&
      ref.variant !== "persistent_message"
    )
      throw new PromptOwnerInvariantError("agent_variant_not_implemented");
    const maxBytes = nodeOutputMaxBytes();
    let sentinel = emptySentinelOutput();

    if (outcome.state === "succeeded") {
      for await (const event of outcome.events) {
        if (event.eventType !== "session.update") continue;
        const text = agentMessageText(event.payload?.update);

        if (text !== null)
          sentinel = appendSentinelOutput(sentinel, text, maxBytes);
      }
    }
    const succeeded =
      outcome.state === "succeeded" &&
      outcome.response.stopReason === "end_turn";

    await requireAgentPermissionCompletion(db, command);
    if (outcome.state !== "fenced")
      await stopAgentPromptSession(
        db,
        ref,
        command.targetSessionId,
        command.id,
      );
    const [run] = await db
      .select({ persistent: runs.persistent })
      .from(runs)
      .where(eq(runs.id, ref.runId));
    const persistent = run?.persistent ?? false;

    if (persistent && succeeded) {
      let application: AgentParkApplication = { parked: false };

      return {
        apply: async (tx) => {
          if (
            !(await lockAgentOwner(
              tx,
              ref,
              command.targetSessionId,
              command.id,
              persistent,
            ))
          )
            return supersedeAgentMessage(tx, ref, command.id);
          application = await applyPersistentAgentPark(tx, ref.runId);
          if (!application.parked)
            throw new PromptOwnerDeferred("agent_park_pending");
          await acknowledgeAgentMessage(tx, ref, command.id);

          return "applied";
        },
        afterCommit: () => afterPersistentAgentPark(db, ref.runId, application),
      };
    }
    const prepared = await prepareAgentRunFinalization(
      ref.runId,
      succeeded ? "Done" : "Failed",
      {
        db,
        finalOutput: finishSentinelOutput(sentinel, maxBytes),
        ...(!succeeded ? { reason: "agent_prompt_failed" } : {}),
      },
    );
    let application: AgentFinalizationApplication = { finalized: false };

    return {
      apply: async (tx) => {
        if (
          outcome.state === "fenced" ||
          !(await lockAgentOwner(
            tx,
            ref,
            command.targetSessionId,
            command.id,
            persistent,
          ))
        )
          return supersedeAgentMessage(tx, ref, command.id);
        application = await prepared.apply(tx);
        if (!application.finalized)
          throw new PromptOwnerDeferred("agent_finalization_pending");
        await acknowledgeAgentMessage(tx, ref, command.id);
        log.info(
          {
            runId: ref.runId,
            turnId: ref.turnId,
            commandId: command.id,
            assignmentId: ref.assignmentId,
            status: application.status,
          },
          "agent-prompt-result-applied",
        );

        return "applied";
      },
      afterCommit: () => prepared.afterCommit(application),
    };
  },
);

export const agentPromptOwners = createPromptOwnerRegistry([agentPromptOwner]);

export class AgentPromptContinuationPending extends MaisterError {
  constructor(commandId: string, cause: unknown) {
    super("PRECONDITION", "agent prompt awaits durable owner application", {
      details: { reason: "agent_prompt_continuation_pending", commandId },
      ...(cause instanceof Error ? { cause } : {}),
    });
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export async function waitForAgentPrompt(
  db: Db,
  client: BoundClient,
  commandId: string,
  signal?: AbortSignal,
): Promise<void> {
  await awaitAgentApplication(db, commandId, () =>
    client.waitForPrompt({ commandId }, { owners: agentPromptOwners, signal }),
  );
}

/** Historical evidence retains its original assignment, including its objects. */
export async function waitForHistoricalAgentPrompt(
  db: Db,
  transport: ExecutionHostTransport,
  commandId: string,
  signal?: AbortSignal,
): Promise<void> {
  await awaitAgentApplication(db, commandId, () =>
    waitForPromptCompletion({
      db,
      handle: { commandId },
      owners: agentPromptOwners,
      lookupReceipt: (id) => transport.getCommandReceipt(id),
      signal,
    }),
  );
}

async function awaitAgentApplication(
  db: Db,
  commandId: string,
  wait: () => Promise<unknown>,
): Promise<void> {
  try {
    await wait();
  } catch (cause) {
    try {
      const [command] = await db
        .select({ applicationState: executionCommands.applicationState })
        .from(executionCommands)
        .where(eq(executionCommands.id, commandId));

      if (
        command?.applicationState === "applied" ||
        command?.applicationState === "superseded"
      )
        return;
    } catch (readCause) {
      throw new AgentPromptContinuationPending(commandId, readCause);
    }
    throw new AgentPromptContinuationPending(commandId, cause);
  }
}

export async function findInitialAgentPrompt(
  db: Db,
  runId: string,
  assignmentId: string,
): Promise<string | null> {
  const [command] = await db
    .select({ id: executionCommands.id })
    .from(executionCommands)
    .where(
      and(
        eq(executionCommands.runId, runId),
        eq(executionCommands.kind, "session.prompt"),
        eq(executionCommands.ownerKind, "agent_turn"),
        eq(
          executionCommands.logicalOperationKey,
          initialAgentPromptKey(assignmentId),
        ),
      ),
    )
    .limit(1);

  return command?.id ?? null;
}

/** Raw process death cannot override an admitted command's original outcome. */
export async function agentSessionHasOwnedPrompt(
  db: Db,
  runId: string,
  sessionId: string,
): Promise<boolean> {
  const [command] = await db
    .select({ id: executionCommands.id })
    .from(executionCommands)
    .where(
      and(
        eq(executionCommands.runId, runId),
        eq(executionCommands.kind, "session.prompt"),
        eq(executionCommands.ownerKind, "agent_turn"),
        eq(executionCommands.targetSessionId, sessionId),
      ),
    )
    .limit(1);

  return command !== undefined;
}
