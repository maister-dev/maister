import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { StandOperation } from "./operation-types";

import { randomUUID } from "node:crypto";

import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";

import { operationDto } from "./operation-intake";
import { applyStandVerificationIncident } from "./incidents";
import {
  authorizeStandReadOwner,
  claimStandReadAuthority,
} from "./read-authority";
import {
  readStandReceiptIds,
  readStandVerificationIds,
} from "./receipt-queries";

import { redactQueryError } from "@/lib/db/pg-error";
import {
  standOperationReceipts,
  standOperations,
  standTargets,
  standVerifications,
} from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import { defaultTransport } from "@/lib/execution-host/default-transport";

const targetVerification = z
  .object({
    id: z.uuid(),
    operationId: z.uuid(),
    targetIncarnation: z.uuid(),
    nonce: z.uuid(),
    state: z.enum(["healthy", "unhealthy", "inconclusive"]),
    issuedAt: z.iso.datetime(),
    observedAt: z.iso.datetime(),
    targetSequence: z.number().int().positive(),
    evidenceIds: z.array(z.string()).max(16),
    reason: z
      .enum(["verification_unhealthy", "verification_inconclusive"])
      .nullable(),
  })
  .strict();

/** A fresh probe checks read-only health or verifies the exact applied restart. */
export async function verifyStandHealth(
  db: Db,
  principal: string | Readonly<{ tokenId: string }>,
  operationId: string,
  expectedRevision: number,
): Promise<StandOperation> {
  const { operation, ownerEpoch } = await claimStandReadAuthority(
    db,
    principal,
    operationId,
    "verify",
    expectedRevision,
  );
  const inspection = operation.action === "inspect";
  const verificationNonce = randomUUID();
  const [clock] = (
    await db.execute(
      sql`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS issued_at`,
    )
  ).rows;

  if (typeof clock?.issued_at !== "string")
    throw new MaisterError(
      "CRASH",
      "The verification issue time was unavailable",
    );
  const issuedAt = clock.issued_at;
  const parsed = targetVerification.safeParse(
    await defaultTransport().verifyStandOperation({
      operationId,
      targetIncarnation: operation.targetIncarnation,
      componentId: operation.componentId,
      requestDigest: operation.requestDigest,
      ownerEpoch,
      ...(inspection ? { kind: "inspection" as const } : {}),
      verificationNonce,
      issuedAt,
    }),
  );

  if (
    !parsed.success ||
    parsed.data.operationId !== operationId ||
    parsed.data.targetIncarnation !== operation.targetIncarnation ||
    parsed.data.nonce !== verificationNonce ||
    parsed.data.issuedAt !== issuedAt ||
    parsed.data.reason !==
      (parsed.data.state === "healthy"
        ? null
        : `verification_${parsed.data.state}`)
  )
    throw new MaisterError(
      "CONFLICT",
      "The verification does not match its issued probe",
    );
  const observation = parsed.data;

  try {
    return await db.transaction(async (tx) => {
      const [stored] = await tx
        .select({ operation: standOperations, target: standTargets })
        .from(standOperations)
        .innerJoin(
          standTargets,
          and(
            eq(standTargets.id, standOperations.targetId),
            eq(standTargets.enabled, true),
            eq(standTargets.configRevision, standOperations.configRevision),
          ),
        )
        .where(eq(standOperations.id, operationId))
        .for("no key update", { of: [standTargets, standOperations] });

      if (
        !stored ||
        stored.operation.revision !== expectedRevision ||
        stored.operation.effectState !==
          (inspection ? "not_dispatched" : "confirmed_applied")
      )
        throw new MaisterError(
          "CONFLICT",
          "The operation changed before retaining verification",
        );
      const { actorId } = await authorizeStandReadOwner(
        tx,
        stored.operation,
        stored.target.companyId,
        "verify",
        ownerEpoch,
        typeof principal === "string" ? undefined : principal.tokenId,
      );
      const [effect] = inspection
        ? []
        : await tx
            .select()
            .from(standOperationReceipts)
            .where(eq(standOperationReceipts.operationId, operationId))
            .orderBy(desc(standOperationReceipts.targetSequence))
            .limit(1);
      const [previous] = await tx
        .select({ sequence: standVerifications.targetSequence })
        .from(standVerifications)
        .where(eq(standVerifications.operationId, operationId))
        .orderBy(desc(standVerifications.targetSequence))
        .limit(1);

      if (
        (!inspection && effect?.receipt.effectState !== "confirmed_applied") ||
        observation.targetSequence <=
          Math.max(effect?.targetSequence ?? 0, previous?.sequence ?? 0)
      )
        throw new MaisterError(
          "CONFLICT",
          "The target observation does not follow the applied effect and previous probes",
        );
      const [retained] = await tx
        .insert(standVerifications)
        .values({
          operationId,
          effectReceiptId: effect?.id ?? null,
          actorId,
          nonce: verificationNonce,
          ownerEpoch,
          targetProbeId: observation.id,
          targetSequence: observation.targetSequence,
          state: observation.state,
          issuedAt: new Date(issuedAt),
          observedAt: new Date(observation.observedAt),
        })
        .returning({
          id: standVerifications.id,
          state: standVerifications.state,
          observedAt: standVerifications.observedAt,
        });

      if (!retained)
        throw new MaisterError(
          "CRASH",
          "The independent health observation was not retained",
        );
      await applyStandVerificationIncident(tx, stored.operation, retained);
      const [updated] = await tx
        .update(standOperations)
        .set({
          verificationState: observation.state,
          revision: expectedRevision + 1,
        })
        .where(eq(standOperations.id, operationId))
        .returning();

      return operationDto(
        updated,
        null,
        await readStandReceiptIds(tx, operationId),
        await readStandVerificationIds(tx, operationId),
      );
    });
  } catch (error) {
    throw redactQueryError(error);
  }
}
