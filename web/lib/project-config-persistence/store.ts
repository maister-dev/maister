import "server-only";

import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { ConfigPersistSnapshot, ConfigPersistState } from "./types";

import { and, eq, isNull } from "drizzle-orm";
import pino from "pino";

import * as schema from "@/lib/db/schema";
import { isUniqueViolation } from "@/lib/db/pg-error";
import { MaisterError } from "@/lib/errors";
import { contentDigest } from "@/lib/evaluations/digest";

export type PersistenceDb = NodePgDatabase<typeof schema>;
export type ConfigOperation =
  typeof schema.projectConfigPersistOperations.$inferSelect;
export type ConfigOperationIdentity = {
  id: string;
  projectId: string;
  actorUserId: string;
};

const operations = schema.projectConfigPersistOperations;
const log = pino({
  name: "project-config-persistence/store",
  level: process.env.LOG_LEVEL ?? "info",
});

export async function insertConfigReview(
  db: PersistenceDb,
  identity: ConfigOperationIdentity,
  snapshot: ConfigPersistSnapshot,
): Promise<ConfigOperation> {
  if (
    snapshot.projectId !== identity.projectId ||
    snapshot.actorUserId !== identity.actorUserId
  ) {
    throw new MaisterError(
      "CONFIG",
      "Configuration review identity does not match its snapshot.",
    );
  }

  const [row] = await db
    .insert(operations)
    .values({
      ...identity,
      repositoryKey: snapshot.repository.commonDirectory,
      snapshot,
      snapshotDigest: contentDigest(snapshot),
      expiresAt: new Date(Date.now() + 10 * 60_000),
      usedDefaultAuthor: snapshot.repository.usedDefaultAuthor,
    })
    .returning();

  if (!row) {
    throw new MaisterError(
      "EXECUTOR_UNAVAILABLE",
      "Configuration review was not stored.",
    );
  }

  log.info(
    { operationId: row.id, projectId: row.projectId },
    "configuration review stored",
  );

  return row;
}

export async function findConfigOperation(
  db: PersistenceDb,
  identity: ConfigOperationIdentity,
): Promise<ConfigOperation | null> {
  const [row] = await db
    .select()
    .from(operations)
    .where(
      and(
        eq(operations.id, identity.id),
        eq(operations.projectId, identity.projectId),
        eq(operations.actorUserId, identity.actorUserId),
      ),
    );

  return row ?? null;
}

type OperationChange = Pick<
  typeof operations.$inferInsert,
  | "state"
  | "acceptedAt"
  | "ownerToken"
  | "ownerProcessId"
  | "preparedSha"
  | "committedSha"
  | "completedAt"
  | "errorReason"
  | "cleanupState"
  | "cleanupCheckedAt"
  | "cleanupReason"
> & { state: ConfigPersistState };

export async function transitionConfigOperation(
  db: PersistenceDb,
  identity: ConfigOperationIdentity,
  expected: { state: ConfigPersistState; ownerToken: string | null },
  change: OperationChange,
): Promise<ConfigOperation> {
  try {
    const [row] = await db
      .update(operations)
      .set({
        ...change,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(operations.id, identity.id),
          eq(operations.projectId, identity.projectId),
          eq(operations.actorUserId, identity.actorUserId),
          eq(operations.state, expected.state),
          expected.ownerToken === null
            ? isNull(operations.ownerToken)
            : eq(operations.ownerToken, expected.ownerToken),
        ),
      )
      .returning();

    if (!row) {
      throw new MaisterError(
        "CONFLICT",
        "Configuration operation changed; read its current receipt.",
        {
          details: { reason: "operation_busy", operationId: identity.id },
        },
      );
    }

    log.info(
      { operationId: row.id, fromState: expected.state, state: row.state },
      "configuration operation transitioned",
    );

    return row;
  } catch (error) {
    if (isUniqueViolation(error, "project_config_persist_active_repo_uq")) {
      log.warn(
        { operationId: identity.id },
        "configuration publication already active",
      );
      throw new MaisterError(
        "CONFLICT",
        "Another configuration publication requires completion or recovery.",
        {
          cause: error instanceof Error ? error : undefined,
          details: { reason: "operation_busy" },
        },
      );
    }

    throw error;
  }
}
