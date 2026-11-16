import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { IssuedCommand } from "@/lib/execution-host/ledger";
import type { StandOperation } from "./operation-types";

import { and, desc, eq, sql } from "drizzle-orm";

import {
  resolveStandCredential,
  resolveStandExecutionActor,
} from "./execution-actor";
import { standTargetReceiptSchema } from "./operation-types";
import {
  adoptStandTargetReceipt,
  retainStandUnknown,
} from "./receipt-adoption";

import { resolveKnowledgeRunIdentity } from "@/lib/brain/knowledge-run-identity";
import {
  executionAssignments,
  executionHosts,
  runs,
  specialistRunLinks,
  standOperations,
  standOperationObservations,
  standResourceClaims,
  standRestartApprovals,
  standTargets,
} from "@/lib/db/schema";
import { redactQueryError } from "@/lib/db/pg-error";
import { isMaisterError, MaisterError } from "@/lib/errors";
import { COMMAND_POLICY, deliverCommand } from "@/lib/execution-host/deliverer";
import { defaultTransport } from "@/lib/execution-host/default-transport";
import { issueCommand } from "@/lib/execution-host/ledger";

type RestartDispatchIdentity = Readonly<{ operationId: string }> &
  (
    | Readonly<{ tokenId: string }>
    | Readonly<{ runId: string; nodeAttemptId: string | null }>
  );

/** Resolve the professional from the retained execution, including the current node for a Flow. */
export async function authorizeStandRestartProfessional(
  tx: Db,
  runId: string,
  nodeAttemptId: string | null,
  companyId: string,
  operation: Pick<
    typeof standOperations.$inferSelect,
    "initiatingUserId" | "assignmentId" | "inputRevision"
  >,
): Promise<void> {
  const execution = await resolveKnowledgeRunIdentity(tx, runId, nodeAttemptId);
  const actor = await resolveStandExecutionActor(
    tx,
    execution.identity,
    operation.assignmentId,
    operation.inputRevision,
    "targets:restart",
  );

  if (
    actor.companyId !== companyId ||
    actor.userId !== operation.initiatingUserId ||
    (execution.runKind === "flow") !== (nodeAttemptId !== null)
  )
    throw new MaisterError(
      "UNAUTHORIZED",
      "Current stand execution identity is required",
    );
}

