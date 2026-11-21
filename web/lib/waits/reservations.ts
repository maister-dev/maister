import "server-only";

import type { NodeDef } from "@/lib/config.schema";
import type { Db } from "@/lib/execution-host/db";
import type { WaitDb } from "@/lib/waits/store";

import { createHash } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";

import { runPublications, runWaitDeliveries, runWaits } from "@/lib/db/schema";
import { maximumWaitSeconds } from "@/lib/waits/config";
import { waitOutcomes } from "@/lib/waits/manifest";

export function ciReservationId(publicationId: string, nodeId: string): string {
  return createHash("sha256")
    .update(`ci-reservation:${publicationId}:${nodeId}`)
    .digest("hex");
}

export async function reserveCiCallbacks(
  tx: Db,
  publication: typeof runPublications.$inferSelect,
  publishNodeId: string,
  nodes: readonly NodeDef[],
): Promise<void> {
  const cap = maximumWaitSeconds();
  const candidates = nodes.flatMap((node) => {
    if (
      node.type !== "wait" ||
      node.on.kind !== "ci" ||
      node.on.transport !== "push" ||
      node.on.publication !== publishNodeId
    )
      return [];
    const { kind, ...parameters } = node.on;

    return [
      {
        id: ciReservationId(publication.id, node.id),
        runId: publication.runId,
        projectId: publication.projectId,
        ownerKind: "flow" as const,
        state: "reserved" as const,
        occurrenceKey: `${publication.id}:${node.id}`,
        conditionKind: kind,
        condition: {
          schemaVersion: 1 as const,
          kind,
          outcomes: waitOutcomes(node.on),
          parameters: { ...parameters, timeoutSeconds: node.timeout },
        },
        flowRevision: publication.flowRevision,
        sourceTargetId: publication.id,
        publicationId: publication.id,
        bindingHeadSha: publication.sourceHead,
        reservedUntil: sql<Date>`clock_timestamp() + ${cap} * interval '1 second'`,
      },
    ];
  });

  if (candidates.length) await tx.insert(runWaits).values(candidates);
}

export async function closeExpiredCiCallbacks(db: WaitDb): Promise<number> {
  return db.transaction(async (tx) => {
    const { rows } = await tx.execute<{ id: string }>(sql`WITH expired AS (
      SELECT id FROM run_waits WHERE state='reserved' AND reserved_until<=statement_timestamp()
      ORDER BY reserved_until,id LIMIT 64 FOR UPDATE SKIP LOCKED
    ) UPDATE run_waits SET state='closed',closed_at=clock_timestamp(),version=version+1 FROM expired
      WHERE run_waits.id=expired.id RETURNING run_waits.id`);

    for (const { id } of rows)
      await tx
        .update(runWaitDeliveries)
        .set({ application: "not_applied" })
        .where(
          and(
            eq(runWaitDeliveries.waitId, id),
            eq(runWaitDeliveries.application, "pending"),
          ),
        );

    return rows.length;
  });
}
