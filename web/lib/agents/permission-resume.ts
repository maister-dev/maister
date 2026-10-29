import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { BoundClient } from "@/lib/execution-host/client";
import type { SupervisorEvent } from "@/lib/execution-host";
import type { ExecutionHostTransport } from "@/lib/execution-host/contracts";
import type { ExecutionAssignment, HitlRequest } from "@/lib/db/schema";
import type {
  AgentPermissionResume,
  Readiness,
  Source,
} from "@/lib/execution-host/agent-permission-handoff";

import { and, asc, eq, isNull, or, sql } from "drizzle-orm";
import pino from "pino";

import { canonicalCommandJson } from "../../../runtime/command-json";

import {
  recordOwnedAgentPermissionInTransaction,
  prepareAgentPermissionResponse,
  completeAgentPermissionDelivery,
  completeAgentPermissionOrigin,
  recordAgentPermissionAcknowledgement,
} from "./permission";
import { admitAgentGenerationTurn } from "./generation-turn";
import { failCheckpointedAgentPermission } from "./permission-rejection";

import {
  agentTurns,
  executionCommands,
  hitlRequests,
  runs,
} from "@/lib/db/schema";
import { PromptOwnerInvariantError } from "@/lib/execution-host/prompt-owners";
import { reconcilePromptCommand } from "@/lib/execution-host/prompt-reconciliation";
import { markSucceeded, markFailed } from "@/lib/execution-host/commands";
import { withdrawRefusedPermissionDelivery } from "@/lib/execution-host/permission-delivery";
import { isRejectedPermissionInputReceipt } from "@/lib/execution-host/permission-handoff-evidence";
import { lockCurrentSessionAssignment } from "@/lib/execution-host/session-binding";
import { agentPermissionEnvelopeSchema } from "@/lib/execution-host/agent-permission-source";
import {
  agentPermissionResumeSchema,
  agentCheckpointEnvelopeSchema,
  checkInput,
  checkInputReceipt,
  readCheckpointSource,
  assertAgentPermissionResumeSource,
  assertAgentResumeTurn,
} from "@/lib/execution-host/agent-permission-handoff";
import { operationalHumanAnswerPrompt } from "@/lib/agents/launch-contract";
export { assertAgentResumeTurn } from "@/lib/execution-host/agent-permission-handoff";

const log = pino({
  name: "agent-permission-resume",
  level: process.env.LOG_LEVEL ?? "info",
});

async function pendingPermissions(
  db: Db,
  runId: string,
): Promise<HitlRequest[]> {
  const candidates = await db
    .select()
    .from(hitlRequests)
    .where(
      and(
        eq(hitlRequests.runId, runId),
        or(
          and(
            eq(hitlRequests.kind, "permission"),
            isNull(hitlRequests.respondedAt),
          ),
          and(
            sql`${hitlRequests.response}->'_agentResume' IS NULL`,
            or(
              and(
                eq(hitlRequests.kind, "agent_question"),
                sql`${hitlRequests.activationState} = 'active'`,
              ),
              and(
                eq(hitlRequests.kind, "hook_trip"),
                or(
                  isNull(hitlRequests.respondedAt),
                  sql`${hitlRequests.response}->>'optionId' = 'resume'`,
                ),
              ),
              and(
                eq(hitlRequests.kind, "budget_breach"),
                or(
                  isNull(hitlRequests.respondedAt),
                  sql`${hitlRequests.response}->>'optionId' = 'raise'`,
                ),
              ),
            ),
          ),
        ),
        isNull(hitlRequests.supersededAt),
        sql`${hitlRequests.schema}->'agentPrompt' IS NOT NULL`,
      ),
    )
    .orderBy(asc(hitlRequests.createdAt), asc(hitlRequests.id));
  // A linked reissue is the current request. Its ancestor remains pending only
  // until the same delivery ACK stamps both response markers.
  const current = candidates.filter((candidate) => {
    const response = candidate.response as Record<string, unknown> | null;
    const grant = agentPermissionResumeSchema.safeParse(response?._agentResume);

    return !grant.success || !grant.data.reissuedHitlRequestId;
  });

  const proofs = current.map((request) =>
    agentCheckpointEnvelopeSchema.safeParse(request.schema),
  );

  if (proofs.some((proof) => !proof.success))
    throw new PromptOwnerInvariantError("agent_permission_resume_source_shape");
  const first = proofs[0];

  if (
    first?.success &&
    proofs.some(
      (proof) =>
        proof.success &&
        (proof.data.agentPrompt.commandId !==
          first.data.agentPrompt.commandId ||
          proof.data.agentPrompt.turnId !== first.data.agentPrompt.turnId ||
          proof.data.agentPrompt.assignmentId !==
            first.data.agentPrompt.assignmentId ||
          proof.data.agentPrompt.incarnationId !==
            first.data.agentPrompt.incarnationId ||
          proof.data.supervisorSessionId !== first.data.supervisorSessionId),
    )
  )
    throw new PromptOwnerInvariantError(
      "agent_permission_resume_source_identity",
    );

  return current;
}

