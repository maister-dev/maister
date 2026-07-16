import "server-only";

import { createHash, randomUUID } from "node:crypto";

import { and, asc, eq, gt, inArray, isNull, lte, or } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { getDb } from "@/lib/db/client";
import * as schema from "@/lib/db/schema";
import type {
  WorkspaceReconciliationCandidateKind,
  WorkspaceReconciliationFindingState,
} from "@/lib/db/schema";
import { promotionClaimTimeoutSeconds } from "@/lib/instance-config";
import { MaisterError } from "@/lib/errors";

const { workspaceReconciliationFindings } = schema;

export const MAX_RECONCILIATION_ATTEMPTS = 8;
const RETRY_BASE_DELAY_MS = 5 * 60_000;
const RETRY_MAX_DELAY_MS = 24 * 60 * 60_000;

export type ReconciliationObservation = {
  candidateKind: WorkspaceReconciliationCandidateKind;
  relativePath: string;
  provenanceVersion: number | null;
  provenanceFingerprint: string | null;
  provenanceRunId: string | null;
  projectId: string | null;
  runId: string | null;
  workspaceId: string | null;
};

export type ReconciliationFinding = ReconciliationObservation & {
  id: string;
  identityFingerprint: string;
  state: WorkspaceReconciliationFindingState;
  firstSeenAt: Date;
  lastSeenAt: Date;
  armedAt: Date | null;
  nextRetryAt: Date | null;
  attemptCount: number;
  retryGeneration: number;
  leaseExpiresAt: Date | null;
  attemptId: string | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  resultCode: string | null;
  rescueRef: string | null;
  rescueCommit: string | null;
  resolvedAt: Date | null;
};

export type ReconciliationFindingClaim = {
  id: string;
  attemptId: string;
  leaseExpiresAt: Date;
};

type Database = NodePgDatabase<typeof schema>;

function database(databaseOverride?: Database): Database {
  return databaseOverride ?? getDb();
}

function canonicalObservationPayload(
  observation: ReconciliationObservation,
): string {
  return JSON.stringify([
    observation.candidateKind,
    observation.relativePath,
    observation.provenanceVersion,
    observation.provenanceFingerprint,
    observation.provenanceRunId,
  ]);
}

export function reconciliationObservationFingerprint(
  observation: ReconciliationObservation,
): string {
  return createHash("sha256")
    .update(canonicalObservationPayload(observation))
    .digest("hex");
}

export function reconciliationFindingId(
  observation: ReconciliationObservation,
): string {
  return `wrf_${reconciliationObservationFingerprint(observation).slice(0, 40)}`;
}

export function reconciliationRetryDelayMs(attemptCount: number): number {
  const exponent = Math.max(0, attemptCount - 1);

  return Math.min(RETRY_BASE_DELAY_MS * 2 ** exponent, RETRY_MAX_DELAY_MS);
}

export function nextReconciliationRetryAt(args: {
  now: Date;
  attemptCount: number;
}): Date {
  return new Date(
    args.now.getTime() + reconciliationRetryDelayMs(args.attemptCount),
  );
}

export async function observeReconciliationFinding(args: {
  database?: Database;
  observation: ReconciliationObservation;
  now?: Date;
}): Promise<string> {
  const client = database(args.database);
  const now = args.now ?? new Date();
  const identityFingerprint = reconciliationObservationFingerprint(
    args.observation,
  );
  const id = reconciliationFindingId(args.observation);

  await client
    .insert(workspaceReconciliationFindings)
    .values({
      id,
      identityFingerprint,
      ...args.observation,
      state: "observed",
      firstSeenAt: now,
      lastSeenAt: now,
      armedAt: now,
    })
    .onConflictDoUpdate({
      target: workspaceReconciliationFindings.identityFingerprint,
      set: {
        lastSeenAt: now,
        projectId: args.observation.projectId,
        runId: args.observation.runId,
        workspaceId: args.observation.workspaceId,
      },
    });

  return id;
}

