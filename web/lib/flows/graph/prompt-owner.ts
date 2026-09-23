import "server-only";

import type { BoundClient } from "@/lib/execution-host/client";
import type { Db } from "@/lib/execution-host/db";
import type { PromptOwnerAdmission } from "@/lib/execution-host/ledger";
import type { GateResult } from "@/lib/db/schema";
import type { GateDef } from "@/lib/config.schema";

import { and, desc, eq } from "drizzle-orm";
import pino from "pino";

import { decodeGatePromptCompletion } from "./gate-prompt-completion";
import { assertGatePermissionResult } from "./gate-permission-resume";
import {
  createGateResult,
  markGateFailed,
  markGatePassed,
  markGateStale,
} from "./gate-store";
import { lockFlowPromptOwner } from "./prompt-owner-authority";
import { prepareNodePrompt } from "./node-prompt-owner";
import { prepareConsensusPrompt } from "./consensus/prompt-owner";

import { assertGatePermissionContinuation } from "@/lib/execution-host/permission-handoff-source";
import {
  gateResults,
  executionCommands,
  nodeAttempts,
  runs,
  runSessionIncarnations,
  runSessions,
} from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import { isTurnLostError } from "@/lib/reconcile-evidence";
import {
  closeTurnLostAttempt,
  TurnLostCasLost,
} from "@/lib/runs/turn-lost-boundary";
import {
  lockCurrentSessionAssignment,
  staleSessionBinding,
} from "@/lib/execution-host/session-binding";
import {
  createPromptOwnerRegistry,
  definePromptOwnerAdapter,
  PromptOwnerInvariantError,
} from "@/lib/execution-host/prompt-owners";

export type GatePromptOwner = Readonly<{
  variant: "gate_skill" | "gate_ai";
  nodeAttemptId: string;
  gateId: string;
  evaluationId: string;
  promptOrdinal: number;
}>;

/** A persisted command still owns the work. Only its application worker may
 * resolve it; an unavailable reader must not manufacture a failed gate.
 */
