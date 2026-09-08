import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { HitlRequest } from "@/lib/db/schema";

import { eq } from "drizzle-orm";
import pino from "pino";

import { canonicalCommandJson } from "../../../runtime/command-json";

import { prepareCheckpointedAgentFailure } from "./finalization";
import { recordAgentPermissionAcknowledgement } from "./permission";

import { agentTurns, hitlRequests, runs } from "@/lib/db/schema";
import { readCheckpointSource } from "@/lib/execution-host/agent-permission-handoff";
import { PromptOwnerInvariantError } from "@/lib/execution-host/prompt-owners";

const log = pino({
  name: "agent-permission-rejection",
  level: process.env.LOG_LEVEL ?? "info",
});

/** A definitive no-effect input receipt closes its parked owner without taking
 * an execution slot. Its source prompt remains immutable historical evidence.
 */
export async function failCheckpointedAgentPermission(
  db: Db,
  original: HitlRequest,
): Promise<void> {
  const source = await readCheckpointSource(db, original);

  if (source.kind !== "ready" || source.source.kind !== "rejected") return;
  const prepared = await prepareCheckpointedAgentFailure(original.runId, {
    db,
    reason: "HITL_TIMEOUT",
  });
  const result = await db.transaction(async (tx) => {
    const [run] = await tx
      .select()
      .from(runs)
      .where(eq(runs.id, original.runId))
      .for("update");
    const [hitl] = await tx
      .select()
      .from(hitlRequests)
      .where(eq(hitlRequests.id, original.id))
      .for("update");

    if (hitl?.respondedAt || run?.status !== "NeedsInputIdle")
      return { finalized: false } as const;
    if (
      !hitl ||
      run.runKind !== "agent" ||
      run.executionAssignmentId !== source.source.prior.id ||
      canonicalCommandJson(hitl.schema) !==
        canonicalCommandJson(original.schema) ||
      canonicalCommandJson(hitl.response) !==
        canonicalCommandJson(original.response)
    )
      throw new PromptOwnerInvariantError(
        "agent_permission_rejection_generation",
      );
    const ready = await readCheckpointSource(tx, hitl);

    if (
      ready.kind !== "ready" ||
      ready.source.kind !== "rejected" ||
      ready.source.turn.state !== "dispatched" ||
      ready.source.command.requestSha256 !==
        source.source.command.requestSha256 ||
      ready.source.command.terminalEvidenceSha256 !==
        source.source.command.terminalEvidenceSha256
    )
      throw new PromptOwnerInvariantError("agent_permission_rejection_source");
    await tx
      .update(hitlRequests)
      .set({
        respondedAt: new Date(),
        response: {
          ...ready.source.response,
          _audit: {
            rejectedDeliveryCommandId: ready.source.input!.id,
            sourceCommandId: ready.source.command.id,
            assignmentId: ready.source.prior.id,
            errorCode: "HITL_TIMEOUT",
          },
        },
      })
      .where(eq(hitlRequests.id, hitl.id));
    await recordAgentPermissionAcknowledgement(tx, hitl.id);
    const application = await prepared.apply(tx);

    if (!application.finalized)
      throw new PromptOwnerInvariantError(
        "agent_permission_rejection_settlement",
      );
    await tx
      .update(agentTurns)
      .set({
        state: "superseded",
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(agentTurns.id, ready.source.turn.id));

    return application;
  });

  await prepared.afterCommit(result);
  if (result.finalized)
    log.warn(
      { runId: original.runId, hitlRequestId: original.id },
      "agent-permission-rejection-settled",
    );
}