/** Reconcile host evidence before acquiring scheduler/run locks. Conflicting
 * checkpoint generations fail closed; reconciliation never grants execution.
 */
export async function reconcileAgentPermissionResume(
  db: Db,
  runId: string,
  transport: ExecutionHostTransport,
): Promise<void> {
  let requests: HitlRequest[];

  try {
    requests = await pendingPermissions(db, runId);
  } catch (error) {
    if (
      !(error instanceof PromptOwnerInvariantError) ||
      error.details?.causeCode !== "agent_permission_resume_source_identity"
    )
      throw error;
    const [run] = await db
      .select({ kind: runs.agentKind, status: runs.status })
      .from(runs)
      .where(eq(runs.id, runId));

    if (run?.kind !== "operational" || run.status !== "NeedsInputIdle")
      throw error;
    // A checkpoint with conflicting generations cannot safely replay either
    // choice. Preserve its evidence and make reconciliation an explicit action.
    const { finalizeAgentRun } = await import("./finalization");

    await finalizeAgentRun(runId, "Crashed", {
      db,
      causeReason: "agent_permission_resume_source_identity",
      reason:
        "Parallel permission recovery has conflicting execution generations. Inspect the retained permission receipts and reconcile external effects before starting a new attempt.",
    });

    return;
  }
  for (const hitl of requests) await reconcilePermission(db, hitl, transport);
}

async function reconcilePermission(
  db: Db,
  hitl: HitlRequest,
  transport: ExecutionHostTransport,
): Promise<void> {
  const parsed = agentCheckpointEnvelopeSchema.safeParse(hitl.schema);

  if (!parsed.success)
    throw new PromptOwnerInvariantError("agent_permission_resume_source_shape");
  const source = parsed.data;
  const response = hitl.response as Record<string, unknown> | null;

  if (
    !response ||
    (source.kind === "agent_question"
      ? !hitl.respondedAt
      : typeof response.optionId !== "string")
  )
    return;
  const evidence = await reconcilePromptCommand({
    db,
    commandId: source.agentPrompt.commandId,
    lookupReceipt: (commandId) => transport.getCommandReceipt(commandId),
    signal: AbortSignal.timeout(30_000),
  });
  const command = evidence.command;
  const delivery = response._delivery as Record<string, unknown> | undefined;

  if (delivery === undefined) return;
  if (source.kind !== "permission")
    throw new PromptOwnerInvariantError("agent_pause_unexpected_input");
  if (!delivery || typeof delivery.commandId !== "string")
    throw new PromptOwnerInvariantError("agent_permission_delivery_intent");
  const [input] = await db
    .select()
    .from(executionCommands)
    .where(eq(executionCommands.id, delivery.commandId));

  if (!input)
    throw new PromptOwnerInvariantError(
      "agent_permission_resume_input_missing",
    );
  checkInput(source, response, command, input);
  const receipt = await transport.getCommandReceipt(input.id);

  if (!receipt) return;
  checkInputReceipt(input, receipt);
  const rejected = isRejectedPermissionInputReceipt(receipt);

  if (
    !rejected &&
    (receipt.phase !== "completed" ||
      receipt.httpStatus !== 200 ||
      receipt.body.ok !== true)
  )
    return;
  await db.transaction(async (tx) => {
    const settled = rejected
      ? await markFailed(tx, input.id, null, receipt.body)
      : await markSucceeded(tx, input.id, null, receipt.body);

    if (
      !settled.changed &&
      settled.row?.state !== (rejected ? "failed" : "succeeded")
    )
      throw new PromptOwnerInvariantError("agent_permission_input_settlement");
    await tx
      .update(executionCommands)
      .set({ receiptEvidence: receipt })
      .where(eq(executionCommands.id, input.id));
  });
  if (rejected) await failCheckpointedAgentPermission(db, hitl);
}

