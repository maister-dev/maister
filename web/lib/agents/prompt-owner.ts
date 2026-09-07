import "server-only";

import type { RunSessionIncarnation } from "@/lib/db/schema";
import type { Db } from "@/lib/execution-host/db";
import type { BoundClient } from "@/lib/execution-host/client";
import type { PromptOwnerAdmission } from "@/lib/execution-host/ledger";
import type { PromptOwner } from "@/lib/execution-host/prompt-owner-contract";
import type { AgentFinalizationApplication } from "./finalization";

import { and, eq } from "drizzle-orm";
import pino from "pino";

import { prepareAgentRunFinalization } from "./finalization";

import {
  executionCommands,
  runs,
  runSessions,
  runSessionIncarnations,
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

const log = pino({
  name: "agent-prompt-owner",
  level: process.env.LOG_LEVEL ?? "info",
});

type InitialAgentRef = Extract<
  Extract<PromptOwner, { kind: "agent_turn" }>["ref"],
  { variant: "initial" }
>;

export function initialAgentPromptKey(assignmentId: string): string {
  return `agent_turn:initial:${assignmentId}:0`;
}

/** One first prompt belongs to the already persisted launch generation. */
export async function admitInitialAgentPrompt(
  tx: Db,
  client: BoundClient,
  hostSessionId: string,
): Promise<PromptOwnerAdmission> {
  const runId = client.assignment.runId;
  const assignment = await lockCurrentSessionAssignment(tx, {
    runId,
    assignmentId: client.assignment.id,
  });

  if (!assignment) throw staleSessionBinding(runId, client.assignment.id);
  const [run] = await tx.select().from(runs).where(eq(runs.id, runId));

  if (
    run?.runKind !== "agent" ||
    run.persistent ||
    run.status !== "Running" ||
    !["launch", "legacy_backfill"].includes(assignment.placementReason)
  )
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
    owner: {
      kind: "agent_turn",
      ref: {
        version: 1,
        variant: "initial",
        turnId: assignment.id,
        promptOrdinal: 0,
        runId,
        assignmentId: assignment.id,
        assignmentEpoch: assignment.epoch,
        runSessionId: binding.session.id,
        incarnationId: binding.incarnation.id,
      },
    },
    logicalOperationKey: initialAgentPromptKey(assignment.id),
  };
}

async function lockInitialAgentBinding(
  tx: Db,
  ref: InitialAgentRef,
  targetSessionId: string | null,
): Promise<RunSessionIncarnation["state"] | null> {
  if (ref.turnId !== ref.assignmentId || ref.promptOrdinal !== 0)
    throw new PromptOwnerInvariantError("agent_initial_turn_identity");
  const assignment = await lockCurrentSessionAssignment(tx, {
    runId: ref.runId,
    assignmentId: ref.assignmentId,
  });

  if (!assignment || assignment.epoch !== ref.assignmentEpoch) return null;
  if (!["launch", "legacy_backfill"].includes(assignment.placementReason))
    return null;
  const [run] = await tx.select().from(runs).where(eq(runs.id, ref.runId));

  if (
    run?.runKind !== "agent" ||
    run.persistent ||
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

  return binding?.state ?? null;
}

async function lockInitialAgentOwner(
  tx: Db,
  ref: InitialAgentRef,
  targetSessionId: string | null,
): Promise<boolean> {
  const state = await lockInitialAgentBinding(tx, ref, targetSessionId);

  if (state === "active" || state === "created")
    throw new PromptOwnerDeferred("agent_session_teardown_pending");

  return state === "exited" || state === "crashed";
}

/** Close only the completed turn's current process before workspace inspection.
 * The exact target and assignment fence also protect a concurrent replacement.
 */
async function stopInitialAgentPromptSession(
  db: Db,
  ref: InitialAgentRef,
  targetSessionId: string | null,
): Promise<void> {
  const state = await db.transaction((tx) =>
    lockInitialAgentBinding(tx, ref, targetSessionId),
  );

  if (state !== "active" && state !== "created") return;
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

export const agentPromptOwner = definePromptOwnerAdapter(
  "agent_turn",
  async ({ db, owner, command, outcome }) => {
    const ref = owner.ref;

    if (ref.variant !== "initial")
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

    if (outcome.state !== "fenced")
      await stopInitialAgentPromptSession(db, ref, command.targetSessionId);
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
          !(await lockInitialAgentOwner(tx, ref, command.targetSessionId))
        )
          return "superseded";
        application = await prepared.apply(tx);
        if (!application.finalized)
          throw new PromptOwnerDeferred("agent_finalization_pending");
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
): Promise<void> {
  try {
    await client.waitForPrompt({ commandId }, { owners: agentPromptOwners });
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
