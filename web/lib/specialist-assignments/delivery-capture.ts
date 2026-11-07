import "server-only";

import type { DomainEventRow } from "@/lib/db/schema";
import type { DomainEventConsumer } from "@/lib/domain-events/consumers";
import type { SqlDatabase } from "@/lib/db/sql-types";

import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import pino from "pino";

import { assignmentResultWitnessSchema } from "./delivery-types";
import { beginAssignmentTransaction } from "./store";

import { getDb } from "@/lib/db/client";
import { redactQueryError } from "@/lib/db/pg-error";
import { MaisterError } from "@/lib/errors";

const log = pino({
  name: "specialist-delivery-capture",
  level: process.env.LOG_LEVEL ?? "info",
});

/** Capture only the event's server-owned witness; current results cannot replace historical evidence. */
export async function captureSpecialistResultDelivery(
  db: SqlDatabase,
  event: DomainEventRow,
): Promise<void> {
  if (event.assignmentResult == null) return;
  const parsed = assignmentResultWitnessSchema.safeParse(
    event.assignmentResult,
  );

  if (!parsed.success || !Number.isSafeInteger(event.id) || event.id < 1)
    throw new MaisterError("CONFIG", "Native result event witness is invalid", {
      details: { reason: "assignment_delivery_witness_invalid" },
    });
  const snapshot = parsed.data;

  try {
    await db.transaction(async (tx) => {
      await beginAssignmentTransaction(tx);
      const id = randomUUID();
      const outboxId = randomUUID();
      const inserted = await tx.execute(sql`
        INSERT INTO specialist_delivery_receipts(id,assignment_id,input_revision,run_id,result_revision,signal,source_event_id,outbox_event_id,snapshot)
        VALUES(${id},${snapshot.assignmentId},${snapshot.inputRevision},${snapshot.runId},${snapshot.resultRevision},'result_available',${String(event.id)},${outboxId},${JSON.stringify(snapshot)}::jsonb)
        ON CONFLICT(assignment_id,run_id,result_revision,signal) DO NOTHING RETURNING id
      `);

      if (!inserted.rows.length) {
        const prior = (
          await tx.execute(sql`
          SELECT snapshot=${JSON.stringify(snapshot)}::jsonb AS matches FROM specialist_delivery_receipts
          WHERE assignment_id=${snapshot.assignmentId} AND run_id=${snapshot.runId} AND result_revision=${snapshot.resultRevision} AND signal='result_available'
        `)
        ).rows[0];

        if (prior?.matches !== true)
          throw new MaisterError(
            "CONFLICT",
            "Origin delivery identity has a different retained witness",
            { details: { reason: "assignment_delivery_identity_conflict" } },
          );

        return;
      }
      await tx.execute(sql`
        INSERT INTO webhook_events(id,type,data,occurred_at,payload)
        VALUES(${outboxId},'assignment.result_available',${JSON.stringify({ ownerUserId: snapshot.requesterUserId, assignmentDeliveryId: id })}::jsonb,${event.occurredAt},NULL)
      `);
      log.info(
        {
          assignmentId: snapshot.assignmentId,
          runId: snapshot.runId,
          inputRevision: snapshot.inputRevision,
          resultRevision: snapshot.resultRevision,
          deliveryId: id,
          outboxEventId: outboxId,
          destinationKind: snapshot.destination.kind,
        },
        "origin delivery intent retained",
      );
    });
  } catch (error) {
    throw redactQueryError(error);
  }
}

export const specialistAssignmentDeliveryConsumer: DomainEventConsumer = {
  id: "specialist_assignment_delivery",
  // Old rows have no server witness. Beginning also covers completion before first registration.
  startFrom: "beginning",
  async handle(events) {
    for (const event of events)
      await captureSpecialistResultDelivery(getDb(), event);
  },
};
