import "server-only";

import type { Db } from "@/lib/execution-host/db";

import { and, eq } from "drizzle-orm";
import { z } from "zod";

import {
  authorizeStandReadOwner,
  claimStandReadAuthority,
} from "./read-authority";

import {
  standOperationObservations,
  standOperations,
  standTargets,
} from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import { defaultTransport } from "@/lib/execution-host/default-transport";
import { redactQueryError } from "@/lib/db/pg-error";

const observationSchema = z
  .object({
    operationId: z.uuid(),
    targetIncarnation: z.uuid(),
    requestDigest: z.string().regex(/^[a-f0-9]{64}$/),
    resourceKey: z.string().regex(/^[a-f0-9]{64}$/),
    sequence: z.number().int().positive(),
    invocationId: z
      .string()
      .regex(/^[a-f0-9]{32}$/)
      .nullable(),
    state: z.enum(["active", "inactive", "failed", "unknown"]),
    capturedAt: z.iso.datetime(),
  })
  .strict();

type Observation = typeof standOperationObservations.$inferSelect;

/** Record a live authenticated observation before admitting a restart command. */
export async function observeBeforeStandRestart(
  db: Db,
  principal: string | Readonly<{ tokenId: string }>,
  operationId: string,
  expectedRevision: number,
): Promise<Observation> {
  const { operation, ownerEpoch } = await claimStandReadAuthority(
    db,
    principal,
    operationId,
    "reconcile",
    expectedRevision,
  );

  if (
    operation.action !== "restart" ||
    operation.effectState !== "not_dispatched"
  )
    throw new MaisterError(
      "CONFLICT",
      "A pending restart is required for before-effect observation",
    );
  const raw = await defaultTransport().observeStandOperation({
    operationId,
    targetIncarnation: operation.targetIncarnation,
    requestDigest: operation.requestDigest,
    resourceKey: operation.resourceKey,
    componentId: operation.componentId,
    ownerEpoch,
  });
  const parsed = observationSchema.safeParse(raw);

  if (
    !parsed.success ||
    parsed.data.operationId !== operationId ||
    parsed.data.targetIncarnation !== operation.targetIncarnation ||
    parsed.data.requestDigest !== operation.requestDigest ||
    parsed.data.resourceKey !== operation.resourceKey
  )
    throw new MaisterError(
      "EXECUTOR_UNAVAILABLE",
      "The target before-effect observation does not match the restart",
    );
  const observed = parsed.data;

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
        stored.operation.effectState !== "not_dispatched" ||
        stored.operation.revision !== expectedRevision
      )
        throw new MaisterError(
          "CONFLICT",
          "The restart changed before retaining its observation",
        );
      await authorizeStandReadOwner(
        tx,
        stored.operation,
        stored.target.companyId,
        "reconcile",
        ownerEpoch,
        typeof principal === "string" ? undefined : principal.tokenId,
      );
      const [retained] = await tx
        .insert(standOperationObservations)
        .values({
          operationId,
          targetIncarnation: observed.targetIncarnation,
          resourceKey: observed.resourceKey,
          requestDigest: observed.requestDigest,
          targetSequence: observed.sequence,
          invocationId: observed.invocationId,
          observedState: observed.state,
          capturedAt: new Date(observed.capturedAt),
        })
        .returning();

      if (!retained)
        throw new MaisterError(
          "CRASH",
          "The before-effect observation was not retained",
        );

      return retained;
    });
  } catch (error) {
    throw redactQueryError(error);
  }
}
