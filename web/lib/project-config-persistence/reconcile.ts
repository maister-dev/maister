import "server-only";

import type { PersistenceDb } from "./store";

import { and, asc, gt, inArray, isNotNull } from "drizzle-orm";
import pino from "pino";

import { recoverAcceptedConfigurationPushes } from "./push";
import { cleanupConfigOperation, pruneConfigReviews } from "./cleanup";
import { confirmProjectConfiguration } from "./service";

import { MaisterError } from "@/lib/errors";
import { requireProjectActionForUser } from "@/lib/authz";
import { projectConfigPersistOperations as operations } from "@/lib/db/schema";

const log = pino({
  name: "project-config-persistence/recovery",
  level: process.env.LOG_LEVEL ?? "info",
});

export type ConfigRecoverySummary = {
  inspected: number;
  committed: number;
  retained: number;
};

/** One boot pass advances by immutable ID even when an earlier operation cannot recover. */
export async function recoverProjectConfigurations(
  db: PersistenceDb,
): Promise<ConfigRecoverySummary> {
  let cursor = "";
  const summary: ConfigRecoverySummary = {
    inspected: 0,
    committed: 0,
    retained: 0,
  };

  for (;;) {
    const batch = await db
      .select()
      .from(operations)
      .where(
        and(
          gt(operations.id, cursor),
          isNotNull(operations.acceptedAt),
          inArray(operations.state, [
            "preparing",
            "prepared",
            "publishing",
            "recovery_required",
          ]),
        ),
      )
      .orderBy(asc(operations.id))
      .limit(50);

    if (batch.length === 0) break;
    for (const operation of batch) {
      cursor = operation.id;
      summary.inspected += 1;
      try {
        const receipt = await confirmProjectConfiguration(
          db,
          operation,
          async () => {
            await requireProjectActionForUser(
              operation.actorUserId,
              operation.projectId,
              "editSettings",
            );
            await requireProjectActionForUser(
              operation.actorUserId,
              operation.projectId,
              "readRepoFiles",
            );
          },
        );

        await cleanupConfigOperation(db, receipt, async () => {
          await requireProjectActionForUser(
            operation.actorUserId,
            operation.projectId,
            "editSettings",
          );
          await requireProjectActionForUser(
            operation.actorUserId,
            operation.projectId,
            "readRepoFiles",
          );
        });
        if (receipt.state === "committed") summary.committed += 1;
        else summary.retained += 1;
      } catch (error) {
        summary.retained += 1;
        log.warn(
          {
            operationId: operation.id,
            projectId: operation.projectId,
            code: error instanceof MaisterError ? error.code : "UNKNOWN",
            reason:
              error instanceof MaisterError ? error.details?.reason : undefined,
          },
          "configuration recovery retained operation for explicit attention",
        );
      }
    }
  }
  await pruneConfigReviews(db);
  await recoverAcceptedConfigurationPushes(db);
  log.info(summary, "configuration startup recovery completed");

  return summary;
}
