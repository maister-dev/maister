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

type PackageTurn = Readonly<{
  localPackageId: string;
  postprocessActionId: string;
  lockGeneration: string;
}>;

export type ScratchPromptOwner =
  | Readonly<{ variant: "initial" }>
  | Readonly<{ variant: "recovery" }>
  | Readonly<{ variant: "message"; messageId: string; sequence: number }>
  | (Readonly<{ variant: "package_initial" }> & PackageTurn)
  | (Readonly<{
      variant: "package_message";
      messageId: string;
      sequence: number;
    }> &
      PackageTurn);

type ScratchOwnerRef = Extract<PromptOwner, { kind: "scratch_message" }>["ref"];

const launchVariants = ["initial", "package_initial"];
const recoveryVariants = ["recovery", "package_recovery"];

/** A launch turn belongs to its placement generation; a user message belongs to
 * the durable transcript row that was accepted before dispatch. */
function scratchTurnIdentity(
  owner: ScratchPromptOwner,
  assignmentId: string,
): Readonly<{ turnId: string; promptOrdinal: number }> {
  return "messageId" in owner
    ? { turnId: owner.messageId, promptOrdinal: owner.sequence }
    : { turnId: assignmentId, promptOrdinal: 0 };
}

function packageFields(owner: ScratchPromptOwner): PackageTurn | null {
  return "localPackageId" in owner
    ? {
        localPackageId: owner.localPackageId,
        postprocessActionId: owner.postprocessActionId,
        lockGeneration: owner.lockGeneration,
      }
    : null;
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

  const pkg = packageFields(owner);

  if (
    run?.runKind !== "scratch" ||
    run.status !== "Running" ||
    !scratch ||
    !["Starting", "Running"].includes(scratch.dialogStatus) ||
    (pkg !== null && scratch.localPackageId !== pkg.localPackageId) ||
    (launchVariants.includes(owner.variant) &&
      !["launch", "legacy_backfill"].includes(assignment.placementReason)) ||
    (recoveryVariants.includes(owner.variant) &&
      !["scratch_recover", "recover", "resume"].includes(
        assignment.placementReason,
      ))
  )
    throw new PromptOwnerInvariantError("scratch_admission_generation");
  if ("messageId" in owner) {
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

  const common = {
    version: 1 as const,
    ...identity,
    runId,
    scratchRunId: runId,
    runSessionId: binding.session.id,
    incarnationId: binding.incarnation.id,
    assignmentId: assignment.id,
    assignmentEpoch: assignment.epoch,
  };
  // The owner reference is a CLOSED shape (its keys drive the database check),
  // so each variant is built explicitly — never spread from the caller input.
  const ref: ScratchOwnerRef =
    owner.variant === "package_message"
      ? {
          ...common,
          ...(pkg as PackageTurn),
          variant: "package_message",
          messageId: owner.messageId,
        }
      : owner.variant === "package_initial"
        ? { ...common, ...(pkg as PackageTurn), variant: "package_initial" }
        : owner.variant === "message"
          ? { ...common, variant: "message", messageId: owner.messageId }
          : { ...common, variant: owner.variant };

  return {
    owner: { kind: "scratch_message", ref },
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
    definePromptOwnerAdapter("scratch_message", async (context) =>
      prepareScratchPrompt({ ...context, ref: context.owner.ref }),
    ),
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
      .select({
        state: executionCommands.state,
        applicationState: executionCommands.applicationState,
      })
      .from(executionCommands)
      .where(eq(executionCommands.id, commandId));

    // A settled owner means the DOMAIN transition is durable; it does not turn
    // a failed turn into a successful one. Only a successful command may be
    // swallowed here — a definitive failure still owes the caller its rejection.
    if (
      command?.state === "succeeded" &&
      (command.applicationState === "applied" ||
        command.applicationState === "superseded")
    )
      return;
    if (command?.state === "failed" || command?.state === "fenced") throw cause;
    throw new ScratchPromptContinuationPending(commandId, cause);
  }
}
