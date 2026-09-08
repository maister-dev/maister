import "server-only";

import type { Db } from "./db";

import { and, eq, isNull, sql } from "drizzle-orm";

import { agentPauseEnvelopeSchema } from "./agent-pause-source";
import { PromptOwnerInvariantError } from "./prompt-owners";

import { hitlRequests, runs } from "@/lib/db/schema";
import { systemCloseActiveAssignmentsForHitlRequest } from "@/lib/assignments/service";

/** The run lock serializes an in-flight permission against checkpoint pause. */
export async function isAgentPermissionPause(
  tx: Db,
  runId: string,
  commandId: string,
): Promise<boolean> {
  const [run] = await tx
    .select()
    .from(runs)
    .where(eq(runs.id, runId))
    .for("update");

  if (run?.status !== "NeedsInput") return false;
  const requests = await tx
    .select()
    .from(hitlRequests)
    .where(
      and(
        eq(hitlRequests.runId, runId),
        isNull(hitlRequests.respondedAt),
        isNull(hitlRequests.supersededAt),
      ),
    );

  return (
    requests.length > 0 &&
    requests.every(
      (row) =>
        row.kind === "permission" &&
        (row.schema as { agentPrompt?: { commandId?: string } } | null)
          ?.agentPrompt?.commandId === commandId,
    )
  );
}

/** Cancellation is a disposition, never a fabricated user answer. */
export async function supersedeAgentPausePermissions(
  tx: Db,
  pauseId: string,
): Promise<void> {
  const [pause] = await tx
    .select()
    .from(hitlRequests)
    .where(eq(hitlRequests.id, pauseId));
  const source = agentPauseEnvelopeSchema.safeParse(pause?.schema);

  if (!source.success || pause.kind !== source.data.kind)
    throw new PromptOwnerInvariantError("agent_pause_permission_source");
  const [run] = await tx
    .select()
    .from(runs)
    .where(eq(runs.id, pause.runId))
    .for("update");

  if (!run) throw new PromptOwnerInvariantError("agent_pause_permission_run");
  const cancelled = await tx
    .update(hitlRequests)
    .set({
      supersededAt: new Date(),
      supersededByHitlRequestId: pause.id,
    })
    .where(
      and(
        eq(hitlRequests.runId, run.id),
        eq(hitlRequests.kind, "permission"),
        isNull(hitlRequests.respondedAt),
        isNull(hitlRequests.supersededAt),
        sql`${hitlRequests.schema}->'agentPrompt' = ${JSON.stringify(source.data.agentPrompt)}::jsonb`,
        sql`${hitlRequests.schema}->>'supervisorSessionId' = ${source.data.supervisorSessionId}`,
      ),
    )
    .returning({ id: hitlRequests.id });

  if (run.projectId)
    for (const request of cancelled) {
      await systemCloseActiveAssignmentsForHitlRequest({
        db: tx,
        hitlRequestId: request.id,
        projectId: run.projectId,
        reason: "agent permission cancelled by checkpoint pause",
      });
    }
}