/** DB-only readiness lets C3 skip unresolved evidence without taking a slot. */
export async function readAgentPermissionResume(
  db: Db,
  runId: string,
): Promise<Readiness> {
  const requests = await pendingPermissions(db, runId);
  const sources = await Promise.all(
    requests.map((request) => readCheckpointSource(db, request)),
  );
  const rejected = sources.find(
    (source) => source.kind === "ready" && source.source.kind === "rejected",
  );

  if (rejected) return rejected;
  const pending = sources.find((source) => source.kind === "pending");

  if (pending) return pending;

  return (
    sources.find(
      (source) =>
        source.kind === "ready" &&
        source.source.pause?.kind === "agent_question",
    ) ??
    sources[0] ??
    null
  );
}

async function withdrawRefusedAgentDelivery(
  tx: Db,
  source: Source,
): Promise<Record<string, unknown>> {
  const envelope = agentPermissionEnvelopeSchema.safeParse(source.hitl.schema);

  if (!envelope.success)
    throw new PromptOwnerInvariantError("agent_permission_resume_source_shape");
  const withdrawn = await withdrawRefusedPermissionDelivery(
    tx,
    source.hitl,
    source.response,
    {
      assignmentId: source.prior.id,
      supervisorSessionId: envelope.data.supervisorSessionId,
      requestId: envelope.data.requestId,
    },
  );

  if (!withdrawn)
    throw new PromptOwnerInvariantError("agent_permission_input_unclassified");

  return withdrawn;
}

