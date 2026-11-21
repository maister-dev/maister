import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { Run, Workspace } from "@/lib/db/schema";
import type { WorkspacePublicationSnapshot } from "../../../runtime/workspace-publication";
import type { MergedPullRequestEvidence } from "./completion-evidence";

import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";

import { autoPromotionEnabledFromEnv } from "./config";
import {
  completionGrantSchema,
  completionSettingsSchema,
} from "./completion-policy";
import { evaluateCompletionEvidence } from "./completion-evidence";
import { readCompletionEvidence } from "./completion-readers";
import { recordAutonomousDecision } from "./decisions";

import {
  platformRuntimeSettings,
  projects,
  runAutonomousDecisions,
} from "@/lib/db/schema";
import { autonomousCompletionFromSnapshot } from "@/lib/runs/execution-policy";

type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

export type CompletionAuthorization = {
  projectId: string;
  projectRevision: number;
  platformRevision: number;
  head: string;
  base: string;
  generation: string;
  reviewEpoch: string;
  mergedPr?: MergedPullRequestEvidence;
};

const retainedMergeClaim = z.object({
  projectId: z.string().min(1),
  projectRevision: z.number().int(),
  platformRevision: z.number().int(),
  head: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/),
  base: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/),
  generation: z.string().min(1),
  reviewEpoch: z.iso.datetime(),
  attemptId: z.uuid(),
  effectAttemptId: z.uuid().optional(),
});

export async function readRetainedMergeClaim(
  db: Db,
  run: Run,
  workspace: Workspace,
): Promise<{
  attemptId: string;
  effectAttemptId: string;
  authorization: CompletionAuthorization;
} | null> {
  if (
    !run.projectId ||
    !workspace.promotionAttemptId ||
    workspace.promotionMode !== "local_merge" ||
    run.deliveryPolicySnapshot?.strategy !== "merge" ||
    run.deliveryPolicySnapshot.push !== "never"
  )
    return null;
  const [row] = await db
    .select({ witness: runAutonomousDecisions.witness })
    .from(runAutonomousDecisions)
    .where(
      and(
        eq(runAutonomousDecisions.runId, run.id),
        eq(runAutonomousDecisions.projectId, run.projectId),
        eq(runAutonomousDecisions.action, "promote"),
        eq(runAutonomousDecisions.phase, "claimed"),
        sql`${runAutonomousDecisions.witness}->>'attemptId' = ${workspace.promotionAttemptId}`,
      ),
    )
    .limit(1);
  const witness = retainedMergeClaim.safeParse(row?.witness);

  if (
    !witness.success ||
    witness.data.projectId !== run.projectId ||
    witness.data.reviewEpoch !== run.reviewEnteredAt?.toISOString()
  )
    return null;
  const {
    attemptId,
    effectAttemptId = attemptId,
    ...authorization
  } = witness.data;

  return { attemptId, effectAttemptId, authorization };
}

export async function evaluatePromotionClaim(
  tx: Transaction,
  run: Run,
  workspace: Workspace,
  observed: WorkspacePublicationSnapshot | null,
): Promise<CompletionAuthorization | null> {
  if (!run.projectId) return null;
  const [project] = await tx
    .select({
      id: projects.id,
      settings: projects.autonomousCompletion,
      revision: projects.autonomousCompletionRevision,
      archivedAt: projects.archivedAt,
    })
    .from(projects)
    .where(eq(projects.id, run.projectId))
    .for("share");
  const [platform] = await tx
    .select({
      enabled: platformRuntimeSettings.autonomousCompletionEnabled,
      revision: platformRuntimeSettings.autonomousCompletionRevision,
    })
    .from(platformRuntimeSettings)
    .where(eq(platformRuntimeSettings.id, "singleton"))
    .for("share");
  const grant = completionGrantSchema.safeParse(run.autonomousCompletionGrant);
  const current = completionSettingsSchema.safeParse(project?.settings);
  const witness = {
    flowRevisionId: run.flowRevisionId,
    reviewEpoch: run.reviewEnteredAt?.toISOString() ?? null,
    head: observed?.headSha ?? null,
    base: observed?.evidence?.baseSha ?? null,
  };
  let refusal =
    run.status !== "Review" ||
    run.runKind !== "flow" ||
    run.taskId === null ||
    run.parentRunId !== null ||
    run.workspaceMode === "shared" ||
    !run.reviewEnteredAt ||
    workspace.promotionState === "reopened"
      ? "not_graph_review"
      : !grant.success ||
          autonomousCompletionFromSnapshot(run.executionPolicy) !==
            "evidence_gated"
        ? "missing_launch_grant"
        : run.promotionHold
          ? "run_held"
          : !platform?.enabled || !autoPromotionEnabledFromEnv()
            ? "platform_disabled"
            : !current.success || !current.data.enabled || project?.archivedAt
              ? "project_disabled"
              : run.deliveryPolicySnapshot?.strategy !== "pull_request" &&
                  (run.deliveryPolicySnapshot?.strategy !== "merge" ||
                    run.deliveryPolicySnapshot.push !== "never")
                ? "delivery_strategy"
                : null;
  const evidence =
    !refusal && current.success && current.data.enabled
      ? await readCompletionEvidence({
          db: tx,
          run,
          workspace,
          observed,
          currentLimits: current.data,
          now: new Date(),
        })
      : null;
  const policy = {
    projectRevision: project?.revision ?? 0,
    platformRevision: platform?.revision ?? 0,
  };

  if (evidence) {
    const decision = evaluateCompletionEvidence(evidence);

    if (decision.eligible)
      return {
        ...policy,
        projectId: run.projectId,
        head: evidence.anchor.head,
        base: evidence.anchor.base,
        generation: evidence.anchor.generation,
        reviewEpoch: witness.reviewEpoch ?? "",
        ...(evidence.mergedPr ? { mergedPr: evidence.mergedPr } : {}),
      };
    refusal = decision.reason;
  }
  await recordAutonomousDecision(tx, {
    ...policy,
    projectId: run.projectId,
    runId: run.id,
    action:
      run.deliveryPolicySnapshot?.strategy === "pull_request"
        ? "finalize_pr"
        : "promote",
    phase: "refused",
    reason: refusal ?? "missing_required_evidence",
    witness,
  });

  return null;
}
