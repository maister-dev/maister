import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { StandPermitCheck } from "./operation-types";

import { and, eq, sql } from "drizzle-orm";
import pino from "pino";

import { authenticateStandOperationPeer } from "./authority-peer";
import { standPermitCheckSchema } from "./operation-types";
import { authorizeStandRestartProfessional } from "./restart-dispatch";
import { readStandRunbookDigest } from "./target-registry";

import { authorizeCompanyUserAction } from "@/lib/company/authority";
import {
  executionCommands,
  standAuthorizationPermits,
  standComponents,
  standOperationObservations,
  standOperations,
  standResourceClaims,
  standRestartApprovals,
} from "@/lib/db/schema";
import {
  isUniqueViolation,
  pgErrorOf,
  redactQueryError,
} from "@/lib/db/pg-error";
import { MaisterError } from "@/lib/errors";
import { getSpecialistAssignmentInputInTransaction } from "@/lib/specialist-assignments/store";

const log = pino({ name: "stand-authority-permit" });

type PermitRequest = Readonly<{
  operationId: string;
  peerFingerprint: string;
  helperToken: string;
  body: unknown;
}>;
type StandPermit = StandPermitCheck &
  Readonly<{
    permitId: string;
    operationId: string;
    expiresAt: string;
    allowed: true;
  }>;

/** Authenticate the exact TLS peer and authorize from retained state in one transaction. */
export async function authorizeStandCallback(
  db: Db,
  request: PermitRequest,
): Promise<StandPermit> {
  const parsed = standPermitCheckSchema.safeParse(request.body);

  if (!parsed.success)
    throw new MaisterError(
      "CONFIG",
      "Provide the exact operation authority witness",
    );
  const input = parsed.data;

  try {
    const permit = await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL statement_timeout='2500ms'`);
      await tx.execute(sql`SET LOCAL lock_timeout='1000ms'`);
      const target = await authenticateStandOperationPeer(
        tx,
        request.operationId,
        request.peerFingerprint,
        request.helperToken,
      );
      const [operation] = await tx
        .select()
        .from(standOperations)
        .where(eq(standOperations.id, request.operationId))
        .for("no key update");

      if (
        !operation ||
        operation.targetIncarnation !== input.targetIncarnation ||
        operation.requestDigest !== input.requestDigest ||
        operation.resourceKey !== input.resourceKey
      )
        throw new MaisterError(
          "CONFLICT",
          "Stand authorization does not match its retained intent",
          {
            details: { reason: "target_identity_mismatch" },
          },
        );
      if (input.purpose !== "dispatch")
        throw new MaisterError(
          "PRECONDITION",
          "The operation has no configured observation owner",
        );
      const [claim] = await tx
        .select()
        .from(standResourceClaims)
        .where(
          and(
            eq(standResourceClaims.resourceKey, operation.resourceKey),
            eq(standResourceClaims.operationId, operation.id),
          ),
        )
        .for("share");
      const [approval] = await tx
        .select()
        .from(standRestartApprovals)
        .where(eq(standRestartApprovals.operationId, operation.id));

      if (
        operation.effectState !== "dispatching" ||
        !claim?.unresolved ||
        claim.ownerEpoch !== input.ownerEpoch ||
        !approval
      )
        throw new MaisterError(
          "CONFLICT",
          "Current authorized stand dispatch ownership is required",
          {
            details: { reason: "assignment_fenced" },
          },
        );
      const [command] = await tx
        .select()
        .from(executionCommands)
        .where(
          and(
            eq(executionCommands.id, claim.ownerId),
            eq(executionCommands.kind, "stand.dispatch"),
          ),
        )
        .for("share");
      const nodeAttemptId = command?.payload.nodeAttemptId;
      const observationId = command?.payload.beforeObservationId;

      if (
        !command ||
        typeof observationId !== "string" ||
        (nodeAttemptId !== null && typeof nodeAttemptId !== "string")
      )
        throw new MaisterError(
          "CONFLICT",
          "The exact stand dispatch command owner is unavailable",
        );
      const [observation] = await tx
        .select({ id: standOperationObservations.id })
        .from(standOperationObservations)
        .where(
          and(
            eq(standOperationObservations.id, observationId),
            eq(standOperationObservations.operationId, operation.id),
          ),
        );

      if (!observation)
        throw new MaisterError(
          "CONFLICT",
          "The command has no exact before-effect stand observation",
        );
      await authorizeStandRestartProfessional(
        tx,
        command.runId,
        nodeAttemptId,
        target.companyId,
        operation.initiatingUserId,
      );
      const [component] = await tx
        .select()
        .from(standComponents)
        .where(
          and(
            eq(standComponents.targetId, target.targetId),
            eq(standComponents.configRevision, target.configRevision),
            eq(standComponents.componentId, operation.componentId),
          ),
        );

      if (!component || !component.config.actions.includes("restart"))
        throw new MaisterError(
          "PRECONDITION",
          "Current restart policy and runbook evidence are required",
        );
      for (const userId of new Set([
        operation.initiatingUserId,
        approval.approvedBy,
      ])) {
        await authorizeCompanyUserAction(
          tx,
          userId,
          target.companyId,
          "targets:restart",
        );
        await authorizeCompanyUserAction(
          tx,
          userId,
          target.companyId,
          "targets:read",
        );
        await getSpecialistAssignmentInputInTransaction(
          tx,
          userId,
          operation.assignmentId,
          operation.inputRevision,
        );
        if (
          (await readStandRunbookDigest(
            tx,
            userId,
            target.companyId,
            component.config.runbook,
          )) !== component.runbookSha256
        )
          throw new MaisterError(
            "PRECONDITION",
            "Current restart policy and runbook evidence are required",
          );
      }
      const [issued] = await tx
        .insert(standAuthorizationPermits)
        .values({
          operationId: operation.id,
          nonce: input.nonce,
          purpose: input.purpose,
          ownerEpoch: input.ownerEpoch,
          issuedAt: sql`statement_timestamp()`,
          expiresAt: sql`statement_timestamp()+interval '5 seconds'`,
        })
        .returning();

      if (!issued)
        throw new MaisterError("CRASH", "The stand permit was not retained");

      return {
        ...input,
        operationId: operation.id,
        permitId: issued.id,
        expiresAt: issued.expiresAt.toISOString(),
        allowed: true as const,
      };
    });

    log.info(
      {
        operationId: permit.operationId,
        ownerEpoch: permit.ownerEpoch,
        purpose: permit.purpose,
        permitId: permit.permitId,
      },
      "stand authorization retained",
    );

    return permit;
  } catch (error) {
    if (isUniqueViolation(error))
      throw new MaisterError(
        "CONFLICT",
        "The stand authorization has already been issued",
      );
    if (pgErrorOf(error)?.code === "23514")
      throw new MaisterError(
        "CONFLICT",
        "The stand authorization lost its current execution or approval fence",
        {
          details: { reason: "assignment_fenced" },
        },
      );
    throw redactQueryError(error);
  }
}
