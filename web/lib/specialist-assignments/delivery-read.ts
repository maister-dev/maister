import "server-only";

import type { SQL } from "drizzle-orm";
import type { SqlDatabase, SqlTransaction } from "@/lib/db/sql-types";
import type { AssignmentResultWitness } from "./delivery-types";
import type {
  AssignmentDeliverySelection,
  AssignmentDeliveryView,
  AssignmentDeliveryReplay,
} from "./delivery-read-types";

import { sql } from "drizzle-orm";
import pino from "pino";

import { authorizeAssignment } from "./access";
import { authorizePendingAssignmentDelivery } from "./delivery";
import { assignmentResultWitnessSchema } from "./delivery-types";
import {
  assignmentDeliveryViewSchema,
  assignmentDeliverySelectionSchema,
  assignmentDeliveryReplaySchema,
  assertAssignmentDeliveryIdentity,
} from "./delivery-read-types";
import {
  beginAssignmentTransaction,
  getSpecialistAssignmentInTransaction,
} from "./store";

import { authorizeSourceRestrictions } from "@/lib/brain/knowledge-restrictions";
import { databaseTimestamp } from "@/lib/db/timestamp";
import { redactQueryError } from "@/lib/db/pg-error";
import { MaisterError } from "@/lib/errors";
import { replayDelivery } from "@/lib/webhooks/replay";

const log = pino({
  name: "specialist-delivery-control",
  level: process.env.LOG_LEVEL ?? "info",
});

function unavailableDelivery(): MaisterError {
  return new MaisterError(
    "PRECONDITION",
    "Assignment delivery reference is unavailable",
    {
      details: { reason: "assignment_delivery_reference_unavailable" },
    },
  );
}

/** Hash database timestamps without lossy JavaScript conversion and retain the lifetime attempt ordinal. */
async function readDelivery(
  tx: SqlTransaction,
  assignmentId: string,
  selector: SQL,
): Promise<{
  snapshot: AssignmentResultWitness;
  view: AssignmentDeliveryView;
}> {
  const [row] = (
    await tx.execute(sql`
    SELECT receipt.id,receipt.snapshot,receipt.created_at,
      event.fanout_at,
      transport.id AS transport_id,transport.status,transport.attempt_count,
      COALESCE(attempt.last_attempt_no,0) AS last_attempt_no,
      transport.last_http_status,transport.last_error_kind,transport.next_attempt_at,
      transport.delivered_at,transport.updated_at,
      CASE WHEN transport.id IS NULL THEN NULL ELSE encode(sha256(convert_to(jsonb_build_object(
        'id',transport.id,'status',transport.status,'attemptCount',transport.attempt_count,
        'nextAttemptAt',extract(epoch FROM transport.next_attempt_at),'leaseExpiresAt',extract(epoch FROM transport.lease_expires_at),
        'deliveredAt',extract(epoch FROM transport.delivered_at),'updatedAt',extract(epoch FROM transport.updated_at),
        'lastHttpStatus',transport.last_http_status,'lastErrorKind',transport.last_error_kind,
        'lastAttemptNo',COALESCE(attempt.last_attempt_no,0))::text,'UTF8')),'hex') END AS state_sha256
    FROM specialist_delivery_receipts receipt
    LEFT JOIN webhook_events event ON event.id=receipt.outbox_event_id AND event.type='assignment.result_available'
    LEFT JOIN webhook_deliveries transport ON transport.specialist_delivery_id=receipt.id
    LEFT JOIN LATERAL (SELECT max(attempt_no) AS last_attempt_no FROM webhook_delivery_attempts WHERE delivery_id=transport.id) attempt ON true
    WHERE receipt.assignment_id=${assignmentId} AND ${selector}
    ORDER BY receipt.result_revision DESC,receipt.created_at DESC,receipt.id DESC LIMIT 1
  `)
  ).rows;

  if (!row) throw unavailableDelivery();
  const snapshot = assignmentResultWitnessSchema.parse(row.snapshot);
  const {
    owner: _owner,
    requesterUserId: _requester,
    sourceRestrictions: _sources,
    ...witness
  } = snapshot;
  const view = assignmentDeliveryViewSchema.parse({
    ...witness,
    deliveryId: row.id,
    signal: "result_available",
    createdAt: databaseTimestamp(row.created_at),
    transport: {
      id: row.transport_id ?? null,
      // Native Inbox fanout commits without a transport only for quiet results.
      state:
        row.status ??
        (snapshot.destination.kind === "inbox" && row.fanout_at != null
          ? "suppressed"
          : "awaiting_dispatch"),
      attemptCount: row.attempt_count ?? 0,
      lastAttemptNo: row.last_attempt_no,
      lastHttpStatus: row.last_http_status ?? null,
      lastErrorKind: row.last_error_kind ?? null,
      nextAttemptAt:
        row.status === "pending"
          ? databaseTimestamp(row.next_attempt_at)
          : null,
      deliveredAt:
        row.delivered_at === null || row.delivered_at === undefined
          ? null
          : databaseTimestamp(row.delivered_at),
      updatedAt:
        row.updated_at === null || row.updated_at === undefined
          ? null
          : databaseTimestamp(row.updated_at),
      stateSha256: row.state_sha256,
    },
  });

  return { snapshot, view };
}