export async function loadDueReconciliationFindings(args: {
  database?: Database;
  now?: Date;
  limit?: number;
}): Promise<ReconciliationFinding[]> {
  const client = database(args.database);
  const now = args.now ?? new Date();
  const limit = args.limit ?? 100;

  return client
    .select()
    .from(workspaceReconciliationFindings)
    .where(
      and(
        inArray(workspaceReconciliationFindings.state, [
          "observed",
          "held",
          "retry_waiting",
        ]),
        or(
          isNull(workspaceReconciliationFindings.nextRetryAt),
          lte(workspaceReconciliationFindings.nextRetryAt, now),
        ),
        or(
          isNull(workspaceReconciliationFindings.leaseExpiresAt),
          lte(workspaceReconciliationFindings.leaseExpiresAt, now),
        ),
      ),
    )
    .orderBy(
      asc(workspaceReconciliationFindings.nextRetryAt),
      asc(workspaceReconciliationFindings.firstSeenAt),
      asc(workspaceReconciliationFindings.id),
    )
    .limit(limit);
}

export async function claimReconciliationFinding(args: {
  database?: Database;
  findingId: string;
  now?: Date;
}): Promise<ReconciliationFindingClaim | null> {
  const client = database(args.database);
  const now = args.now ?? new Date();

  return client.transaction(async (transaction) => {
    const rows = await transaction
      .select({
        id: workspaceReconciliationFindings.id,
        state: workspaceReconciliationFindings.state,
        nextRetryAt: workspaceReconciliationFindings.nextRetryAt,
        leaseExpiresAt: workspaceReconciliationFindings.leaseExpiresAt,
      })
      .from(workspaceReconciliationFindings)
      .where(eq(workspaceReconciliationFindings.id, args.findingId))
      .for("update");
    const finding = rows[0];

    if (
      !finding ||
      finding.state === "quarantined" ||
      finding.state === "resolved" ||
      (finding.nextRetryAt !== null && finding.nextRetryAt > now) ||
      (finding.leaseExpiresAt !== null && finding.leaseExpiresAt > now)
    ) {
      return null;
    }

    const attemptId = randomUUID();
    const leaseExpiresAt = new Date(
      now.getTime() + promotionClaimTimeoutSeconds() * 1000,
    );

    await transaction
      .update(workspaceReconciliationFindings)
      .set({ attemptId, leaseExpiresAt })
      .where(eq(workspaceReconciliationFindings.id, args.findingId));

    return { id: args.findingId, attemptId, leaseExpiresAt };
  });
}

export async function renewReconciliationFindingClaim(args: {
  database?: Database;
  claim: ReconciliationFindingClaim;
  now?: Date;
}): Promise<ReconciliationFindingClaim> {
  const client = database(args.database);
  const now = args.now ?? new Date();
  const leaseExpiresAt = new Date(
    now.getTime() + promotionClaimTimeoutSeconds() * 1000,
  );
  const rows = await client
    .update(workspaceReconciliationFindings)
    .set({ leaseExpiresAt })
    .where(
      and(
        eq(workspaceReconciliationFindings.id, args.claim.id),
        eq(workspaceReconciliationFindings.attemptId, args.claim.attemptId),
        gt(workspaceReconciliationFindings.leaseExpiresAt, now),
      ),
    )
    .returning({ id: workspaceReconciliationFindings.id });

  if (rows.length === 0) {
    throw new MaisterError("CONFLICT", "reconciliation finding lease was lost");
  }

  return { ...args.claim, leaseExpiresAt };
}

export async function resolveReconciliationFinding(args: {
  database?: Database;
  claim: ReconciliationFindingClaim;
  now?: Date;
  resultCode: string;
  rescue?: { ref: string; commit: string };
}): Promise<void> {
  const client = database(args.database);
  const now = args.now ?? new Date();
  const rows = await client
    .update(workspaceReconciliationFindings)
    .set({
      state: "resolved",
      resultCode: args.resultCode,
      rescueRef: args.rescue?.ref ?? null,
      rescueCommit: args.rescue?.commit ?? null,
      resolvedAt: now,
      nextRetryAt: null,
      leaseExpiresAt: null,
      attemptId: null,
      lastErrorCode: null,
      lastErrorMessage: null,
    })
    .where(
      and(
        eq(workspaceReconciliationFindings.id, args.claim.id),
        eq(workspaceReconciliationFindings.attemptId, args.claim.attemptId),
        gt(workspaceReconciliationFindings.leaseExpiresAt, now),
      ),
    )
    .returning({ id: workspaceReconciliationFindings.id });

  if (rows.length === 0) {
    throw new MaisterError(
      "CONFLICT",
      "reconciliation finding claim was lost before resolution",
    );
  }
}

