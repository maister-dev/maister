import "server-only";

import type { SQL } from "drizzle-orm";
import type { SpecialistAssignmentStatus } from "./types";

import { sql } from "drizzle-orm";

export function exactCollectedWorkResult(
  schemaRef: SQL,
  schemaVersion: SQL,
  sha256: SQL,
): SQL {
  return sql`child.status='Done' AND result.validity='valid'
    AND result.first_collected_at IS NOT NULL AND result.schema_ref=${schemaRef}
    AND result.schema_version::text=${schemaVersion} AND result.schema_sha256=${sha256}`;
}

export function isWorkDecisionState(
  status: SpecialistAssignmentStatus,
): boolean {
  return (
    status === "active" ||
    status === "waiting_children" ||
    status === "awaiting_acceptance"
  );
}