export class FlowPromptContinuationPending extends MaisterError {
  constructor(commandId: string, cause: unknown) {
    super("PRECONDITION", "Flow prompt awaits durable owner application", {
      details: { reason: "flow_prompt_continuation_pending", commandId },
      ...(cause instanceof Error ? { cause } : {}),
    });
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function gatePromptOperationKey(owner: GatePromptOwner): string {
  return `flow_node_attempt:${owner.variant}:${owner.evaluationId}:${owner.promptOrdinal}`;
}

export async function waitForGateApplication(
  db: Db,
  client: BoundClient,
  commandId: string,
  signal?: AbortSignal,
): Promise<void> {
  try {
    await client.waitForPrompt(
      { commandId },
      { owners: flowPromptOwners, signal },
    );
  } catch (cause) {
    // A failed host turn can already have applied its failed gate verdict.
    // The caller consumes that domain row, never the transport exception.
    try {
      const [command] = await db
        .select({ applicationState: executionCommands.applicationState })
        .from(executionCommands)
        .where(eq(executionCommands.id, commandId));

      if (command?.applicationState === "applied") return;
    } catch (readCause) {
      throw new FlowPromptContinuationPending(commandId, readCause);
    }
    throw new FlowPromptContinuationPending(commandId, cause);
  }
}

/** A settled consensus turn with a deferred owner application releases the
 * graph driver; the application and continuation workers own its retry.
 */
export async function waitForConsensusApplication(
  db: Db,
  client: BoundClient,
  commandId: string,
  signal?: AbortSignal,
): Promise<void> {
  try {
    const result = await client.waitForPromptOwnerApplication(
      { commandId },
      { owners: flowPromptOwners, signal },
    );

    if (result === null)
      throw new FlowPromptContinuationPending(
        commandId,
        new PromptOwnerInvariantError("consensus_application_pending"),
      );
  } catch (cause) {
    if (cause instanceof FlowPromptContinuationPending) throw cause;
    try {
      const [command] = await db
        .select({ applicationState: executionCommands.applicationState })
        .from(executionCommands)
        .where(eq(executionCommands.id, commandId));

      if (command?.applicationState === "applied") return;
    } catch (readCause) {
      throw new FlowPromptContinuationPending(commandId, readCause);
    }
    throw new FlowPromptContinuationPending(commandId, cause);
  }
}

const log = pino({
  name: "flow-prompt-owner",
  level: process.env.LOG_LEVEL ?? "info",
});

/** Re-entering the same attempt reuses its evaluation. Only an explicitly stale
 * evaluation admits a replacement; a restart is not a new paid gate check.
 */
export async function getOrCreateGateEvaluation(
  db: Db,
  input: { runId: string; nodeAttemptId: string; gate: GateDef },
): Promise<GateResult & { commandId?: string }> {
  return db.transaction(async (tx) => {
    const [run] = await tx
      .select()
      .from(runs)
      .where(eq(runs.id, input.runId))
      .for("update");
    const [attempt] = await tx
      .select()
      .from(nodeAttempts)
      .where(eq(nodeAttempts.id, input.nodeAttemptId))
      .for("update")
      .limit(1);

    if (
      !run ||
      run.runKind !== "flow" ||
      !["Running", "NeedsInput"].includes(run.status) ||
      !attempt ||
      attempt.runId !== input.runId ||
      run.currentStepId !== attempt.nodeId ||
      !["Running", "Succeeded"].includes(attempt.status)
    )
      throw new PromptOwnerInvariantError("gate_evaluation_attempt");
    const [existing] = await tx
      .select()
      .from(gateResults)
      .where(
        and(
          eq(gateResults.runId, input.runId),
          eq(gateResults.nodeAttemptId, input.nodeAttemptId),
          eq(gateResults.gateId, input.gate.id),
        ),
      )
      .orderBy(desc(gateResults.createdAt), desc(gateResults.id))
      .limit(1);

    if (existing && existing.kind !== input.gate.kind)
      throw new PromptOwnerInvariantError("gate_evaluation_kind");
    if (existing && existing.status !== "stale") {
      if (
        existing.permissionResume?.kind === "permission_result" &&
        existing.permissionResume.assignmentId === run.executionAssignmentId
      ) {
        await assertGatePermissionResult(
          tx,
          existing,
          run.executionAssignmentId!,
        );

        return existing;
      }
      const [command] = await tx
        .select({
          id: executionCommands.id,
          assignmentId: executionCommands.executionAssignmentId,
        })
        .from(executionCommands)
        .where(
          and(
            eq(executionCommands.runId, run.id),
            eq(
              executionCommands.logicalOperationKey,
              gatePromptOperationKey({
                variant:
                  input.gate.kind === "skill_check" ? "gate_skill" : "gate_ai",
                nodeAttemptId: attempt.id,
                gateId: existing.gateId,
                evaluationId: existing.id,
                promptOrdinal: existing.promptOrdinal,
              }),
            ),
          ),
        )
        .limit(1);

      if (
        command &&
        !(await lockCurrentSessionAssignment(tx, {
          runId: run.id,
          assignmentId: command.assignmentId,
        }))
      )
        throw staleSessionBinding(run.id, command.assignmentId);

      if (
        run.status === "NeedsInput" &&
        !command &&
        existing.permissionResume?.assignmentId !== run.executionAssignmentId
      )
        throw new PromptOwnerInvariantError("gate_permission_command_missing");

      return { ...existing, ...(command ? { commandId: command.id } : {}) };
    }
    if (run.status !== "Running")
      throw new PromptOwnerInvariantError("gate_permission_new_evaluation");
    const { id } = await createGateResult({
      runId: input.runId,
      nodeAttemptId: input.nodeAttemptId,
      gateId: input.gate.id,
      kind: input.gate.kind,
      mode: input.gate.mode,
      inputArtifactRefs: input.gate.inputArtifacts,
      status: "running",
      db: tx,
    });
    const [created] = await tx
      .select()
      .from(gateResults)
      .where(eq(gateResults.id, id));

    return created;
  });
}

export async function admitGatePrompt(
  tx: Db,
  client: BoundClient,
  hostSessionId: string,
  owner: GatePromptOwner,
): Promise<PromptOwnerAdmission> {
  const runId = client.assignment.runId;
  const assignment = await lockCurrentSessionAssignment(tx, {
    runId,
    assignmentId: client.assignment.id,
  });

  if (!assignment) throw staleSessionBinding(runId, client.assignment.id);
  const [run] = await tx.select().from(runs).where(eq(runs.id, runId)).limit(1);
  const [attempt] = await tx
    .select()
    .from(nodeAttempts)
    .where(eq(nodeAttempts.id, owner.nodeAttemptId))
    .for("update")
    .limit(1);
  const [evaluation] = await tx
    .select()
    .from(gateResults)
    .where(eq(gateResults.id, owner.evaluationId))
    .for("update")
    .limit(1);

  if (
    run?.runKind !== "flow" ||
    !(
      run.status === "Running" ||
      (run.status === "NeedsInput" &&
        evaluation?.permissionResume?.assignmentId === assignment.id &&
        evaluation.permissionResume.promptOrdinal === owner.promptOrdinal)
    ) ||
    !attempt ||
    attempt.runId !== runId ||
    attempt.executionAssignmentId !== assignment.id ||
    run.currentStepId !== attempt.nodeId ||
    !["Running", "Succeeded"].includes(attempt.status) ||
    !evaluation ||
    evaluation.runId !== runId ||
    evaluation.nodeAttemptId !== attempt.id ||
    evaluation.gateId !== owner.gateId ||
    evaluation.promptOrdinal !== owner.promptOrdinal ||
    (owner.promptOrdinal > 0 &&
      (evaluation.permissionResume?.assignmentId !== assignment.id ||
        evaluation.permissionResume.promptOrdinal !== owner.promptOrdinal)) ||
    evaluation.kind !==
      (owner.variant === "gate_skill" ? "skill_check" : "ai_judgment") ||
    evaluation.status !== "running"
  )
    throw new PromptOwnerInvariantError("gate_admission_generation");
  if (evaluation.permissionResume?.kind === "permission_continue")
    await assertGatePermissionContinuation(tx, evaluation, assignment.id);
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
    throw new PromptOwnerInvariantError("gate_admission_incarnation");

  return {
    owner: {
      kind: "flow_node_attempt",
      ref: {
        version: 1,
        ...owner,
        runId,
        runSessionId: binding.session.id,
        incarnationId: binding.incarnation.id,
        assignmentId: assignment.id,
        assignmentEpoch: assignment.epoch,
        promptOrdinal: owner.promptOrdinal,
      },
    },
    logicalOperationKey: gatePromptOperationKey(owner),
  };
}

/** Gate evidence is decoded outside the application transaction. The immutable
 * command retains the complete output; the domain stores its verdict once.
 */
export const flowPromptOwnerAdapter = definePromptOwnerAdapter(
  "flow_node_attempt",
  async ({ db, owner, command, outcome }) => {
    const ref = owner.ref;

    if (ref.variant === "node" || ref.variant === "permission_resume")
      return prepareNodePrompt({ db, ref, command, outcome });

    if (
      ref.variant === "consensus_verifier" ||
      ref.variant === "consensus_synthesis"
    )
      return prepareConsensusPrompt({ db, ref, command, outcome });

    if (ref.variant !== "gate_ai" && ref.variant !== "gate_skill")
      throw new PromptOwnerInvariantError("flow_owner_variant_unimplemented");
    // ADR-177 T3.3, the gate half. A lost turn is not a verdict either: decoded
    // it would fail the gate, and a FAILED gate is a real product outcome that
    // sends the run to rework or blocks promotion — recording a host restart as
    // one is worse than recording it as nothing. Same boundary, same row set.
    const gateTurnLost =
      outcome.state === "failed" && isTurnLostError(outcome.error);
    const completion = gateTurnLost
      ? null
      : await decodeGatePromptCompletion({ db, ref, outcome });
    const verdict = completion?.verdict;
    const passed = completion?.status === "passed";

    return {
      apply: async (tx) => {
        if (!(await lockFlowPromptOwner(tx, ref, command.targetSessionId)))
          return "superseded";
        const [run] = await tx
          .select()
          .from(runs)
          .where(eq(runs.id, ref.runId))
          .limit(1);
        const [currentAttempt] = await tx
          .select()
          .from(nodeAttempts)
          .where(eq(nodeAttempts.id, ref.nodeAttemptId))
          .for("update")
          .limit(1);
        const [evaluation] = await tx
          .select()
          .from(gateResults)
          .where(eq(gateResults.id, ref.evaluationId))
          .for("update")
          .limit(1);

        if (!currentAttempt || !evaluation) return "superseded";
        if (gateTurnLost) {
          // The SAME preconditions as the verdict path below, minus only the
          // ones that identify a VERDICT (flow revision, gate kind, prompt
          // ordinal) — a lost turn produces none. Keeping `currentStepId ===
          // nodeId` is not optional: without it this would crash a run whose
          // cursor has already moved off the gate's node, which is a strictly
          // weaker guard than the sibling arm it stands beside.
          if (
            run?.runKind !== "flow" ||
            !["Running", "NeedsInput"].includes(run.status) ||
            run.currentStepId !== currentAttempt.nodeId ||
            currentAttempt.runId !== ref.runId ||
            currentAttempt.executionAssignmentId !== ref.assignmentId ||
            evaluation.runId !== ref.runId ||
            evaluation.nodeAttemptId !== currentAttempt.id
          )
            return "superseded";
          try {
            await closeTurnLostAttempt(tx, {
              runId: ref.runId,
              nodeAttemptId: currentAttempt.id,
              reason: "turn-lost",
              fromStatuses: [run.status],
              fromAttemptStatuses: [currentAttempt.status],
              // Gates run AFTER the action persisted its completion on this
              // same attempt, and that completion is the node's real result:
              // it is preserved, not overwritten. Requiring it NULL here
              // matched zero rows on every real lost gate turn.
              admitCompletedAction: true,
            });
          } catch (error) {
            // A lost CAS inside an owner apply is `superseded`, never a throw.
            // Throwing rolls the application back and the layer retries until
            // the command POISONS — turning a recoverable lost turn into a
            // permanently stalled run.
            if (error instanceof TurnLostCasLost) return "superseded";
            throw error;
          }
          // The evaluation row is `running` from `createGateResult` and every
          // other terminal gate path writes a terminal status. `stale` is the
          // truthful one here: the host lost the turn, so the gate was
          // INVALIDATED, not decided — recording `failed` would turn a
          // supervisor restart into a product verdict that sends the run to
          // rework or blocks promotion. Leaving it `running` is the shape
          // `runGateStepGuarded` exists to prevent (`gates-exec.ts`).
          await markGateStale(evaluation.id, tx);
          log.warn(
            {
              runId: ref.runId,
              nodeAttemptId: ref.nodeAttemptId,
              gateId: ref.gateId,
              evaluationId: ref.evaluationId,
              commandId: command.id,
            },
            "owned-gate-turn-lost",
          );

          return "applied";
        }
        if (
          run?.runKind !== "flow" ||
          !["Running", "NeedsInput"].includes(run.status) ||
          run.currentStepId !== currentAttempt.nodeId ||
          run.flowRevisionId !== completion!.flowRevisionId ||
          currentAttempt.runId !== ref.runId ||
          currentAttempt.executionAssignmentId !== ref.assignmentId ||
          !["Running", "Succeeded"].includes(currentAttempt.status) ||
          evaluation.runId !== ref.runId ||
          evaluation.nodeAttemptId !== currentAttempt.id ||
          evaluation.gateId !== ref.gateId ||
          evaluation.promptOrdinal !== ref.promptOrdinal ||
          evaluation.kind !== completion!.gateKind ||
          evaluation.status !== "running"
        )
          return "superseded";
        if (passed) await markGatePassed(evaluation.id, verdict!, tx);
        else await markGateFailed(evaluation.id, verdict!, tx);
        log.info(
          {
            runId: ref.runId,
            nodeAttemptId: ref.nodeAttemptId,
            gateId: ref.gateId,
            evaluationId: ref.evaluationId,
            commandId: command.id,
            status: passed ? "passed" : "failed",
          },
          "owned-gate-result-applied",
        );

        return "applied";
      },
    };
  },
);

export const flowPromptOwners = createPromptOwnerRegistry([
  flowPromptOwnerAdapter,
]);

export { waitForPromptIncarnation } from "@/lib/execution-host/prompt-incarnation";
