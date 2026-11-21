import "server-only";

import type { TerminalFailureReason } from "@/lib/flows/graph/transition-target";
import type { Db } from "@/lib/execution-host/db";

import { and, eq } from "drizzle-orm";

import {
  completionGrantSchema,
  completionSettingsSchema,
} from "./completion-policy";
import { platformAllowsAutonomousCompletion } from "./config";
import { recordAutonomousDecision } from "./decisions";

import { platformRuntimeSettings, projects, runs } from "@/lib/db/schema";
import { emitDelegatedReviewIfChild } from "@/lib/runs/delegated-review-emit";
import { emitDomainEvent } from "@/lib/domain-events/outbox";
import { releaseAssignmentForRun } from "@/lib/execution-host/assignments";
import { autonomousCompletionFromSnapshot } from "@/lib/runs/execution-policy";
import { emitWebhookEvent } from "@/lib/webhooks/outbox";

type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

export async function finalizeClassifiedFlowFailure(
  tx: Transaction,
  input: {
    runId: string;
    projectId: string;
    nodeAttemptId: string;
    reason: TerminalFailureReason;
    at: Date;
  },
): Promise<"Failed" | "Review" | null> {
  const [run] = await tx
    .select()
    .from(runs)
    .where(
      and(
        eq(runs.id, input.runId),
        eq(runs.projectId, input.projectId),
        eq(runs.status, "Running"),
      ),
    )
    .for("update");

  if (!run) return null;
  const [platform] = await tx
    .select({
      enabled: platformRuntimeSettings.autonomousCompletionEnabled,
      revision: platformRuntimeSettings.autonomousCompletionRevision,
    })
    .from(platformRuntimeSettings)
    .where(eq(platformRuntimeSettings.id, "singleton"))
    .for("share");
  const [project] = await tx
    .select({
      settings: projects.autonomousCompletion,
      revision: projects.autonomousCompletionRevision,
      archived: projects.archivedAt,
    })
    .from(projects)
    .where(eq(projects.id, input.projectId))
    .for("share");
  const grant = completionGrantSchema.safeParse(run.autonomousCompletionGrant);
  const live = completionSettingsSchema.safeParse(project?.settings);
  const approved =
    run.runKind === "flow" &&
    run.taskId !== null &&
    run.parentRunId === null &&
    run.workspaceMode !== "shared" &&
    autonomousCompletionFromSnapshot(run.executionPolicy) ===
      "evidence_gated" &&
    grant.success &&
    grant.data.flowRevisionId === run.flowRevisionId &&
    grant.data.declaration.failure_reasons?.includes(input.reason);
  const refusal = !approved
    ? "missing_launch_grant"
    : run.promotionHold
      ? "run_held"
      : !platformAllowsAutonomousCompletion(platform?.enabled)
        ? "platform_disabled"
        : !live.success || !live.data.enabled || project?.archived
          ? "project_disabled"
          : null;
  const status = refusal === null ? "Failed" : "Review";

  await tx
    .update(runs)
    .set({
      status,
      endedAt: input.at,
      currentStepId: null,
      reviewEnteredAt: null,
    })
    .where(eq(runs.id, input.runId));
  await releaseAssignmentForRun(tx, input.runId, "run_terminal");
  await recordAutonomousDecision(tx, {
    projectId: input.projectId,
    runId: input.runId,
    action: "fail",
    phase: refusal === null ? "observed" : "refused",
    reason: refusal ?? input.reason,
    createdAt: input.at,
    projectRevision: project?.revision ?? 0,
    platformRevision: platform?.revision ?? 0,
    witness: {
      nodeAttemptId: input.nodeAttemptId,
      failureReason: input.reason,
      flowRevisionId: run.flowRevisionId,
    },
  });

  if (status === "Failed") {
    await emitDomainEvent({
      db: tx,
      kind: "run.failed",
      projectId: input.projectId,
      taskId: run.taskId,
      runId: run.id,
      parentRunId: run.parentRunId,
      actor: { type: "system", id: null },
      occurredAt: input.at,
      cause: { code: "PRECONDITION", source: "graph", reason: input.reason },
      payload: {
        schemaVersion: 1,
        runId: run.id,
        taskId: run.taskId,
        reason: input.reason,
      },
    });
    await emitWebhookEvent({
      db: tx,
      type: "run.failed",
      projectId: input.projectId,
      runId: run.id,
      data: { errorCode: "PRECONDITION", reason: input.reason },
    });
  } else {
    await emitDelegatedReviewIfChild(tx, {
      runId: run.id,
      projectId: input.projectId,
      taskId: run.taskId,
      flowId: run.flowId,
      runKind: run.runKind,
      parentRunId: run.parentRunId,
      cause: "classified_failure_review",
      resultStatus: "absent",
    });
  }

  return status;
}
