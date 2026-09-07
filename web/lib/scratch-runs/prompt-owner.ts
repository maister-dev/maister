import "server-only";

import type { BoundClient } from "@/lib/execution-host/client";
import type { Db } from "@/lib/execution-host/db";
import type { ExecutionCommand } from "@/lib/db/schema";
import type { PromptOwnerAdmission } from "@/lib/execution-host/ledger";
import type { PromptOwner } from "@/lib/execution-host/prompt-owner-contract";
import type {
  PreparedPromptOwner,
  PromptOwnerOutcome,
  PromptOwnerRegistry,
} from "@/lib/execution-host/prompt-owners";

import { and, eq } from "drizzle-orm";
import pino from "pino";

import {
  applyScratchPromptCompletion,
  lockScratchRunRows,
} from "./turn-completion";

import {
  executionCommands,
  runMessages,
  runSessionIncarnations,
  runSessions,
  runs,
  scratchRuns,
} from "@/lib/db/schema";
import {
  createPromptOwnerRegistry,
  definePromptOwnerAdapter,
  PromptOwnerInvariantError,
} from "@/lib/execution-host/prompt-owners";
import {
  lockCurrentSessionAssignment,
  staleSessionBinding,
} from "@/lib/execution-host/session-binding";
import { MaisterError } from "@/lib/errors";

const log = pino({
  name: "scratch-prompt-owner",
  level: process.env.LOG_LEVEL ?? "info",
});

export type ScratchPromptOwner =
  | Readonly<{ variant: "initial" }>
  | Readonly<{ variant: "message"; messageId: string; sequence: number }>;

type ScratchOwnerRef = Extract<
  Extract<PromptOwner, { kind: "scratch_message" }>["ref"],
  { variant: "initial" | "message" }
>;

/** A launch turn belongs to its placement generation; a user message belongs to
 * the durable transcript row that was accepted before dispatch. */
function scratchTurnIdentity(
  owner: ScratchPromptOwner,
  assignmentId: string,
): Readonly<{ turnId: string; promptOrdinal: number }> {
  return owner.variant === "initial"
    ? { turnId: assignmentId, promptOrdinal: 0 }
    : { turnId: owner.messageId, promptOrdinal: owner.sequence };
}

export function scratchPromptOperationKey(
  owner: ScratchPromptOwner,
  assignmentId: string,
): string {
  const { turnId, promptOrdinal } = scratchTurnIdentity(owner, assignmentId);

  return `scratch_message:${owner.variant}:${turnId}:${promptOrdinal}`;
}

export async function admitScratchPrompt(
  tx: Db,
  client: BoundClient,
  hostSessionId: string,
  owner: ScratchPromptOwner,
): Promise<PromptOwnerAdmission> {
  const runId = client.assignment.runId;
  const assignment = await lockCurrentSessionAssignment(tx, {
    runId,
    assignmentId: client.assignment.id,
  });

  if (!assignment) throw staleSessionBinding(runId, client.assignment.id);
  await lockScratchRunRows(tx, runId);
  const [run] = await tx.select().from(runs).where(eq(runs.id, runId));
  const [scratch] = await tx
    .select()
    .from(scratchRuns)
    .where(eq(scratchRuns.runId, runId));

  if (
    run?.runKind !== "scratch" ||
    run.status !== "Running" ||
    !scratch ||
    !["Starting", "Running"].includes(scratch.dialogStatus)
  )
    throw new PromptOwnerInvariantError("scratch_admission_generation");
  if (owner.variant === "message") {
    const [message] = await tx
      .select({ id: runMessages.id, sequence: runMessages.sequence })
      .from(runMessages)
      .where(eq(runMessages.id, owner.messageId));

    if (!message || message.sequence !== owner.sequence)
      throw new PromptOwnerInvariantError("scratch_admission_message");
  }
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
        eq(runSessionIncarnations.executionHostId, client.host.id),
        eq(runSessionIncarnations.state, "active"),
      ),
    )
    .for("update")
    .limit(1);

  if (!binding)
    throw new PromptOwnerInvariantError("scratch_admission_incarnation");
  const identity = scratchTurnIdentity(owner, assignment.id);

  return {
    owner: {
      kind: "scratch_message",
      ref: {
        version: 1,
        ...identity,
        ...(owner.variant === "initial"
          ? { variant: "initial" as const }
          : { variant: "message" as const, messageId: owner.messageId }),
        runId,
        scratchRunId: runId,
        runSessionId: binding.session.id,
        incarnationId: binding.incarnation.id,
        assignmentId: assignment.id,
        assignmentEpoch: assignment.epoch,
      },
    },
    logicalOperationKey: scratchPromptOperationKey(owner, assignment.id),
  };
}

