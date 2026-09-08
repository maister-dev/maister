import "server-only";

import type { BoundClient } from "@/lib/execution-host/client";
import type { Db as LedgerDb } from "@/lib/execution-host/db";
import type { ExecutionCommand } from "@/lib/db/schema";
import type { PromptOwnerAdmission } from "@/lib/execution-host/ledger";
import type { PromptResult } from "@/lib/execution-host";
import type { PromptOwner } from "@/lib/execution-host/prompt-owner-contract";
import type {
  PreparedPromptOwner,
  PromptOwnerOutcome,
  PromptOwnerRegistry,
} from "@/lib/execution-host/prompt-owners";

import { and, eq } from "drizzle-orm";
import pino from "pino";

import * as schemaModule from "@/lib/db/schema";
import { executionCommands, runSessionIncarnations } from "@/lib/db/schema";
import { applyPromptOwner } from "@/lib/execution-host/prompt-owner-application";
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

// FIXME(any): dual drizzle-orm peer-dep variants.
const { runSyncAttempts, workspaces } = schemaModule as unknown as Record<
  string,
  any
>;

// FIXME(any): dual drizzle-orm peer-dep variants.
type Db = any;

const log = pino({
  name: "sync-prompt-owner",
  level: process.env.LOG_LEVEL ?? "info",
});

type SyncRef = Extract<PromptOwner, { kind: "sync_resolution" }>["ref"];

export type SyncPromptOwner = Readonly<{
  syncAttemptId: string;
  /** `workspaces.lifecycle_operation_attempt_id` — this claim of the shared
   * lifecycle slot, not the sync attempt. */
  operationAttemptId: string;
  promptOrdinal: number;
}>;

export function syncPromptOperationKey(
  syncAttemptId: string,
  promptOrdinal: number,
): string {
  return `sync_resolution:resolver:${syncAttemptId}:${promptOrdinal}`;
}

export async function admitSyncPrompt(
  tx: Db,
  client: BoundClient,
  hostSessionId: string,
  owner: SyncPromptOwner,
): Promise<PromptOwnerAdmission> {
  const runId = client.assignment.runId;
  const assignment = await lockCurrentSessionAssignment(tx as LedgerDb, {
    runId,
    assignmentId: client.assignment.id,
  });

  if (!assignment) throw staleSessionBinding(runId, client.assignment.id);
  const [attempt] = await tx
    .select({
      id: runSyncAttempts.id,
      runId: runSyncAttempts.runId,
      workspaceId: runSyncAttempts.workspaceId,
      mode: runSyncAttempts.mode,
      phase: runSyncAttempts.phase,
    })
    .from(runSyncAttempts)
    .where(eq(runSyncAttempts.id, owner.syncAttemptId))
    .for("update");

  if (
    !attempt ||
    attempt.runId !== runId ||
    attempt.mode !== "agent" ||
    attempt.phase !== "agent_running"
  )
    throw new PromptOwnerInvariantError("sync_admission_phase");
  const [workspace] = await tx
    .select({
      id: workspaces.id,
      lifecycleOperationName: workspaces.lifecycleOperationName,
      lifecycleOperationAttemptId: workspaces.lifecycleOperationAttemptId,
    })
    .from(workspaces)
    .where(eq(workspaces.id, attempt.workspaceId))
    .for("update");

  if (
    !workspace ||
    workspace.lifecycleOperationName !== "sync" ||
    workspace.lifecycleOperationAttemptId !== owner.operationAttemptId
  )
    throw new PromptOwnerInvariantError("sync_admission_claim");
  // The resolver spawns its session through the ordinary create path, not the
  // owned-create path, so `run_sessions` carries no assignment binding here.
  // The incarnation is the real fence: it is per host session and carries the
  // assignment and epoch this turn must belong to.
  const [binding] = await tx
    .select({ incarnation: runSessionIncarnations })
    .from(runSessionIncarnations)
    .where(
      and(
        eq(runSessionIncarnations.runId, runId),
        eq(runSessionIncarnations.hostSessionId, hostSessionId),
        eq(runSessionIncarnations.executionHostId, client.host.id),
        eq(runSessionIncarnations.state, "active"),
      ),
    )
    .for("update")
    .limit(1);

  if (!binding)
    throw new PromptOwnerInvariantError("sync_admission_incarnation");
  const ref: SyncRef = {
    version: 1,
    variant: "resolver",
    runId,
    runSessionId: binding.incarnation.runSessionId,
    incarnationId: binding.incarnation.id,
    assignmentId: assignment.id,
    assignmentEpoch: assignment.epoch,
    syncAttemptId: owner.syncAttemptId,
    operationAttemptId: owner.operationAttemptId,
    expectedPhase: "agent_running",
    promptOrdinal: owner.promptOrdinal,
  };

  return {
    owner: { kind: "sync_resolution", ref },
    logicalOperationKey: syncPromptOperationKey(
      owner.syncAttemptId,
      owner.promptOrdinal,
    ),
  };
}

/** The ACP boundary is what this owner makes durable: the attempt leaves
 * `agent_running` exactly once. The git verify/push continuation stays with the
 * existing sync state machine, which is already idempotent from `verifying`. */
