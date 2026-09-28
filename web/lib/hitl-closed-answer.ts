import "server-only";

import { sql, type SQL } from "drizzle-orm";

import { hitlRequests } from "@/lib/db/schema";

/** Why an answered permission request closed although its answer never reached
 * the agent. */
export type HitlClosedReason =
  // The live session held no such request (answered, cancelled, never raised).
  | "permission_not_pending"
  // Its session or run ended first; a recovered run asks again.
  | "session_ended"
  // The resumed agent asked for a different tool, input or choice.
  | "request_changed"
  // The resumed turn finished without asking again.
  | "not_requested"
  // The host refused the checkpointed original's delivery.
  | "delivery_rejected";

/**
 * `responded_at` says a request is no longer pending, not that its answer was
 * delivered. A permission row closed without delivery keeps the operator's
 * answer as evidence and marks it `_closed`, so an identical retry is refused
 * with the reason instead of being told "already delivered" — which would also
 * move a scratch dialog that has moved on. An unanswered row, and every other
 * kind, keeps its response as it is.
 */
export function closedAnswerResponse(reason: HitlClosedReason, at: Date): SQL {
  const closed = JSON.stringify({ reason, at: at.toISOString() });

  // `||` on a non-object left operand builds an ARRAY, which carries no marker.
  return sql`CASE WHEN ${hitlRequests.kind} = 'permission' AND jsonb_typeof(${hitlRequests.response}) = 'object'
    THEN ${hitlRequests.response} || jsonb_build_object('_closed', ${closed}::jsonb)
    ELSE ${hitlRequests.response} END`;
}

/** The same marker for a writer that already builds the response object. */
export function closedAnswerMarker(
  reason: HitlClosedReason,
  at: Date,
): { _closed: { reason: HitlClosedReason; at: string } } {
  return { _closed: { reason, at: at.toISOString() } };
}

export function closedAnswerReason(response: unknown): HitlClosedReason | null {
  if (response === null || typeof response !== "object") return null;
  const closed = (response as { _closed?: { reason?: unknown } })._closed;

  return typeof closed?.reason === "string"
    ? (closed.reason as HitlClosedReason)
    : null;
}