/** Commit the owner, observed precondition and command before transport. */
export async function prepareStandRestartDispatch(
  db: Db,
  identity: RestartDispatchIdentity,
): Promise<IssuedCommand<RestartCommandPayload>> {
  try {
    return await db.transaction(async (tx) => {
      const token =
        "tokenId" in identity
          ? await resolveStandCredential(tx, identity.tokenId)
          : null;
      const runId = token
        ? token.actor.runId
        : "runId" in identity
          ? identity.runId
          : null;
      const nodeAttemptId = token
        ? token.actor.attemptId
        : "nodeAttemptId" in identity
          ? identity.nodeAttemptId
          : null;

      if (!runId)
        throw new MaisterError(
          "UNAUTHORIZED",
          "A current specialist execution is required",
        );
      const [actor] = await tx
        .select({
          runId: runs.id,
          assignmentId: specialistRunLinks.assignmentId,
          placement: executionAssignments,
          host: executionHosts,
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
        .innerJoin(
          executionHosts,
          eq(executionHosts.id, executionAssignments.executionHostId),
        )
        .where(
          and(
            eq(runs.id, runId),
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
        .for("no key update", { of: [standOperations, standTargets] });

      if (!selection)
        throw new MaisterError(
          "CONFLICT",
          "The exact approved stand restart is unavailable",
        );
      const { operation, target, approval } = selection;

      if (token)
        await resolveStandExecutionActor(
          tx,
          token,
          operation.assignmentId,
          operation.inputRevision,
          "targets:restart",
        );

      await authorizeStandRestartProfessional(
        tx,
        actor.runId,
        nodeAttemptId,
        target.companyId,
        operation,
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
        .for("no key update");

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
      const [observation] = await tx
        .select()
        .from(standOperationObservations)
        .where(eq(standOperationObservations.operationId, operation.id))
        .orderBy(desc(standOperationObservations.targetSequence))
        .limit(1);

      if (
        !observation ||
        observation.observedState === "unknown" ||
        (observation.observedState === "active" &&
          observation.invocationId === null) ||
        (observation.invocationId !== null &&
          !/^[a-f0-9]{32}$/.test(observation.invocationId))
      )
        throw new MaisterError(
          "PRECONDITION",
          "A retained before-effect stand observation is required",
          {
            details: { reason: "stand_before_observation_required" },
          },
        );
      const payload: RestartCommandPayload = {
        operationId: operation.id,
        targetIncarnation: operation.targetIncarnation,
        componentId: operation.componentId,
        action: "restart",
        requestDigest: operation.requestDigest,
        resourceKey: operation.resourceKey,
        ownerEpoch: claim.ownerEpoch + 1,
        businessOwnerEpoch: witness.epoch,
        nodeAttemptId,
        beforeObservationId: observation.id,
        ...(operation.predecessorId
          ? { predecessorId: operation.predecessorId }
          : {}),
        before: {
          invocationId: observation.invocationId,
          state: observation.observedState,
        },
      };
      const issued = await issueCommand(tx, {
        assignment: actor.placement,
        host: actor.host,
        kind: "stand.dispatch",
        payload,
        maxAttempts: COMMAND_POLICY["stand.dispatch"].maxAttempts,
      });

      await tx
        .update(standResourceClaims)
        .set({
          ownerId: issued.row.id,
          ownerEpoch: payload.ownerEpoch,
          expiresAt: sql`clock_timestamp()+interval '120 seconds'`,
        })
        .where(eq(standResourceClaims.resourceKey, operation.resourceKey));
      await tx
        .update(standOperations)
        .set({
          effectState: "dispatching",
          revision: operation.revision + 1,
        })
        .where(eq(standOperations.id, operation.id));

      return issued;
    });
  } catch (error) {
    throw redactQueryError(error);
  }
}

type RestartCommandPayload = Readonly<{
  operationId: string;
  targetIncarnation: string;
  componentId: string;
  action: "restart";
  requestDigest: string;
  resourceKey: string;
  ownerEpoch: number;
  businessOwnerEpoch: number;
  nodeAttemptId: string | null;
  beforeObservationId: string;
  predecessorId?: string;
  before: Readonly<{
    invocationId: string | null;
    state: "active" | "inactive" | "failed";
  }>;
}>;

/** Send the prepared native command once and settle the authenticated effect with its acknowledgement. */
export async function deliverStandRestartCommand(
  db: Db,
  command: IssuedCommand<RestartCommandPayload>,
): Promise<StandOperation> {
  const transport = defaultTransport();
  const { operationId, targetIncarnation, requestDigest, ownerEpoch } =
    command.envelope.payload;
  const dispatchOwner = { dispatchEpoch: ownerEpoch };
  let settled: StandOperation | undefined;

  try {
    await deliverCommand({
      db,
      command: command.row,
      envelope: command.envelope,
      send: async (envelope) => {
        const parsed = standTargetReceiptSchema.safeParse(
          await transport.dispatchStandRestart(envelope, {
            timeoutMs: COMMAND_POLICY["stand.dispatch"].timeoutMs,
          }),
        );

        if (
          !parsed.success ||
          parsed.data.operationId !== operationId ||
          parsed.data.targetIncarnation !== targetIncarnation ||
          parsed.data.requestDigest !== requestDigest
        )
          throw new MaisterError(
            "EXECUTOR_UNAVAILABLE",
            "The restart response requires reconciliation",
          );

        return parsed.data;
      },
      resultSummary: () => ({ operationId }),
      onAck: async (tx, receipt) => {
        settled =
          receipt.effectState === "not_dispatched" ||
          receipt.effectState === "dispatching"
            ? await retainStandUnknown(tx, operationId, dispatchOwner)
            : await adoptStandTargetReceipt(tx, operationId, receipt);
      },
      onReject: async (tx) => {
        await retainStandUnknown(tx, operationId, dispatchOwner);
      },
    });
  } catch (error) {
    if (
      isMaisterError(error) &&
      error.details?.reason === "delivery_budget_exhausted"
    )
      await retainStandUnknown(db, operationId, dispatchOwner);
    throw error;
  }
  if (!settled)
    throw new MaisterError("CRASH", "The restart command was not settled");

  return settled;
}