async function authorizeDeliveryReader(
  tx: SqlTransaction,
  userId: string,
  assignmentId: string,
  snapshot: AssignmentResultWitness,
): Promise<void> {
  await getSpecialistAssignmentInTransaction(tx, userId, assignmentId);
  await authorizeSourceRestrictions(
    tx,
    { kind: "user", userId },
    snapshot.sourceRestrictions,
  );
}

/** History visibility depends on current reader authority, independently of transport eligibility. */
export async function getSpecialistAssignmentDelivery(
  db: SqlDatabase,
  userId: string,
  assignmentId: string,
  selection: AssignmentDeliverySelection,
): Promise<AssignmentDeliveryView> {
  assertAssignmentDeliveryIdentity(assignmentId);
  const parsed = assignmentDeliverySelectionSchema.safeParse(selection);

  if (!parsed.success)
    throw new MaisterError("CONFIG", "Invalid assignment delivery selection");
  try {
    return await db.transaction(async (tx) => {
      await beginAssignmentTransaction(tx);
      await getSpecialistAssignmentInTransaction(tx, userId, assignmentId);
      const receipt = await readDelivery(
        tx,
        assignmentId,
        sql`receipt.run_id=${parsed.data.runId} ${parsed.data.resultRevision === undefined ? sql`` : sql`AND receipt.result_revision=${parsed.data.resultRevision}`}`,
      );

      await authorizeSourceRestrictions(
        tx,
        { kind: "user", userId },
        receipt.snapshot.sourceRestrictions,
      );

      return receipt.view;
    });
  } catch (error) {
    throw redactQueryError(error);
  }
}

/** Queue only the inspected terminal cycle; the existing worker owns all subsequent effects. */
export async function replaySpecialistAssignmentDelivery(
  db: SqlDatabase,
  userId: string,
  assignmentId: string,
  deliveryId: string,
  input: AssignmentDeliveryReplay,
): Promise<AssignmentDeliveryView> {
  assertAssignmentDeliveryIdentity(assignmentId);
  assertAssignmentDeliveryIdentity(deliveryId);
  const request = assignmentDeliveryReplaySchema.safeParse(input);

  if (!request.success)
    throw new MaisterError(
      "CONFIG",
      "Replay requires schemaVersion and the exact expectedStateSha256 only",
    );
  try {
    const view = await db.transaction(async (tx) => {
      await beginAssignmentTransaction(tx);
      // Match the internal worker's transport-before-assignment lock order.
      await tx.execute(
        sql`SELECT transport.id FROM webhook_deliveries transport JOIN specialist_delivery_receipts receipt ON receipt.id=transport.specialist_delivery_id WHERE receipt.assignment_id=${assignmentId} AND receipt.id=${deliveryId} FOR UPDATE OF transport`,
      );
      const receipt = await readDelivery(
        tx,
        assignmentId,
        sql`receipt.id=${deliveryId}`,
      );

      await authorizeDeliveryReader(tx, userId, assignmentId, receipt.snapshot);
      await authorizeAssignment(
        tx,
        userId,
        receipt.snapshot.owner,
        "assignments:recover",
        { preset: "supervised" },
      );
      await authorizePendingAssignmentDelivery(tx, deliveryId);
      if (
        !receipt.view.transport.id ||
        !["delivered", "dead"].includes(receipt.view.transport.state) ||
        receipt.view.transport.stateSha256 !== request.data.expectedStateSha256
      )
        throw new MaisterError(
          "CONFLICT",
          "Delivery changed or is already queued; inspect its current state before replay",
          { details: { reason: "assignment_delivery_state_conflict" } },
        );
      await replayDelivery(receipt.view.transport.id, tx);

      return (
        await readDelivery(tx, assignmentId, sql`receipt.id=${deliveryId}`)
      ).view;
    });

    log.info(
      {
        actorId: userId,
        assignmentId,
        deliveryId,
        expectedStateSha256: request.data.expectedStateSha256,
        transportId: view.transport.id,
      },
      "native delivery replay queued",
    );

    return view;
  } catch (error) {
    throw redactQueryError(error);
  }
}