export async function prepareSyncPrompt(input: {
  db: Db;
  ref: SyncRef;
  command: Readonly<ExecutionCommand>;
  outcome: PromptOwnerOutcome;
}): Promise<PreparedPromptOwner> {
  const { ref, command, outcome } = input;

  if (outcome.state === "succeeded")
    // The resolver's product is the worktree, not the transcript; the verified
    // span is consumed without decoding so a partial read cannot apply.
    for await (const event of outcome.events) void event;
  const resolved =
    outcome.state === "succeeded" && outcome.response.stopReason === "end_turn";

  // This owner makes only the ACP BOUNDARY durable. A fenced turn belongs to a
  // newer generation and is never settled here; a crashed or non-end_turn turn
  // is terminalized by the existing sync state machine with its own restore and
  // error fields, so this owner writes nothing but still ACCOUNTS for the
  // command — `superseded` would mean the result is inapplicable, which a live
  // waiter correctly refuses.
  if (outcome.state === "fenced")
    throw new PromptOwnerInvariantError("sync_apply_fenced");
  if (!resolved) return { apply: async () => "applied" as const };

  return {
    apply: async (tx) => {
      const [attempt] = await tx
        .select({
          id: runSyncAttempts.id,
          workspaceId: runSyncAttempts.workspaceId,
          phase: runSyncAttempts.phase,
        })
        .from(runSyncAttempts)
        .where(eq(runSyncAttempts.id, ref.syncAttemptId))
        .for("update");

      if (!attempt || attempt.phase !== ref.expectedPhase) return "superseded";
      const [workspace] = await tx
        .select({
          lifecycleOperationName: workspaces.lifecycleOperationName,
          lifecycleOperationAttemptId: workspaces.lifecycleOperationAttemptId,
        })
        .from(workspaces)
        .where(eq(workspaces.id, attempt.workspaceId))
        .for("update");

      if (
        !workspace ||
        workspace.lifecycleOperationName !== "sync" ||
        workspace.lifecycleOperationAttemptId !== ref.operationAttemptId
      )
        return "superseded";
      await tx
        .update(runSyncAttempts)
        .set({ phase: "verifying", updatedAt: new Date() })
        .where(
          and(
            eq(runSyncAttempts.id, ref.syncAttemptId),
            eq(runSyncAttempts.phase, ref.expectedPhase),
          ),
        );
      log.info(
        {
          runId: ref.runId,
          syncAttemptId: ref.syncAttemptId,
          commandId: command.id,
        },
        "sync-resolver-turn-applied",
      );

      return "applied";
    },
  };
}

/** Evidence first: an orphaned live session is not evidence the resolver's work
 * is worthless. If this attempt's own command already carries a durable
 * outcome, apply it — the attempt leaves `agent_running` and the existing
 * idempotent re-verify path finalizes — instead of discarding the resolution.
 * A command still in flight is not claimable and defers. */
export async function reconcileOwnedSyncTurn(
  db: Db,
  syncAttemptId: string,
  promptOrdinal: number,
  signal: AbortSignal,
): Promise<boolean> {
  const [command] = await db
    .select({ id: executionCommands.id })
    .from(executionCommands)
    .where(
      and(
        eq(executionCommands.ownerKind, "sync_resolution"),
        eq(
          executionCommands.logicalOperationKey,
          syncPromptOperationKey(syncAttemptId, promptOrdinal),
        ),
      ),
    );

  if (!command) return false;
  const outcome = await applyPromptOwner({
    db,
    owners: syncPromptOwners,
    commandId: command.id,
    signal,
  });

  log.info(
    { syncAttemptId, commandId: command.id, outcome },
    "sync-owner-reconciled",
  );

  return outcome === "applied";
}

export const syncPromptOwners: PromptOwnerRegistry = createPromptOwnerRegistry([
  definePromptOwnerAdapter("sync_resolution", async (context) =>
    prepareSyncPrompt({ ...context, ref: context.owner.ref }),
  ),
]);

/** Returns the live prompt result, or null when the owner already settled this
 * command durably and there is no live outcome to report. */
export async function waitForSyncPrompt(
  db: Db,
  client: BoundClient,
  handle: { commandId: string },
  signal?: AbortSignal,
): Promise<PromptResult | null> {
  const commandId = handle.commandId;

  try {
    return await client.waitForPrompt(handle, {
      owners: syncPromptOwners,
      signal,
    });
  } catch (cause) {
    const [row] = await db
      .select({
        state: executionCommands.state,
        applicationState: executionCommands.applicationState,
      })
      .from(executionCommands)
      .where(eq(executionCommands.id, commandId));

    // A settled owner means the DOMAIN transition is durable; it does not turn
    // a failed turn into a successful one. Only a successful command may be
    // swallowed here — a definitive failure still owes the caller its rejection.
    // A fenced command belongs to a newer generation; surface the fence rather
    // than the owner machinery's refusal to apply against it.
    if (row?.state === "fenced")
      throw new MaisterError(
        "CONFLICT",
        "sync resolver turn was fenced by a newer generation",
        { details: { reason: "assignment_fenced" } },
      );
    if (row?.state === "succeeded" && row.applicationState === "applied")
      return null;
    throw cause;
  }
}
