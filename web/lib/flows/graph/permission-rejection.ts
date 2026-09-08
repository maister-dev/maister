import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { GateResult } from "@/lib/db/schema";
import type { PreparedPermissionRejection } from "./permission-resume";

import { and, desc, eq } from "drizzle-orm";
import pino from "pino";

import { lockRejectedPermissionInputEvidence } from "./permission-result-evidence";
import { markNodeFailed } from "./ledger";
import { markGateFailed } from "./gate-store";

import {
  executionAssignments,
  executionCommands,
  gateResults,
  hitlRequests,
  nodeAttempts,
  runSessionIncarnations,
  runs,
} from "@/lib/db/schema";
import { flowPermissionEnvelopeSchema } from "@/lib/execution-host/flow-permission-source";
import { gateParentActionDigest } from "@/lib/execution-host/permission-handoff-source";
import { PromptOwnerInvariantError } from "@/lib/execution-host/prompt-owners";
import { markFailed } from "@/lib/execution-host/commands";
import {
  completeHitlAssignmentFromCurrentActor,
  systemCloseActiveAssignmentsForRun,
} from "@/lib/assignments/service";
import { emitDomainEvent } from "@/lib/domain-events/outbox";
import { emitWebhookEvent } from "@/lib/webhooks/outbox";

const log = pino({
  name: "flow-permission-rejection",
  level: process.env.LOG_LEVEL ?? "info",
});

/** Settle the explicit input rejection under the current parked domain claim.
 * No old prompt owner gains write authority and no execution slot is allocated.
 * The original action/verdict remains evidence; it is not rewritten as this error.
 */