export async function quarantineReconciliationFinding(args: {
  database?: Database;
  claim: ReconciliationFindingClaim;
  errorCode: string;
  errorMessage: string;
  now?: Date;
}): Promise<void> {
  const client = database(args.database);
  const now = args.now ?? new Date();
  const rows = await client
    .update(workspaceReconciliationFindings)
    .set({
      state: "quarantined",
      lastErrorCode: args.errorCode,
      lastErrorMessage: args.errorMessage,
      nextRetryAt: null,
      leaseExpiresAt: null,
      attemptId: null,
    })
    .where(
      and(
        eq(workspaceReconciliationFindings.id, args.claim.id),
        eq(workspaceReconciliationFindings.attemptId, args.claim.attemptId),
        gt(workspaceReconciliationFindings.leaseExpiresAt, now),
      ),
    )
    .returning({ id: workspaceReconciliationFindings.id });

  if (rows.length === 0) {
    throw new MaisterError(
      "CONFLICT",
      "reconciliation finding claim was lost before quarantine",
    );
  }
}

export async function holdReconciliationFinding(args: {
  database?: Database;
  claim: ReconciliationFindingClaim;
  resultCode: string;
  now?: Date;
  retryAt?: Date;
}): Promise<void> {
  const client = database(args.database);
  const now = args.now ?? new Date();
  const rows = await client
    .update(workspaceReconciliationFindings)
    .set({
      state: "held",
      resultCode: args.resultCode,
      nextRetryAt:
        args.retryAt ?? new Date(now.getTime() + RETRY_MAX_DELAY_MS),
      leaseExpiresAt: null,
      attemptId: null,
    })
    .where(
      and(
        eq(workspaceReconciliationFindings.id, args.claim.id),
        eq(workspaceReconciliationFindings.attemptId, args.claim.attemptId),
        gt(workspaceReconciliationFindings.leaseExpiresAt, now),
      ),
    )
    .returning({ id: workspaceReconciliationFindings.id });

  if (rows.length === 0) {
    throw new MaisterError(
      "CONFLICT",
      "reconciliation finding claim was lost before hold",
    );
  }
}

export async function retryReconciliationFinding(args: {
  database?: Database;
  claim: ReconciliationFindingClaim;
  errorCode: string;
  errorMessage: string;
  now?: Date;
}): Promise<WorkspaceReconciliationFindingState> {
  const client = database(args.database);
  const now = args.now ?? new Date();
  const rows = await client
    .select({ attemptCount: workspaceReconciliationFindings.attemptCount })
    .from(workspaceReconciliationFindings)
    .where(
      and(
        eq(workspaceReconciliationFindings.id, args.claim.id),
        eq(workspaceReconciliationFindings.attemptId, args.claim.attemptId),
        gt(workspaceReconciliationFindings.leaseExpiresAt, now),
      ),
    );
  const finding = rows[0];

  if (!finding) {
    throw new MaisterError(
      "CONFLICT",
      "reconciliation finding claim was lost before retry",
    );
  }

  const attemptCount = finding.attemptCount + 1;
  const state: WorkspaceReconciliationFindingState =
    attemptCount >= MAX_RECONCILIATION_ATTEMPTS ? "failed" : "retry_waiting";
  const nextRetryAt =
    state === "failed"
      ? null
      : nextReconciliationRetryAt({ now, attemptCount });

  await client
    .update(workspaceReconciliationFindings)
    .set({
      state,
      attemptCount,
      nextRetryAt,
      leaseExpiresAt: null,
      attemptId: null,
      lastErrorCode: args.errorCode,
      lastErrorMessage: args.errorMessage,
    })
    .where(
      and(
        eq(workspaceReconciliationFindings.id, args.claim.id),
        eq(workspaceReconciliationFindings.attemptId, args.claim.attemptId),
      ),
    );

  return state;
}
