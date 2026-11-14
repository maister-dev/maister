import "server-only";

import type { Db } from "@/lib/execution-host/db";

import { sql } from "drizzle-orm";
import pino from "pino";
import { z } from "zod";

import {
  getSpecialistAssignmentInTransaction,
  getSpecialistAssignmentInputInTransaction,
} from "@/lib/specialist-assignments/store";
import { authorizeCompanyUserAction } from "@/lib/company/authority";
import { installationCompany } from "@/lib/company/grants";
import { databaseTimestamp } from "@/lib/db/timestamp";
import { isMaisterError, MaisterError } from "@/lib/errors";
import { retainStandIncidentNotification } from "@/lib/notifications/stand-incidents";

const log = pino({
  name: "stand-incidents",
  level: process.env.LOG_LEVEL ?? "info",
});
const episode = z.object({
  id: z.string(),
  reason: z.enum(["verification_unhealthy", "verification_inconclusive"]),
  state: z.enum(["open", "resolved"]),
  occurrence_count: z.number().int().positive(),
  first_at: z
    .union([z.string(), z.date()])
    .transform(databaseTimestamp)
    .pipe(z.iso.datetime()),
  last_at: z
    .union([z.string(), z.date()])
    .transform(databaseTimestamp)
    .pipe(z.iso.datetime()),
  recovery_assignment_id: z.string().nullable(),
  recovery_input_revision: z.number().int().positive().nullable(),
});

/** Verification and incident updates share the same transaction and canonical resource exclusion. */
export async function applyStandVerificationIncident(
  tx: Db,
  operation: Readonly<{ id: string; resourceKey: string }>,
  probe: Readonly<{
    id: string;
    state: "healthy" | "unhealthy" | "inconclusive";
    observedAt: Date;
  }>,
): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`stand-incident:${operation.resourceKey}`},0))`,
  );

  if (probe.state === "healthy") {
    const { rows } = await tx.execute<{ id: string }>(sql`
      UPDATE stand_incident_episodes SET state='resolved',resolved_at=${probe.observedAt},
        recovery_verification_id=${probe.id}
      WHERE resource_key=${operation.resourceKey} AND state='open' AND last_at<=${probe.observedAt}
      RETURNING id
    `);

    for (const row of rows) {
      await retainStandIncidentNotification(
        tx,
        row.id,
        operation.id,
        "resolved",
      );
      log.info(
        {
          episodeId: row.id,
          resourceKey: operation.resourceKey,
          verificationId: probe.id,
        },
        "stand incident resolved",
      );
    }

    return;
  }
  const reason =
    probe.state === "unhealthy"
      ? "verification_unhealthy"
      : "verification_inconclusive";
  const {
    rows: [retained],
  } = await tx.execute<{ id: string; occurrence_count: number }>(sql`
    INSERT INTO stand_incident_episodes(resource_key,reason,first_operation_id,last_operation_id,first_at,last_at)
    VALUES(${operation.resourceKey},${reason},${operation.id},${operation.id},${probe.observedAt},${probe.observedAt})
    ON CONFLICT(resource_key,reason) WHERE state='open' DO UPDATE SET
      occurrence_count=stand_incident_episodes.occurrence_count+1,
      first_at=least(stand_incident_episodes.first_at,excluded.first_at),
      first_operation_id=CASE WHEN excluded.first_at<stand_incident_episodes.first_at
        THEN excluded.first_operation_id ELSE stand_incident_episodes.first_operation_id END,
      last_operation_id=CASE WHEN excluded.last_at>=stand_incident_episodes.last_at
        THEN excluded.last_operation_id ELSE stand_incident_episodes.last_operation_id END,
      last_at=greatest(stand_incident_episodes.last_at,excluded.last_at)
    RETURNING id,occurrence_count
  `);

  if (!retained)
    throw new MaisterError(
      "CRASH",
      "The stand incident observation was not retained",
    );
  if (retained.occurrence_count === 1)
    await retainStandIncidentNotification(
      tx,
      retained.id,
      operation.id,
      "opened",
    );

  log.info(
    {
      episodeId: retained.id,
      resourceKey: operation.resourceKey,
      verificationId: probe.id,
      reason,
      occurrences: retained.occurrence_count,
    },
    "stand incident observation retained",
  );
}

export async function readStandIncidentEpisodes(
  db: Db,
  userId: string,
  assignmentId: string,
) {
  try {
    return await db.transaction(async (tx) => {
      const companyId = await installationCompany(tx);

      await authorizeCompanyUserAction(tx, userId, companyId, "targets:read");
      await getSpecialistAssignmentInTransaction(tx, userId, assignmentId);
      const result = await tx.execute(sql`
        SELECT episode.id,episode.reason,episode.state,episode.occurrence_count,episode.first_at,episode.last_at,
          recovered.assignment_id AS recovery_assignment_id,recovered.input_revision AS recovery_input_revision
        FROM stand_incident_episodes episode
        LEFT JOIN stand_verifications probe ON probe.id=episode.recovery_verification_id
        LEFT JOIN stand_operations recovered ON recovered.id=probe.operation_id
        WHERE EXISTS (SELECT 1 FROM stand_operations related
          WHERE related.assignment_id=${assignmentId} AND related.resource_key=episode.resource_key)
        ORDER BY episode.last_at DESC,episode.id LIMIT 25
      `);
      const visible: {
        id: string;
        reason: z.infer<typeof episode>["reason"];
        state: "open" | "resolved";
        occurrenceCount: number;
        firstAt: string;
        lastAt: string;
      }[] = [];

      for (const item of result.rows.map((row) => episode.parse(row))) {
        try {
          const contributors = (
            await tx.execute(sql`
            SELECT DISTINCT operation.assignment_id,operation.input_revision
            FROM stand_incident_episodes retained
            JOIN stand_operations operation ON operation.resource_key=retained.resource_key
            JOIN stand_verifications probe ON probe.operation_id=operation.id
            WHERE retained.id=${item.id}
              AND probe.observed_at BETWEEN retained.first_at AND retained.last_at
              AND ('verification_'||probe.state)=retained.reason
            ORDER BY operation.assignment_id,operation.input_revision LIMIT 257
          `)
          ).rows;

          if (contributors.length > 256) continue;
          for (const contributor of contributors) {
            if (
              typeof contributor.assignment_id !== "string" ||
              typeof contributor.input_revision !== "number"
            )
              throw new MaisterError(
                "CRASH",
                "A retained stand incident has invalid contribution identity",
              );
            await getSpecialistAssignmentInputInTransaction(
              tx,
              userId,
              contributor.assignment_id,
              contributor.input_revision,
            );
          }
          if (item.recovery_assignment_id && item.recovery_input_revision)
            await getSpecialistAssignmentInputInTransaction(
              tx,
              userId,
              item.recovery_assignment_id,
              item.recovery_input_revision,
            );
        } catch (error) {
          if (
            isMaisterError(error) &&
            ["UNAUTHORIZED", "PRECONDITION"].includes(error.code)
          )
            continue;
          throw error;
        }
        visible.push({
          id: item.id,
          reason: item.reason,
          state: item.state,
          occurrenceCount: item.occurrence_count,
          firstAt: item.first_at,
          lastAt: item.last_at,
        });
      }

      return visible;
    });
  } catch (error) {
    if (
      isMaisterError(error) &&
      ["UNAUTHORIZED", "PRECONDITION"].includes(error.code)
    )
      return [];
    throw error;
  }
}