/** The dialog's next turn is unlocked by this turn's own application, not by a
 * live stack that may already be gone. */
export async function prepareScratchPrompt(input: {
  db: Db;
  ref: ScratchOwnerRef;
  command: Readonly<ExecutionCommand>;
  outcome: PromptOwnerOutcome;
}): Promise<PreparedPromptOwner> {
  const { ref, command, outcome } = input;

  if (outcome.state === "succeeded")
    // The transcript projection owns the reply text; this owner owns the
    // dialog transition, so the verified span is consumed without decoding.
    for await (const event of outcome.events) void event;

  return {
    apply: async (tx) => {
      const assignment = await lockCurrentSessionAssignment(tx, {
        runId: ref.runId,
        assignmentId: ref.assignmentId,
      });

      if (!assignment || assignment.epoch !== ref.assignmentEpoch)
        return "superseded";
      const [binding] = await tx
        .select({ id: runSessionIncarnations.id })
        .from(runSessions)
        .innerJoin(
          runSessionIncarnations,
          eq(runSessionIncarnations.runSessionId, runSessions.id),
        )
        .where(
          and(
            eq(runSessions.id, ref.runSessionId),
            eq(runSessions.runId, ref.runId),
            eq(runSessions.hostSessionId, command.targetSessionId ?? ""),
            eq(runSessionIncarnations.id, ref.incarnationId),
            eq(runSessionIncarnations.executionAssignmentId, assignment.id),
            eq(runSessionIncarnations.assignmentEpoch, assignment.epoch),
          ),
        )
        .for("update")
        .limit(1);

      if (!binding) return "superseded";
      const [run] = await tx
        .select({ runKind: runs.runKind, status: runs.status })
        .from(runs)
        .where(eq(runs.id, ref.runId));

      if (run?.runKind !== "scratch" || run.status !== "Running")
        return "superseded";
      const dialogStatus = await applyScratchPromptCompletion(tx, ref.runId);

      log.info(
        {
          runId: ref.runId,
          turnId: ref.turnId,
          promptOrdinal: ref.promptOrdinal,
          commandId: command.id,
          dialogStatus,
        },
        "scratch-prompt-result-applied",
      );

      return "applied";
    },
  };
}

export const scratchPromptOwners: PromptOwnerRegistry =
  createPromptOwnerRegistry([
    definePromptOwnerAdapter("scratch_message", async (context) => {
      const ref = context.owner.ref;

      if (ref.variant !== "initial" && ref.variant !== "message")
        throw new PromptOwnerInvariantError("scratch_variant_not_implemented");

      return prepareScratchPrompt({ ...context, ref });
    }),
  ]);

export class ScratchPromptContinuationPending extends MaisterError {
  constructor(commandId: string, cause: unknown) {
    super("PRECONDITION", "scratch prompt awaits durable owner application", {
      details: { reason: "scratch_prompt_continuation_pending", commandId },
      ...(cause instanceof Error ? { cause } : {}),
    });
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export async function waitForScratchPrompt(
  db: Db,
  client: BoundClient,
  commandId: string,
  signal?: AbortSignal,
): Promise<void> {
  try {
    await client.waitForPrompt(
      { commandId },
      { owners: scratchPromptOwners, signal },
    );
  } catch (cause) {
    const [command] = await db
      .select({ applicationState: executionCommands.applicationState })
      .from(executionCommands)
      .where(eq(executionCommands.id, commandId));

    if (
      command?.applicationState === "applied" ||
      command?.applicationState === "superseded"
    )
      return;
    throw new ScratchPromptContinuationPending(commandId, cause);
  }
}
