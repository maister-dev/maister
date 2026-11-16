import "server-only";

import type { Db } from "@/lib/execution-host/db";

import { and, eq } from "drizzle-orm";
import { z } from "zod";

import {
  authorizeStandReadOwner,
  claimStandReadAuthority,
} from "./read-authority";

import { standOperations, standTargets } from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import { defaultTransport } from "@/lib/execution-host/default-transport";

const logsSchema = z
  .object({
    operationId: z.uuid(),
    targetIncarnation: z.uuid(),
    text: z.string().max(262_144),
    truncated: z.boolean(),
    sanitized: z.literal(true),
    capturedAt: z.iso.datetime(),
  })
  .strict();

type StandLogs = z.infer<typeof logsSchema>;

/** A live log excerpt is disclosed only while the exact log reader still owns the read. */
export async function readSpecialistStandLogs(
  db: Db,
  tokenId: string,
  operationId: string,
): Promise<StandLogs> {
  const { operation, ownerEpoch } = await claimStandReadAuthority(
    db,
    { tokenId },
    operationId,
    "logs",
  );
  const result = logsSchema.safeParse(
    await defaultTransport().readStandLogs({
      operationId,
      targetIncarnation: operation.targetIncarnation,
      componentId: operation.componentId,
      requestDigest: operation.requestDigest,
      ownerEpoch,
    }),
  );

  if (
    !result.success ||
    result.data.operationId !== operationId ||
    result.data.targetIncarnation !== operation.targetIncarnation ||
    Buffer.byteLength(result.data.text) > 262_144
  )
    throw new MaisterError(
      "EXECUTOR_UNAVAILABLE",
      "The sanitized stand log excerpt is unavailable",
    );

  await db.transaction(async (tx) => {
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
      .for("share", { of: [standTargets, standOperations] });

    if (!stored)
      throw new MaisterError(
        "CONFLICT",
        "The stand target configuration changed during the log read",
      );
    await authorizeStandReadOwner(
      tx,
      stored.operation,
      stored.target.companyId,
      "logs",
      ownerEpoch,
      tokenId,
    );
  });

  return result.data;
}
