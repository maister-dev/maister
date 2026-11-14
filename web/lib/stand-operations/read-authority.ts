import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { StandPermitCheck } from "./operation-types";

import { and, eq, sql } from "drizzle-orm";

import {
  resolveStandCredential,
  resolveStandExecutionActor,
} from "./execution-actor";

import { authorizeCompanyUserAction } from "@/lib/company/authority";
import { installationCompany } from "@/lib/company/grants";
import { redactQueryError } from "@/lib/db/pg-error";
import {
  standOperations,
  standReadClaims,
  standTargets,
} from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import {
  beginAssignmentTransaction,
  getSpecialistAssignmentInputInTransaction,
} from "@/lib/specialist-assignments/store";

type StandReadPurpose = Exclude<StandPermitCheck["purpose"], "dispatch">;
type Operation = typeof standOperations.$inferSelect;

function actionForRead(
  purpose: StandReadPurpose,
  operation: Operation,
): "targets:read" | "targets:logs" | "targets:recover" {
  if (purpose === "logs") return "targets:logs";
  if (purpose === "verify" && operation.effectState !== "confirmed_applied")
    throw new MaisterError(
      "CONFLICT",
      "Verification requires a confirmed restart effect",
    );
  if (purpose === "reconcile" && operation.effectState !== "not_dispatched")
    return "targets:recover";

  return "targets:read";
}

/** Claim an independent read of this retained operation without renewing mutation ownership. */
export async function claimStandReadAuthority(
  db: Db,
  principal: string | Readonly<{ tokenId: string }>,
  operationId: string,
  purpose: StandReadPurpose,
  expectedRevision?: number,
  context?: Readonly<{ kind: "scheduler" }>,
): Promise<{ ownerEpoch: number; expiresAt: Date; operation: Operation }> {
  try {
    return await db.transaction(async (tx) => {
      await beginAssignmentTransaction(tx);
      const companyId = await installationCompany(tx);
      const execution =
        typeof principal === "string"
          ? null
          : await resolveStandCredential(tx, principal.tokenId);
      const tokenId = typeof principal === "string" ? null : principal.tokenId;

      if (typeof principal === "string")
        await authorizeCompanyUserAction(
          tx,
          principal,
          companyId,
          "targets:read",
        );
      const [stored] = await tx
        .select({ operation: standOperations })
        .from(standOperations)
        .innerJoin(
          standTargets,
          and(
            eq(standTargets.id, standOperations.targetId),
            eq(standTargets.companyId, companyId),
            eq(standTargets.enabled, true),
            eq(standTargets.configRevision, standOperations.configRevision),
          ),
        )
        .where(eq(standOperations.id, operationId))
        .for("no key update", { of: [standTargets, standOperations] });

      if (!stored)
        throw new MaisterError(
          "PRECONDITION",
          "The retained stand operation is unavailable",
        );
      const { operation } = stored;
      const actor = execution
        ? await resolveStandExecutionActor(
            tx,
            execution,
            operation.assignmentId,
            operation.inputRevision,
            purpose === "logs" ? "targets:logs" : "targets:read",
          )
        : null;
      const userId = typeof principal === "string" ? principal : actor?.userId;

      if (
        !userId ||
        (actor &&
          (actor.companyId !== companyId ||
            userId !== operation.initiatingUserId))
      )
        throw new MaisterError(
          "UNAUTHORIZED",
          "The current stand read principal is unavailable",
        );

      if (
        expectedRevision !== undefined &&
        expectedRevision !== operation.revision
      )
        throw new MaisterError(
          "CONFLICT",
          "The stand operation revision changed",
        );
      const action = actionForRead(purpose, operation);
      const authority = await authorizeCompanyUserAction(
        tx,
        userId,
        companyId,
        action,
      );

      await getSpecialistAssignmentInputInTransaction(
        tx,
        userId,
        operation.assignmentId,
        operation.inputRevision,
      );
      const [owner] = await tx
        .insert(standReadClaims)
        .values({
          operationId,
          purpose,
          actorId: userId,
          tokenId,
          ownerEpoch: 1,
          authority: authority.witness,
          expiresAt: sql`clock_timestamp()+interval '30 seconds'`,
        })
        .onConflictDoUpdate({
          target: [standReadClaims.operationId, standReadClaims.purpose],
          set: {
            actorId: userId,
            tokenId,
            ownerEpoch: sql`${standReadClaims.ownerEpoch}+1`,
            authority: authority.witness,
            expiresAt: sql`clock_timestamp()+interval '30 seconds'`,
          },
          setWhere:
            context?.kind === "scheduler"
              ? sql`${standReadClaims.expiresAt}<=clock_timestamp()`
              : sql`${standReadClaims.actorId}=${userId} OR ${standReadClaims.expiresAt}<=clock_timestamp()`,
        })
        .returning({
          ownerEpoch: standReadClaims.ownerEpoch,
          expiresAt: standReadClaims.expiresAt,
        });

      if (!owner)
        throw new MaisterError(
          "CONFLICT",
          "Another operator owns this stand read",
        );

      return { ...owner, operation };
    });
  } catch (error) {
    throw redactQueryError(error);
  }
}

/** Recheck the exact read owner, its original grant revision, and current source access. */
export async function authorizeStandReadOwner(
  tx: Db,
  operation: Operation,
  companyId: string,
  purpose: StandReadPurpose,
  ownerEpoch: number,
  expectedTokenId?: string,
): Promise<{ actorId: string }> {
  const [owner] = await tx
    .select()
    .from(standReadClaims)
    .where(
      and(
        eq(standReadClaims.operationId, operation.id),
        eq(standReadClaims.purpose, purpose),
        eq(standReadClaims.ownerEpoch, ownerEpoch),
        sql`${standReadClaims.expiresAt}>clock_timestamp()`,
      ),
    )
    .for("share");

  if (!owner)
    throw new MaisterError(
      "CONFLICT",
      "The current stand read owner is unavailable",
    );
  if (expectedTokenId !== undefined && owner.tokenId !== expectedTokenId)
    throw new MaisterError(
      "CONFLICT",
      "The current stand read credential changed",
    );
  if (owner.tokenId) {
    const actor = await resolveStandExecutionActor(
      tx,
      await resolveStandCredential(tx, owner.tokenId),
      operation.assignmentId,
      operation.inputRevision,
      purpose === "logs" ? "targets:logs" : "targets:read",
    );

    if (actor.companyId !== companyId || actor.userId !== owner.actorId)
      throw new MaisterError(
        "UNAUTHORIZED",
        "The retained stand reader is no longer current",
      );
  }
  const action = actionForRead(purpose, operation);
  const current = await authorizeCompanyUserAction(
    tx,
    owner.actorId,
    companyId,
    action,
  );

  if (action !== "targets:read")
    await authorizeCompanyUserAction(
      tx,
      owner.actorId,
      companyId,
      "targets:read",
    );
  if (
    current.witness.authorityId !== owner.authority.authorityId ||
    current.witness.revision !== owner.authority.revision
  )
    throw new MaisterError(
      "UNAUTHORIZED",
      "The retained stand read authority has been replaced",
    );

  await getSpecialistAssignmentInputInTransaction(
    tx,
    owner.actorId,
    operation.assignmentId,
    operation.inputRevision,
  );

  return { actorId: owner.actorId };
}
