import "server-only";

import type { Db } from "./db";

import { and, count, eq, sql } from "drizzle-orm";
import pino from "pino";

import { executionAssignments, executionHostPressure, executionHostSlotReservations, executionHosts } from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";

import { HOST_PRESSURED_REASON } from "./host-pressure";
import { configuredAdditionalExecutionEndpoints, configuredExecutionEndpointForHost, configuredSelectedExecutionEndpoint } from "./selected-endpoint";

const log = pino({ name: "execution-host-capacity" });

export type HostCapacityWaitReason =
  | "launch_execution_host_capacity"
  | "launch_execution_host_draining"
  | "launch_execution_host_unavailable"
  | typeof HOST_PRESSURED_REASON;

export function usesHostCapacityReservations(): boolean {
  const primary = configuredSelectedExecutionEndpoint();
  return !!primary && (primary.maxConcurrentRuns !== undefined ||
    primary.draining === true || configuredAdditionalExecutionEndpoints().length !== 0);
}

// A manager transition alone cannot prove that an accepted child has stopped.
function retainedExecutionRisk(assignmentId: typeof executionAssignments.id) {
  return sql`(
    EXISTS (SELECT 1 FROM execution_commands c
      WHERE c.execution_assignment_id = ${assignmentId} AND c.attempts > 0
      AND c.kind IN ('workspace.prepare','workspace.materialize','workspace.run','session.create','session.prompt')
      AND NOT (c.kind='workspace.run' AND (
        (c.state='succeeded' AND coalesce(c.result->>'quiescence' = 'proved' AND c.result ? 'eventId', false)) OR
        (c.state='failed' AND coalesce(c.last_error ? 'eventId', false))
      ))
      AND (c.state IN ('queued','delivering','accepted','fenced')
        OR c.transport_state IN ('unknown','reconciliation_required')
        OR c.kind='workspace.run'
      )
    ) OR EXISTS (
      SELECT 1 FROM run_session_incarnations i
      WHERE i.execution_assignment_id = ${assignmentId}
        AND (i.state IN ('created','active') OR (i.state IN ('checkpointed','lost') AND NOT EXISTS (
          SELECT 1 FROM execution_events e WHERE e.execution_assignment_id=i.execution_assignment_id
            AND e.execution_host_id=i.execution_host_id AND e.host_session_id=i.host_session_id
            AND e.source='host' AND e.event_type IN ('session.exited','session.crashed')
        )))
    )
  )`;
}

/** Hold the original slot until its retained execution evidence is settled. */
export async function assertCapacityOwnerQuiescent(tx: Pick<Db, "select">, runId: string): Promise<void> {
  if (!usesHostCapacityReservations()) return;
  const [unsettled] = await tx.select({ id: executionAssignments.id })
    .from(executionAssignments)
    .innerJoin(executionHostSlotReservations, eq(executionHostSlotReservations.assignmentId, executionAssignments.id))
    .where(and(eq(executionAssignments.runId, runId), retainedExecutionRisk(executionAssignments.id)))
    .limit(1);
  if (unsettled)
    throw new MaisterError("EXECUTOR_UNAVAILABLE", "The original supervisor has not proved retirement", {
      details: { reason: "execution_host_quiescence_pending", assignmentId: unsettled.id },
    });
}

export async function readHostCapacityWaitReason(
  tx: Db,
  hostId: string,
  assignmentId?: string,
): Promise<HostCapacityWaitReason | null> {
  if (!usesHostCapacityReservations()) return null;
  const [host] = await tx.select().from(executionHosts)
    .where(eq(executionHosts.id, hostId)).for("no key update");
  if (!host || host.retiredAt) return "launch_execution_host_unavailable";
  if (!Array.isArray(host.capabilities.workspaceProtocol)) return null;
  const settings = configuredExecutionEndpointForHost(host.hostKey);
  if (!settings || host.readiness !== "ready") return "launch_execution_host_unavailable";
  const [owned] = assignmentId ? await tx.select({ id: executionHostSlotReservations.assignmentId })
    .from(executionHostSlotReservations).where(eq(executionHostSlotReservations.assignmentId, assignmentId)) : [];
  if (owned) return null;
  if (settings.draining) return "launch_execution_host_draining";
  const [pressure] = await tx.select({ since: executionHostPressure.pressuredSince })
    .from(executionHostPressure).where(eq(executionHostPressure.executionHostId, hostId));
  if (pressure) return HOST_PRESSURED_REASON;
  if (!settings.maxConcurrentRuns) return null;
  const [current] = await tx.select({ occupied: count() })
    .from(executionHostSlotReservations)
    .innerJoin(executionAssignments, eq(executionAssignments.id, executionHostSlotReservations.assignmentId))
    .where(and(eq(executionAssignments.executionHostId, hostId), sql`(
      ${executionAssignments.state}='active' OR ${retainedExecutionRisk(executionAssignments.id)}
    )`));

  return Number(current.occupied) >= settings.maxConcurrentRuns
    ? "launch_execution_host_capacity"
    : null;
}

/** The caller holds the scheduler transaction and commits this before any child effect. */
export async function reserveRunHostCapacity(tx: Db, runId: string): Promise<HostCapacityWaitReason | null> {
  if (!usesHostCapacityReservations()) return null;
  const [assignment] = await tx.select({
    id: executionAssignments.id,
    hostId: executionAssignments.executionHostId,
    epoch: executionAssignments.epoch,
  }).from(executionAssignments)
    .where(and(eq(executionAssignments.runId, runId), eq(executionAssignments.state, "active")));
  if (!assignment) return null;
  const reason = await readHostCapacityWaitReason(tx, assignment.hostId, assignment.id);
  if (reason) {
    log.info({ runId, ...assignment, reason }, "selected execution host admission deferred");
    return reason;
  }
  const inserted = await tx.execute(sql`
    INSERT INTO execution_host_slot_reservations (assignment_id)
    SELECT a.id FROM execution_assignments a JOIN execution_hosts h ON h.id=a.execution_host_id
    WHERE a.id=${assignment.id} AND a.state='active' AND h.capabilities ? 'workspaceProtocol'
    ON CONFLICT (assignment_id) DO NOTHING RETURNING assignment_id`
  );
  if (inserted.rows.length)
    log.info({ runId, ...assignment }, "selected execution host slot reserved");

  return null;
}