export async function failCheckpointedFlowPermission(
  db: Db,
  runId: string,
  prepared: PreparedPermissionRejection,
): Promise<void> {
  const result = await db.transaction(async (tx) => {
    const [run] = await tx
      .select()
      .from(runs)
      .where(eq(runs.id, runId))
      .for("update");
    const [hitl] = await tx
      .select()
      .from(hitlRequests)
      .where(eq(hitlRequests.id, prepared.hitlRequestId))
      .for("update");
    const parsed = flowPermissionEnvelopeSchema.safeParse(hitl?.schema);
    const response = hitl?.response as Record<string, unknown> | null;

    if (
      !run?.projectId ||
      run.runKind !== "flow" ||
      run.status !== "NeedsInputIdle" ||
      !run.currentStepId ||
      !hitl ||
      hitl.runId !== runId ||
      hitl.kind !== "permission" ||
      hitl.respondedAt !== null ||
      !parsed.success ||
      typeof response?.optionId !== "string" ||
      !parsed.data.options.some(
        (option) => option.optionId === response.optionId,
      )
    )
      throw new PromptOwnerInvariantError("permission_rejection_generation");
    const source = parsed.data;
    const owner = source.flowPrompt;
    const [command] = await tx
      .select()
      .from(executionCommands)
      .where(eq(executionCommands.id, owner.commandId))
      .for("update");
    const [prior] = await tx
      .select()
      .from(executionAssignments)
      .where(eq(executionAssignments.id, owner.assignmentId))
      .for("update");
    const [attempt] = await tx
      .select()
      .from(nodeAttempts)
      .where(
        and(
          eq(nodeAttempts.runId, runId),
          eq(nodeAttempts.nodeId, run.currentStepId),
        ),
      )
      .orderBy(desc(nodeAttempts.attempt))
      .limit(1)
      .for("update");
    const [incarnation] = await tx
      .select()
      .from(runSessionIncarnations)
      .where(eq(runSessionIncarnations.id, owner.incarnationId))
      .for("update");
    const ref = command?.ownerRef;

    if (
      !command ||
      command.kind !== "session.prompt" ||
      command.ownerKind !== "flow_node_attempt" ||
      command.runId !== runId ||
      !ref ||
      (ref.variant !== "node" &&
        ref.variant !== "permission_resume" &&
        ref.variant !== "gate_ai" &&
        ref.variant !== "gate_skill") ||
      ref.runId !== runId ||
      ref.nodeAttemptId !== owner.nodeAttemptId ||
      ref.promptOrdinal !== owner.promptOrdinal ||
      ref.incarnationId !== owner.incarnationId ||
      ref.assignmentId !== owner.assignmentId ||
      ("variant" in owner
        ? owner.variant === "permission_resume"
          ? ref.variant !== "permission_resume" ||
            ref.hitlRequestId !== owner.hitlRequestId
          : ref.variant !== owner.variant ||
            ref.evaluationId !== owner.evaluationId ||
            ref.gateId !== owner.gateId
        : ref.variant !== "node") ||
      !prior ||
      prior.runId !== runId ||
      run.executionAssignmentId !== prior.id ||
      prior.state !== "released" ||
      prior.releasedReason !== "checkpointed" ||
      command.executionAssignmentId !== prior.id ||
      command.executionHostId !== prior.executionHostId ||
      command.assignmentEpoch !== prior.epoch ||
      ref.assignmentEpoch !== prior.epoch ||
      command.targetSessionId !== source.supervisorSessionId ||
      !incarnation ||
      ref.runSessionId !== incarnation.runSessionId ||
      incarnation.executionAssignmentId !== prior.id ||
      incarnation.executionHostId !== prior.executionHostId ||
      incarnation.assignmentEpoch !== prior.epoch ||
      incarnation.hostSessionId !== source.supervisorSessionId ||
      !attempt ||
      attempt.id !== owner.nodeAttemptId ||
      attempt.executionAssignmentId !== prior.id ||
      attempt.finishContinuation !== null ||
      prepared.parentActionSha256 !==
        gateParentActionDigest(attempt.actionCompletion)
    )
      throw new PromptOwnerInvariantError("permission_rejection_source");
    let evaluation: GateResult | undefined;

    if ("evaluationId" in owner) {
      [evaluation] = await tx
        .select()
        .from(gateResults)
        .where(
          and(
            eq(gateResults.runId, runId),
            eq(gateResults.nodeAttemptId, attempt.id),
            eq(gateResults.gateId, owner.gateId),
          ),
        )
        .orderBy(desc(gateResults.createdAt), desc(gateResults.id))
        .limit(1)
        .for("update");
      if (
        !["Running", "Succeeded"].includes(attempt.status) ||
        !evaluation ||
        evaluation.id !== owner.evaluationId ||
        evaluation.promptOrdinal !== owner.promptOrdinal ||
        evaluation.kind !==
          (owner.variant === "gate_skill" ? "skill_check" : "ai_judgment") ||
        !["running", "passed", "failed"].includes(evaluation.status) ||
        hitl.stepId !== evaluation.gateId ||
        (owner.promptOrdinal > 0 &&
          evaluation.permissionResume?.assignmentId !== prior.id)
      )
        throw new PromptOwnerInvariantError("permission_rejection_gate");
    } else if (
      !["ai_coding", "judge", "orchestrator"].includes(attempt.nodeType) ||
      attempt.status !== "Running" ||
      attempt.endedAt !== null ||
      attempt.actionPromptOrdinal !== owner.promptOrdinal ||
      hitl.stepId !== attempt.nodeId
    )
      throw new PromptOwnerInvariantError("permission_rejection_attempt");

    const { input } = await lockRejectedPermissionInputEvidence(
      tx,
      {
        run: { ...run, projectId: run.projectId },
        hitl,
        response: { ...response, optionId: response.optionId },
        source,
        command,
        prior,
        incarnation,
      },
      prepared,
    );
    const settled = await markFailed(
      tx,
      input.id,
      null,
      prepared.inputReceipt.body!,
    );

    if (!settled.changed && settled.row?.state !== "failed")
      throw new PromptOwnerInvariantError("permission_rejection_settlement");
    await tx
      .update(executionCommands)
      .set({ receiptEvidence: prepared.inputReceipt })
      .where(eq(executionCommands.id, input.id));
    await tx
      .update(hitlRequests)
      .set({
        respondedAt: new Date(),
        response: {
          ...response,
          _audit: {
            ...(typeof response._audit === "object" && response._audit !== null
              ? response._audit
              : {}),
            rejectedDeliveryCommandId: input.id,
            sourceCommandId: command.id,
            assignmentId: prior.id,
            incarnationId: incarnation.id,
            requestId: source.requestId,
            errorCode: "HITL_TIMEOUT",
          },
        },
      })
      .where(eq(hitlRequests.id, hitl.id));
    await completeHitlAssignmentFromCurrentActor({
      db: tx,
      hitlRequestId: hitl.id,
      eventKind: "responded",
      payload: {
        optionId: response.optionId,
        deliveryDisposition: "rejected",
        errorCode: "HITL_TIMEOUT",
      },
    });
    if (evaluation?.status === "running")
      await markGateFailed(evaluation.id, undefined, tx);
    await markNodeFailed(
      attempt.id,
      {
        errorCode: "HITL_TIMEOUT",
        stdout: attempt.stdout,
        ...(attempt.exitCode !== null ? { exitCode: attempt.exitCode } : {}),
      },
      tx,
    );
    await tx
      .update(runs)
      .set({
        status: "Failed",
        endedAt: new Date(),
        keepaliveUntil: null,
        resumeRequestedAt: null,
        flowDriverToken: null,
        flowDriverLeaseExpiresAt: null,
      })
      .where(eq(runs.id, runId));
    await systemCloseActiveAssignmentsForRun({
      db: tx,
      runId,
      reason: "checkpointed permission delivery rejected",
    });
    await emitWebhookEvent({
      db: tx,
      type: "run.failed",
      projectId: run.projectId,
      runId,
      data: { errorCode: "HITL_TIMEOUT" },
    });
    await emitDomainEvent({
      db: tx,
      kind: "run.failed",
      projectId: run.projectId,
      runId,
      taskId: run.taskId,
      actor: { type: "system", id: null },
      parentRunId: run.parentRunId,
      payload: {
        runId,
        taskId: run.taskId,
        flowId: run.flowId,
        runKind: run.runKind,
        reason: "HITL_TIMEOUT",
      },
    });

    return {
      inputCommandId: input.id,
      sourceCommandId: command.id,
      nodeAttemptId: attempt.id,
    };
  });

  log.warn({ runId, ...result }, "checkpointed-permission-rejection-settled");
}