/** The normal capacity claim is the sole author of a historical handoff. */
export async function authorizeAgentPermissionResume(
  tx: Db,
  assignment: ExecutionAssignment,
): Promise<void> {
  const ready = await readAgentPermissionResume(tx, assignment.runId);

  if (!ready) return;
  if (ready.kind !== "ready")
    throw new PromptOwnerInvariantError("agent_permission_resume_not_ready");
  const source = ready.source;

  if (source.kind === "rejected")
    throw new PromptOwnerInvariantError("agent_permission_rejection_pending");
  if (!source.pause && source.kind === "result" && source.input === null)
    throw new PromptOwnerInvariantError(
      "agent_permission_result_without_input",
    );
  const [run] = await tx
    .select()
    .from(runs)
    .where(eq(runs.id, assignment.runId));

  if (
    run?.runKind !== "agent" ||
    run.status !== "Running" ||
    run.executionAssignmentId !== assignment.id ||
    assignment.state !== "active" ||
    assignment.placementReason !== "resume" ||
    assignment.executionHostId !== source.prior.executionHostId ||
    assignment.epoch <= source.prior.epoch ||
    source.turn.state !== "dispatched" ||
    source.prior.state !== "released" ||
    source.prior.releasedReason !== "checkpointed"
  )
    throw new PromptOwnerInvariantError("agent_permission_resume_generation");
  let turn = source.turn;

  if (source.kind === "continue") {
    await tx
      .update(agentTurns)
      .set({
        state: "superseded",
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(agentTurns.id, source.turn.id));
    turn = await admitAgentGenerationTurn(tx, {
      runId: assignment.runId,
      assignmentId: assignment.id,
      variant: "resume",
      prompt:
        source.pause?.kind === "agent_question"
          ? operationalHumanAnswerPrompt(
              run,
              source.turn.prompt,
              source.hitl.response,
            )
          : source.turn.prompt,
    });
  }
  const requests = await pendingPermissions(tx, assignment.runId);

  for (const request of requests) {
    const member = await readCheckpointSource(tx, request);

    if (
      member.kind !== "ready" ||
      member.source.kind !== source.kind ||
      member.source.command.id !== source.command.id
    )
      throw new PromptOwnerInvariantError(
        "agent_permission_resume_group_changed",
      );
    const item = member.source;
    const grant: AgentPermissionResume = {
      version: 1,
      kind: item.kind === "rejected" ? "result" : item.kind,
      assignmentId: assignment.id,
      turnId: turn.id,
      sourceCommandId: item.command.id,
      sourceRequestSha256: item.command.requestSha256!,
      sourceTerminalEvidenceSha256: item.command.terminalEvidenceSha256!,
      checkpointCommandId: item.checkpoint?.id ?? null,
      inputCommandId: item.input?.id ?? null,
      resumeSessionId: item.incarnation.acpSessionId,
      optionId: item.response.optionId,
      ...(item.pause ? { pause: item.pause } : {}),
    };
    const response =
      item.input === null && item.response._delivery !== undefined
        ? await withdrawRefusedAgentDelivery(tx, item)
        : item.pause?.kind === "agent_question"
          ? (item.hitl.response as Record<string, unknown>)
          : item.response;

    await tx
      .update(hitlRequests)
      .set({
        response: { ...response, _agentResume: grant },
        ...(item.kind === "result" || item.input
          ? { respondedAt: new Date() }
          : {}),
      })
      .where(eq(hitlRequests.id, item.hitl.id));
    if (!item.pause && (item.kind === "result" || item.input)) {
      await completeAgentPermissionOrigin(tx, item.hitl.id);
      await recordAgentPermissionAcknowledgement(tx, item.hitl.id);
    }
  }

  log.info(
    {
      runId: assignment.runId,
      assignmentId: assignment.id,
      turnId: turn.id,
      sourceCommandId: source.command.id,
      kind: source.kind,
    },
    "agent-permission-resume-authorized",
  );
}

/** A historical result has no successor session. The existing checkpoint's
 * confirmed teardown supplies its closed lifecycle, under the current grant.
 */
export async function lockAgentPermissionResult(
  tx: Db,
  runId: string,
  commandId: string,
): Promise<Readonly<{ state: "exited"; persistent: boolean }> | null> {
  const [run] = await tx
    .select()
    .from(runs)
    .where(eq(runs.id, runId))
    .for("update");

  if (
    run?.runKind !== "agent" ||
    run.status !== "Running" ||
    !run.executionAssignmentId
  )
    return null;
  const assignment = await lockCurrentSessionAssignment(tx, {
    runId,
    assignmentId: run.executionAssignmentId,
  });

  if (!assignment || assignment.placementReason !== "resume") return null;
  const members = await tx
    .select()
    .from(hitlRequests)
    .where(
      and(
        eq(hitlRequests.runId, runId),
        sql`${hitlRequests.response}->'_agentResume'->>'kind' = 'result'`,
        sql`${hitlRequests.response}->'_agentResume'->>'sourceCommandId' = ${commandId}`,
        sql`${hitlRequests.response}->'_agentResume'->>'assignmentId' = ${assignment.id}`,
      ),
    )
    .for("update");

  if (!members.length) return null;
  for (const hitl of members) {
    const source = await assertAgentPermissionResumeSource(
      tx,
      hitl,
      assignment,
    );
    const grant = agentPermissionResumeSchema.parse(
      (hitl.response as Record<string, unknown>)._agentResume,
    );

    if (
      source.kind !== "result" ||
      !hitl.respondedAt ||
      source.turn.state !== "dispatched" ||
      grant.turnId !== source.turn.id ||
      grant.applied
    )
      throw new PromptOwnerInvariantError(
        "agent_permission_result_application",
      );
  }

  return { state: "exited", persistent: run.persistent };
}

export async function findAgentPermissionResult(
  db: Db,
  runId: string,
  assignmentId: string,
): Promise<string | null> {
  const [hitl] = await db
    .select()
    .from(hitlRequests)
    .where(
      and(
        eq(hitlRequests.runId, runId),
        sql`${hitlRequests.response}->'_agentResume'->>'kind' = 'result'`,
        sql`${hitlRequests.response}->'_agentResume'->>'assignmentId' = ${assignmentId}`,
      ),
    );

  if (!hitl) return null;
  const grant = agentPermissionResumeSchema.safeParse(
    (hitl.response as Record<string, unknown>)._agentResume,
  );

  if (!grant.success)
    throw new PromptOwnerInvariantError("agent_permission_resume_grant_shape");

  return grant.data.applied ? null : grant.data.sourceCommandId;
}

/** Called after the ordinary domain write, in the command application tx. */
export async function acknowledgeAgentPermissionResult(
  tx: Db,
  runId: string,
  commandId: string,
): Promise<void> {
  const [run] = await tx.select().from(runs).where(eq(runs.id, runId));
  const members = await tx
    .select()
    .from(hitlRequests)
    .where(
      and(
        eq(hitlRequests.runId, runId),
        sql`${hitlRequests.response}->'_agentResume'->>'kind' = 'result'`,
        sql`${hitlRequests.response}->'_agentResume'->>'sourceCommandId' = ${commandId}`,
        sql`${hitlRequests.response}->'_agentResume'->>'assignmentId' = ${run?.executionAssignmentId ?? ""}`,
      ),
    );

  for (const hitl of members) {
    const response = hitl.response as Record<string, unknown>;
    const grant = agentPermissionResumeSchema.safeParse(response._agentResume);

    if (!grant.success)
      throw new PromptOwnerInvariantError(
        "agent_permission_resume_grant_shape",
      );
    await tx
      .update(hitlRequests)
      .set({
        response: {
          ...response,
          _agentResume: { ...grant.data, applied: true },
        },
      })
      .where(eq(hitlRequests.id, hitl.id));
  }
}

/** Only the current granted turn may carry the accepted choice to one
 * reissued request. The reissue owns a current source for another checkpoint.
 */
export async function deliverResumedAgentPermission(
  db: Db,
  client: BoundClient,
  event: Extract<SupervisorEvent, { type: "session.permission_request" }>,
): Promise<boolean> {
  const delivery = await db.transaction(async (tx) => {
    if (
      !(await lockCurrentSessionAssignment(tx, {
        runId: client.assignment.runId,
        assignmentId: client.assignment.id,
      }))
    )
      return null;
    const parents = await tx
      .select()
      .from(hitlRequests)
      .where(
        and(
          eq(hitlRequests.runId, client.assignment.runId),
          isNull(hitlRequests.respondedAt),
          sql`${hitlRequests.response}->'_agentResume'->>'kind' = 'continue'`,
          sql`${hitlRequests.response}->'_agentResume'->>'assignmentId' = ${client.assignment.id}`,
        ),
      )
      .for("update");

    const matching = parents.filter((candidate) => {
      const schema = candidate.schema as Record<string, unknown>;

      return (
        canonicalCommandJson(schema.toolCall ?? null) ===
        canonicalCommandJson(event.toolCall ?? null)
      );
    });

    if (matching.length !== 1) return null;
    const parent = matching[0];

    const response = parent.response as Record<string, unknown>;
    const grant = agentPermissionResumeSchema.safeParse(response._agentResume);

    if (!grant.success)
      throw new PromptOwnerInvariantError(
        "agent_permission_resume_grant_shape",
      );
    if (grant.data.inputCommandId !== null || grant.data.pause) return null;
    const [turn] = await tx
      .select()
      .from(agentTurns)
      .where(eq(agentTurns.id, grant.data.turnId));

    if (!turn || turn.state !== "dispatched")
      throw new PromptOwnerInvariantError("agent_permission_reissue_turn");
    await assertAgentResumeTurn(tx, turn, client.assignment);
    if (
      !event.options.some((option) => option.optionId === grant.data.optionId)
    )
      throw new PromptOwnerInvariantError("agent_permission_reissue_options");
    if (grant.data.reissuedHitlRequestId) {
      const [retained] = await tx
        .select()
        .from(hitlRequests)
        .where(eq(hitlRequests.id, grant.data.reissuedHitlRequestId));
      const retainedSource = agentPermissionEnvelopeSchema.safeParse(
        retained?.schema,
      );

      if (!retainedSource.success)
        throw new PromptOwnerInvariantError("agent_permission_reissue_source");
      if (
        retainedSource.data.requestId !== event.requestId ||
        retainedSource.data.supervisorSessionId !== event.sessionId
      )
        return null;
    }
    if (!(await recordOwnedAgentPermissionInTransaction(tx, client, event)))
      throw new PromptOwnerInvariantError(
        "agent_permission_reissue_owner_missing",
      );
    const [child] = await tx
      .select()
      .from(hitlRequests)
      .where(
        and(
          eq(hitlRequests.runId, client.assignment.runId),
          sql`${hitlRequests.schema}->'agentPrompt'->>'commandId' = ${turn.commandId}`,
          sql`${hitlRequests.schema}->>'requestId' = ${event.requestId}`,
        ),
      )
      .for("update");

    if (!child)
      throw new PromptOwnerInvariantError("agent_permission_reissue_missing");
    const stored = child.response as Record<string, unknown> | null;

    if (stored && stored.optionId !== grant.data.optionId)
      throw new PromptOwnerInvariantError(
        "agent_permission_reissue_choice_changed",
      );
    await tx
      .update(hitlRequests)
      .set({
        response: {
          ...response,
          _agentResume: { ...grant.data, reissuedHitlRequestId: child.id },
        },
      })
      .where(eq(hitlRequests.id, parent.id));
    await tx
      .update(hitlRequests)
      .set({
        response: {
          ...stored,
          optionId: grant.data.optionId,
          _agentResumeOrigin: {
            hitlRequestId: parent.id,
            assignmentId: client.assignment.id,
            turnId: turn.id,
            sourceCommandId: grant.data.sourceCommandId,
          },
        },
      })
      .where(eq(hitlRequests.id, child.id));
    const prepared = await prepareAgentPermissionResponse(tx, client, child.id);

    return prepared ? { prepared, hitlRequestId: child.id } : null;
  });

  if (!delivery) return false;
  await delivery.prepared.deliver({
    onAck: async (tx) => {
      const stamped = await tx
        .update(hitlRequests)
        .set({ respondedAt: new Date() })
        .where(
          and(
            eq(hitlRequests.id, delivery.hitlRequestId),
            isNull(hitlRequests.respondedAt),
          ),
        )
        .returning({ id: hitlRequests.id });

      await completeAgentPermissionDelivery(
        tx,
        delivery.hitlRequestId,
        delivery.prepared.commandId,
      );
      if (stamped.length > 0)
        await recordAgentPermissionAcknowledgement(tx, delivery.hitlRequestId);
    },
  });
  log.info(
    {
      runId: client.assignment.runId,
      hitlRequestId: delivery.hitlRequestId,
      commandId: delivery.prepared.commandId,
    },
    "agent-resumed-permission-delivered",
  );

  return true;
}
