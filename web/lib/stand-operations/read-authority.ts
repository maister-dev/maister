import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { StandPermitCheck } from "./operation-types";

import { and, eq, sql } from "drizzle-orm";

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
  userId: string,
  operationId: string,
  purpose: StandReadPurpose,
): Promise<{ ownerEpoch: number; expiresAt: Date }> {
  try {
    return await db.transaction(async (tx) => {
      await beginAssignmentTransaction(tx);
      const companyId = await installationCompany(tx);

      await authorizeCompanyUserAction(tx, userId, companyId, "targets:read");
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
          ownerEpoch: 1,
          authority: authority.witness,
          expiresAt: sql`clock_timestamp()+interval '30 seconds'`,
        })
        .onConflictDoUpdate({
          target: [standReadClaims.operationId, standReadClaims.purpose],
          set: {
            actorId: userId,
            ownerEpoch: sql`${standReadClaims.ownerEpoch}+1`,
            authority: authority.witness,
            expiresAt: sql`clock_timestamp()+interval '30 seconds'`,
          },
          setWhere: sql`${standReadClaims.actorId}=${userId} OR ${standReadClaims.expiresAt}<=clock_timestamp()`,
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

      return owner;
    });
  } catch (error) {
    throw redactQueryError(error);
  }
}

/** Recheck the exact read owner, its original grant revision, and current source access. */
export async function authorizeStandReadOwner(
  tx: Pick<Db, "select" | "execute">,
  operation: Operation,
  companyId: string,
  purpose: StandReadPurpose,
  ownerEpoch: number,
): Promise<void> {
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
}
