import "server-only";

import type { Db } from "@/lib/execution-host/db";

import { and, eq, sql } from "drizzle-orm";

import {
  requireCompanyFlowNodeKnowledgeOwner,
  requireCompanyRunCredentialOwner,
} from "@/lib/agents/company-run-credential-owner";
import { authorizeCompanyUserAction } from "@/lib/company/authority";
import {
  executionAssignments,
  runs,
  specialistRunLinks,
  standOperations,
  standResourceClaims,
  standRestartApprovals,
  standTargets,
} from "@/lib/db/schema";
import { redactQueryError } from "@/lib/db/pg-error";
import { MaisterError } from "@/lib/errors";

type RestartDispatchIdentity = Readonly<{
  operationId: string;
  runId: string;
  nodeAttemptId: string | null;
}>;

/** Resolve the professional from the retained execution, including the current node for a Flow. */
export async function authorizeStandRestartProfessional(
  tx: Db,
  runId: string,
  nodeAttemptId: string | null,
  companyId: string,
  userId: string,
): Promise<void> {
  const root = await requireCompanyRunCredentialOwner(tx, runId);

  if (
    root.companyId !== companyId ||
    root.userId !== userId ||
    (root.snapshot.schemaVersion === 2) !== (nodeAttemptId !== null)
  )
    throw new MaisterError(
      "UNAUTHORIZED",
      "Current stand execution identity is required",
    );
  const professional = nodeAttemptId
    ? await requireCompanyFlowNodeKnowledgeOwner(tx, root, nodeAttemptId)
    : root;

  if (!professional.actionLimits.includes("targets:restart"))
    throw new MaisterError(
      "UNAUTHORIZED",
      "The current role cannot restart the configured stand",
    );
  const [grant] = (
    await tx.execute(sql`
    SELECT id FROM company_grants WHERE company_id=${companyId}
    AND principal_type='agent' AND principal_id=${professional.agentId}
    AND action='targets:restart' AND revoked_at IS NULL FOR SHARE
  `)
  ).rows;

  if (!grant)
    throw new MaisterError(
      "UNAUTHORIZED",
      "Current professional restart authority is required",
    );
  await authorizeCompanyUserAction(tx, userId, companyId, "targets:restart");
}

/** Resolve current dispatch ownership without initiating a command or external action. */
export async function assertStandRestartDispatchOwner(
  db: Db,
  identity: RestartDispatchIdentity,
): Promise<void> {
  try {
    return await db.transaction(async (tx) => {
      const [actor] = await tx
        .select({
          runId: runs.id,
          assignmentId: specialistRunLinks.assignmentId,
        })
        .from(runs)
        .innerJoin(specialistRunLinks, eq(specialistRunLinks.runId, runs.id))
        .innerJoin(
          executionAssignments,
          and(
            eq(executionAssignments.id, runs.executionAssignmentId),
            eq(executionAssignments.runId, runs.id),
            eq(executionAssignments.state, "active"),
          ),
        )
        .where(
          and(
            eq(runs.id, identity.runId),
            eq(runs.status, "Running"),
            sql`${runs.companyCancellationIntent} IS NULL`,
            sql`${runs.budgetState}->'termination' IS NULL`,
          ),
        )
        .for("share", { of: [runs, executionAssignments] });

      if (!actor)
        throw new MaisterError(
          "UNAUTHORIZED",
          "Current placed stand execution is required",
        );
      const [selection] = await tx
        .select({
          operation: standOperations,
          target: standTargets,
          approval: standRestartApprovals,
        })
        .from(standOperations)
        .innerJoin(
          standTargets,
          and(
            eq(standTargets.id, standOperations.targetId),
            eq(standTargets.configRevision, standOperations.configRevision),
            eq(standTargets.enabled, true),
          ),
        )
        .innerJoin(
          standRestartApprovals,
          eq(standRestartApprovals.operationId, standOperations.id),
        )
        .where(
          and(
            eq(standOperations.id, identity.operationId),
            eq(standOperations.assignmentId, actor.assignmentId),
            eq(standOperations.action, "restart"),
            eq(standOperations.effectState, "not_dispatched"),
          ),
        )
        .for("share", { of: [standOperations, standTargets] });

      if (!selection)
        throw new MaisterError(
          "CONFLICT",
          "The exact approved stand restart is unavailable",
        );
      const { operation, target, approval } = selection;

      await authorizeStandRestartProfessional(
        tx,
        actor.runId,
        identity.nodeAttemptId,
        target.companyId,
        operation.initiatingUserId,
      );
      const [witness] = (
        await tx.execute(sql`
        SELECT specialist_execution_owner_epoch(${actor.runId}) AS epoch,
          specialist_run_has_input(${actor.runId},${operation.assignmentId},${operation.inputRevision},${operation.inputSha256}) AS exact_input
      `)
      ).rows;
      const [claim] = await tx
        .select()
        .from(standResourceClaims)
        .where(
          and(
            eq(standResourceClaims.resourceKey, operation.resourceKey),
            eq(standResourceClaims.operationId, operation.id),
            eq(standResourceClaims.unresolved, true),
          ),
        )
        .for("share");

      if (
        typeof witness?.epoch !== "number" ||
        witness.epoch < 1 ||
        witness.exact_input !== true ||
        !claim ||
        approval.requestDigest !== operation.requestDigest ||
        approval.operationRevision !== operation.revision
      )
        throw new MaisterError(
          "CONFLICT",
          "The exact stand dispatch owner or input changed",
        );
    });
  } catch (error) {
    throw redactQueryError(error);
  }
}
