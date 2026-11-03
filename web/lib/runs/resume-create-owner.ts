import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { ResumeCreateOwner } from "@/lib/execution-host/create-owner-contract";

import { and, eq } from "drizzle-orm";

import {
  executionAssignments,
  runSessionIncarnations,
  runSessions,
  runs,
} from "@/lib/db/schema";

/** The resume owns an exact prior incarnation, never a newly selected session. */
export async function lockResumeCreateOwner(
  tx: Db,
  input: Readonly<{
    runId: string;
    assignmentId: string;
    owner: ResumeCreateOwner;
  }>,
  check: "create" | "ack",
): Promise<boolean> {
  const [run] = await tx.select().from(runs).where(eq(runs.id, input.runId));
  const [current] = await tx
    .select()
    .from(executionAssignments)
    .where(eq(executionAssignments.id, input.assignmentId));

  if (!current) return false;
  const [session] = await tx
    .select()
    .from(runSessions)
    .where(eq(runSessions.id, input.owner.runSessionId))
    .for("update");
  const [source] = await tx
    .select()
    .from(runSessionIncarnations)
    .where(eq(runSessionIncarnations.id, input.owner.sourceIncarnationId))
    .for("update");

  if (!source?.executionAssignmentId) return false;
  const [prior] = await tx
    .select()
    .from(executionAssignments)
    .where(
      and(
        eq(executionAssignments.id, source.executionAssignmentId),
        eq(executionAssignments.runId, input.runId),
      ),
    );

  return (
    run?.runKind ===
      (input.owner.variant === "flow_resume" ? "flow" : "scratch") &&
    (run.status === "NeedsInput" ||
      (check === "ack" && run.status === "Running")) &&
    session?.runId === run.id &&
    source?.runId === run.id &&
    source.runSessionId === session.id &&
    source.executionAssignmentId !== input.assignmentId &&
    source.executionHostId === current.executionHostId &&
    source.assignmentEpoch === prior?.epoch &&
    prior?.executionHostId === current.executionHostId &&
    prior.epoch < current.epoch &&
    (source.state === "checkpointed" || source.state === "lost") &&
    prior?.state === "released" &&
    prior.releasedReason === "checkpointed"
  );
}
