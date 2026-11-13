import "server-only";

import type { Db } from "@/lib/execution-host/db";

import { createHash, timingSafeEqual } from "node:crypto";

import { and, eq } from "drizzle-orm";

import { standTargetConnectionSchema } from "./target-types";

import {
  standOperations,
  standTargetRevisions,
  standTargets,
} from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";

type StandPeerTarget = Readonly<{
  targetId: string;
  companyId: string;
  configRevision: number;
  incarnationId: string;
}>;

function invalidPeer(): MaisterError {
  return new MaisterError(
    "UNAUTHENTICATED",
    "Current target helper authentication is required",
  );
}

/** The caller supplies the fingerprint derived from the authenticated TLS socket. */
export async function authenticateStandOperationPeer(
  tx: Pick<Db, "select">,
  operationId: string,
  peerFingerprint: string,
  helperToken: string,
): Promise<StandPeerTarget> {
  const [row] = await tx
    .select({
      targetId: standTargets.id,
      companyId: standTargets.companyId,
      configRevision: standTargets.configRevision,
      incarnationId: standTargets.incarnationId,
      connection: standTargetRevisions.connection,
    })
    .from(standOperations)
    .innerJoin(
      standTargets,
      and(
        eq(standTargets.id, standOperations.targetId),
        eq(standTargets.configRevision, standOperations.configRevision),
        eq(standTargets.incarnationId, standOperations.targetIncarnation),
        eq(standTargets.enabled, true),
      ),
    )
    .innerJoin(
      standTargetRevisions,
      and(
        eq(standTargetRevisions.targetId, standTargets.id),
        eq(standTargetRevisions.revision, standTargets.configRevision),
      ),
    )
    .where(eq(standOperations.id, operationId))
    .for("share", { of: standTargets });

  if (!row) throw invalidPeer();
  const { connection, ...target } = row;
  const parsed = standTargetConnectionSchema.safeParse(connection);
  const fingerprint = peerFingerprint.replaceAll(":", "").toLowerCase();

  if (
    !parsed.success ||
    !parsed.data.helperCertificateSha256 ||
    parsed.data.helperCertificateSha256 !== fingerprint
  )
    throw invalidPeer();
  const expected = process.env[parsed.data.helperCredentialEnv.slice(4)];

  if (!expected || !/^[A-Za-z0-9_-]{32,1024}$/.test(expected))
    throw new MaisterError(
      "EXECUTOR_UNAVAILABLE",
      "Target helper credential is unavailable",
      { details: { reason: "authority_unavailable" } },
    );
  if (
    !/^[A-Za-z0-9_-]{32,1024}$/.test(helperToken) ||
    !timingSafeEqual(
      createHash("sha256").update(expected).digest(),
      createHash("sha256").update(helperToken).digest(),
    )
  )
    throw invalidPeer();

  return target;
}
