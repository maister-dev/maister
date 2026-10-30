import "server-only";

import type { ConfigReceipt } from "./contracts";
import type { ConfigOperation, PersistenceDb } from "./store";

import { and, desc, eq, isNotNull, or, sql } from "drizzle-orm";

import { CONFIG_PERSIST_REASONS, CONFIG_CLEANUP_REASONS } from "./contracts";
import { cleanupConfigOperation } from "./cleanup";
import { findConfigOperation } from "./store";

import { MaisterError } from "@/lib/errors";
import {
  projectConfigPersistOperations,
  projectConfigPushIntents,
} from "@/lib/db/schema";

export async function configReceipt(
  db: PersistenceDb,
  operation: ConfigOperation,
): Promise<ConfigReceipt> {
  const [push] = await db
    .select({ state: projectConfigPushIntents.state })
    .from(projectConfigPushIntents)
    .where(
      and(
        eq(projectConfigPushIntents.operationId, operation.id),
        eq(projectConfigPushIntents.actorUserId, operation.actorUserId),
      ),
    )
    .orderBy(
      sql`CASE WHEN ${projectConfigPushIntents.state} IN ('pending','unknown') THEN 0 ELSE 1 END`,
      desc(projectConfigPushIntents.createdAt),
      desc(projectConfigPushIntents.id),
    )
    .limit(1);
  const reason = CONFIG_PERSIST_REASONS.find(
    (candidate) => candidate === operation.errorReason,
  );

  const cleanupReason = CONFIG_CLEANUP_REASONS.find(
    (candidate) => candidate === operation.cleanupReason,
  );

  return {
    cleanupState: operation.cleanupState,
    ...(cleanupReason ? { cleanupReason } : {}),
    operationId: operation.id,
    state: operation.state,
    baseSha: operation.snapshot.repository.head,
    commitSha: operation.committedSha,
    targetBranch: operation.snapshot.repository.branch,
    usedDefaultAuthor: operation.usedDefaultAuthor,
    pushState: push?.state ?? "not_requested",
    ...(reason ? { reason } : {}),
  };
}

export async function latestActorConfigOperation(
  db: PersistenceDb,
  projectId: string,
  actorUserId: string,
): Promise<string | undefined> {
  const [operation] = await db
    .select({ id: projectConfigPersistOperations.id })
    .from(projectConfigPersistOperations)
    .where(
      and(
        eq(projectConfigPersistOperations.projectId, projectId),
        eq(projectConfigPersistOperations.actorUserId, actorUserId),
        or(
          isNotNull(projectConfigPersistOperations.acceptedAt),
          eq(projectConfigPersistOperations.state, "noop"),
        ),
      ),
    )
    .orderBy(
      sql`CASE
        WHEN ${projectConfigPersistOperations.state} IN ('preparing','prepared','publishing','recovery_required') THEN 0
        WHEN EXISTS (
          SELECT 1 FROM ${projectConfigPushIntents}
          WHERE ${projectConfigPushIntents.operationId} = ${projectConfigPersistOperations.id}
            AND ${projectConfigPushIntents.actorUserId} = ${projectConfigPersistOperations.actorUserId}
            AND ${projectConfigPushIntents.state} IN ('pending','unknown')
        ) THEN 1 ELSE 2 END`,
      desc(projectConfigPersistOperations.updatedAt),
      desc(projectConfigPersistOperations.id),
    )
    .limit(1);

  return operation?.id;
}

/** Only explicit mutations retry cleanup; GET receipts remain observational. */
export async function settleConfigReceipt(
  db: PersistenceDb,
  operation: ConfigOperation,
  authorize: () => Promise<void>,
): Promise<ConfigReceipt> {
  await cleanupConfigOperation(db, operation, authorize);
  const current = await findConfigOperation(db, operation);

  if (!current)
    throw new MaisterError(
      "EXECUTOR_UNAVAILABLE",
      "The operation receipt could not be read. Recover using the same operation ID.",
    );

  return configReceipt(db, current);
}
