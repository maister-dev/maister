import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { BoundClient, PreparedInput } from "@/lib/execution-host/client";
import type { SupervisorEvent } from "@/lib/execution-host";
import type { ExecutionCommand } from "@/lib/db/schema";

import { randomUUID } from "node:crypto";

import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import pino from "pino";

import { canonicalCommandJson } from "../../../runtime/command-json";

import {
  agentTurns,
  executionCommands,
  hitlRequests,
  runs,
  runSessions,
  runSessionIncarnations,
} from "@/lib/db/schema";
import { lockCurrentSessionAssignment } from "@/lib/execution-host/session-binding";
import {
  PromptOwnerDeferred,
  PromptOwnerInvariantError,
} from "@/lib/execution-host/prompt-owners";
import { nextKeepaliveAt } from "@/lib/runs/keepalive-config";
import { emitWebhookEvent } from "@/lib/webhooks/outbox";
import { completeHitlAssignmentFromCurrentActor } from "@/lib/assignments/service";
import {
  agentPermissionSourceSchema,
  agentPermissionEnvelopeSchema,
} from "@/lib/execution-host/agent-permission-source";
export {
  agentPermissionSourceSchema,
  agentPermissionEnvelopeSchema,
} from "@/lib/execution-host/agent-permission-source";

const log = pino({
  name: "agent-permission",
  level: process.env.LOG_LEVEL ?? "info",
});

const deliverySchema = z
  .object({
    commandId: z.string().min(1),
    hostSessionId: z.string().min(1),
    payload: z
      .object({
        kind: z.literal("permission"),
        action: z.literal("select"),
        requestId: z.string().min(1),
        optionId: z.string().min(1),
      })
      .strict(),
  })
  .strict();

const resumeOriginSchema = z
  .object({
    hitlRequestId: z.string().min(1),
    assignmentId: z.string().min(1),
    turnId: z.string().min(1),
    sourceCommandId: z.string().min(1),
  })
  .strict();

export type AgentPermissionSource = z.infer<typeof agentPermissionSourceSchema>;
type AgentPermissionEnvelope = z.infer<typeof agentPermissionEnvelopeSchema>;
type PermissionEvent = Extract<
  SupervisorEvent,
  { type: "session.permission_request" }
>;

export function parseAgentPermission(
  value: unknown,
): AgentPermissionEnvelope | null {
  if (typeof value !== "object" || value === null || !("agentPrompt" in value))
    return null;
  const parsed = agentPermissionEnvelopeSchema.safeParse(value);

  if (!parsed.success)
    throw new PromptOwnerInvariantError("agent_permission_source_shape");

  return parsed.data;
}

async function lockAgentPermissionSource(
  tx: Db,
  source: AgentPermissionSource,
  hostSessionId: string,
): Promise<ExecutionCommand> {
  const [command] = await tx
    .select()
    .from(executionCommands)
    .where(eq(executionCommands.id, source.commandId));
  const ref = command?.ownerRef;

  if (
    !command ||
    command.kind !== "session.prompt" ||
    command.ownerKind !== "agent_turn" ||
    !ref ||
    !("turnId" in ref) ||
    !("promptOrdinal" in ref) ||
    ref.turnId !== source.turnId ||
    ref.promptOrdinal !== source.promptOrdinal ||
    ref.assignmentId !== source.assignmentId ||
    ref.incarnationId !== source.incarnationId ||
    command.targetSessionId !== hostSessionId ||
    command.executionAssignmentId !== source.assignmentId
  )
    throw new PromptOwnerInvariantError("agent_permission_source_identity");
  const assignment = await lockCurrentSessionAssignment(tx, {
    runId: command.runId,
    assignmentId: source.assignmentId,
  });
  const [run] = await tx.select().from(runs).where(eq(runs.id, command.runId));
  const [turn] = await tx
    .select()
    .from(agentTurns)
    .where(eq(agentTurns.id, source.turnId))
    .for("update");
  const [binding] = await tx
    .select({ session: runSessions, incarnation: runSessionIncarnations })
    .from(runSessions)
    .innerJoin(
      runSessionIncarnations,
      eq(runSessionIncarnations.runSessionId, runSessions.id),
    )
    .where(
      and(
        eq(runSessions.id, ref.runSessionId),
        eq(runSessionIncarnations.id, source.incarnationId),
      ),
    )
    .for("update");

  if (
    !assignment ||
    run?.runKind !== "agent" ||
    !["Running", "NeedsInput"].includes(run.status) ||
    turn?.state !== "dispatched" ||
    turn.commandId !== command.id ||
    turn.runId !== command.runId ||
    turn.ordinal !== source.promptOrdinal ||
    turn.executionAssignmentId !== assignment.id ||
    turn.assignmentEpoch !== assignment.epoch ||
    turn.incarnationId !== source.incarnationId ||
    turn.runSessionId !== ref.runSessionId ||
    ref.assignmentEpoch !== assignment.epoch ||
    binding?.session.runId !== command.runId ||
    binding.session.executionAssignmentId !== assignment.id ||
    binding.session.hostSessionId !== hostSessionId ||
    binding.incarnation.executionAssignmentId !== assignment.id ||
    binding.incarnation.hostSessionId !== hostSessionId ||
    binding.incarnation.assignmentEpoch !== assignment.epoch ||
    binding.incarnation.executionHostId !== assignment.executionHostId
  )
    throw new PromptOwnerInvariantError("agent_permission_source_generation");

  return command;
}

/** Canonical notification replay creates one request under its original turn. */
export async function recordOwnedAgentPermission(
  db: Db,
  client: BoundClient,
  event: PermissionEvent,
): Promise<boolean> {
  return db.transaction((tx) =>
    recordOwnedAgentPermissionInTransaction(tx, client, event),
  );
}

export async function recordOwnedAgentPermissionInTransaction(
  tx: Db,
  client: BoundClient,
  event: PermissionEvent,
): Promise<boolean> {
  const assignment = await lockCurrentSessionAssignment(tx, {
    runId: client.assignment.runId,
    assignmentId: client.assignment.id,
  });

  if (!assignment) return true;
  const [turn] = await tx
    .select()
    .from(agentTurns)
    .where(
      and(
        eq(agentTurns.runId, assignment.runId),
        eq(agentTurns.executionAssignmentId, assignment.id),
        eq(agentTurns.state, "dispatched"),
      ),
    );

  if (!turn?.commandId || !turn.incarnationId) return false;
  const source: AgentPermissionSource = {
    version: 1,
    commandId: turn.commandId,
    turnId: turn.id,
    promptOrdinal: turn.ordinal,
    assignmentId: assignment.id,
    incarnationId: turn.incarnationId,
  };

  await lockAgentPermissionSource(tx, source, event.sessionId);
  const [existing] = await tx
    .select()
    .from(hitlRequests)
    .where(
      and(
        eq(hitlRequests.runId, assignment.runId),
        eq(hitlRequests.kind, "permission"),
        sql`${hitlRequests.schema}->'agentPrompt'->>'commandId' = ${turn.commandId}`,
        sql`${hitlRequests.schema}->>'requestId' = ${event.requestId}`,
      ),
    );

  if (existing) {
    const retained = parseAgentPermission(existing.schema);

    if (
      !retained ||
      canonicalCommandJson(retained.agentPrompt) !==
        canonicalCommandJson(source) ||
      retained.supervisorSessionId !== event.sessionId
    )
      throw new PromptOwnerInvariantError("agent_permission_replay_identity");

    return true;
  }
  const id = randomUUID();

  await tx.insert(hitlRequests).values({
    id,
    runId: assignment.runId,
    stepId: "agent",
    kind: "permission",
    schema: {
      requestId: event.requestId,
      options: event.options,
      toolCall: event.toolCall,
      supervisorSessionId: event.sessionId,
      agentPrompt: source,
    },
    prompt: "Agent requests a tool permission",
  });
  await tx
    .update(runs)
    .set({ status: "NeedsInput", keepaliveUntil: nextKeepaliveAt() })
    .where(and(eq(runs.id, assignment.runId), eq(runs.status, "Running")));
  log.info(
    { runId: assignment.runId, commandId: turn.commandId, hitlRequestId: id },
    "agent-owned-permission-recorded",
  );

  return true;
}

/** A retried response reattaches its frozen delivery, including ACK loss. */
export async function prepareAgentPermissionResponse(
  tx: Db,
  client: BoundClient,
  hitlRequestId: string,
): Promise<PreparedInput | null> {
  const [hitl] = await tx
    .select()
    .from(hitlRequests)
    .where(eq(hitlRequests.id, hitlRequestId));
  const source = parseAgentPermission(hitl?.schema);

  if (!hitl || !source || hitl.respondedAt) return null;
  const command = await lockAgentPermissionSource(
    tx,
    source.agentPrompt,
    source.supervisorSessionId,
  );
  const response = hitl.response as Record<string, unknown> | null;

  if (
    command.runId !== hitl.runId ||
    client.assignment.id !== source.agentPrompt.assignmentId ||
    typeof response?.optionId !== "string" ||
    !source.options.some((option) => option.optionId === response.optionId)
  )
    throw new PromptOwnerInvariantError("agent_permission_choice_identity");
  const payload = {
    kind: "permission",
    action: "select",
    requestId: source.requestId,
    optionId: response.optionId,
  } as const;

  if (response._delivery !== undefined) {
    const parsed = deliverySchema.safeParse(response._delivery);

    if (
      !parsed.success ||
      parsed.data.hostSessionId !== source.supervisorSessionId ||
      canonicalCommandJson(parsed.data.payload) !==
        canonicalCommandJson(payload)
    )
      throw new PromptOwnerInvariantError("agent_permission_delivery_intent");

    return client.reattachPermissionInput(
      tx,
      parsed.data.commandId,
      parsed.data.hostSessionId,
      payload,
    );
  }
  const delivery = await client.prepareInput(
    tx,
    source.supervisorSessionId,
    payload,
  );

  await tx
    .update(hitlRequests)
    .set({
      response: {
        ...response,
        _delivery: {
          commandId: delivery.commandId,
          hostSessionId: source.supervisorSessionId,
          payload,
        },
      },
    })
    .where(eq(hitlRequests.id, hitl.id));

  return delivery;
}

export async function completeAgentPermissionDelivery(
  tx: Db,
  hitlRequestId: string,
  deliveryCommandId: string,
): Promise<void> {
  const [hitl] = await tx
    .select()
    .from(hitlRequests)
    .where(eq(hitlRequests.id, hitlRequestId));
  const source = parseAgentPermission(hitl?.schema);

  if (!hitl || !source) return;
  const prior = hitl.response as Record<string, unknown> | null;
  const audit = prior?._audit as Record<string, unknown> | undefined;

  if (
    hitl.respondedAt &&
    audit?.deliveryCommandId === deliveryCommandId &&
    audit.sourceCommandId === source.agentPrompt.commandId &&
    audit.assignmentId === source.agentPrompt.assignmentId &&
    audit.incarnationId === source.agentPrompt.incarnationId &&
    audit.requestId === source.requestId
  )
    return;
  await lockAgentPermissionSource(
    tx,
    source.agentPrompt,
    source.supervisorSessionId,
  );
  const [delivery] = await tx
    .select()
    .from(executionCommands)
    .where(eq(executionCommands.id, deliveryCommandId));
  const response = hitl.response as Record<string, unknown> | null;
  const frozen = deliverySchema.safeParse(response?._delivery);

  if (
    !hitl.respondedAt ||
    !frozen.success ||
    frozen.data.commandId !== deliveryCommandId ||
    delivery?.state !== "succeeded" ||
    delivery.runId !== hitl.runId ||
    delivery.kind !== "session.input" ||
    delivery.executionAssignmentId !== source.agentPrompt.assignmentId ||
    delivery.targetSessionId !== source.supervisorSessionId ||
    canonicalCommandJson(delivery.payload) !==
      canonicalCommandJson(frozen.data.payload)
  )
    throw new PromptOwnerInvariantError("agent_permission_delivery_identity");
  await tx
    .update(hitlRequests)
    .set({
      response: {
        ...response,
        _audit: {
          deliveryCommandId,
          sourceCommandId: source.agentPrompt.commandId,
          assignmentId: source.agentPrompt.assignmentId,
          incarnationId: source.agentPrompt.incarnationId,
          requestId: source.requestId,
        },
      },
    })
    .where(eq(hitlRequests.id, hitl.id));
  await tx
    .update(runs)
    .set({ status: "Running", keepaliveUntil: null })
    .where(
      and(
        eq(runs.id, hitl.runId),
        eq(runs.status, "NeedsInput"),
        eq(runs.executionAssignmentId, source.agentPrompt.assignmentId),
      ),
    );
  log.info(
    { runId: hitl.runId, hitlRequestId, deliveryCommandId },
    "agent-owned-permission-delivered",
  );
  await completeAgentPermissionOrigin(tx, hitl.id);
  await completeHitlAssignmentFromCurrentActor({
    db: tx,
    hitlRequestId: hitl.id,
    eventKind: "responded",
    payload: { deliveryCommandId },
  });
}

/** A reissued request consumes one accepted choice through an explicit link.
 * Its ACK also closes any checkpointed ancestors in the same transaction.
 */
export async function completeAgentPermissionOrigin(
  tx: Db,
  hitlRequestId: string,
  ancestors: ReadonlySet<string> = new Set(),
): Promise<void> {
  if (ancestors.has(hitlRequestId) || ancestors.size >= 64)
    throw new PromptOwnerInvariantError("agent_permission_origin_cycle");
  const [child] = await tx
    .select()
    .from(hitlRequests)
    .where(eq(hitlRequests.id, hitlRequestId));
  const response = child?.response as Record<string, unknown> | null;

  if (response?._agentResumeOrigin === undefined) return;
  const origin = resumeOriginSchema.safeParse(response._agentResumeOrigin);
  const source = parseAgentPermission(child?.schema);

  if (!origin.success || !child?.respondedAt || !source)
    throw new PromptOwnerInvariantError("agent_permission_origin_shape");
  const [parent] = await tx
    .select()
    .from(hitlRequests)
    .where(eq(hitlRequests.id, origin.data.hitlRequestId))
    .for("update");
  const parentSource = parseAgentPermission(parent?.schema);
  const priorResponse = parent?.response as Record<string, unknown> | null;
  const grant = priorResponse?._agentResume as
    | Record<string, unknown>
    | undefined;

  if (
    !parent ||
    !parentSource ||
    parent.runId !== child.runId ||
    source.agentPrompt.assignmentId !== origin.data.assignmentId ||
    source.agentPrompt.turnId !== origin.data.turnId ||
    grant?.kind !== "continue" ||
    grant.assignmentId !== origin.data.assignmentId ||
    grant.turnId !== origin.data.turnId ||
    grant.sourceCommandId !== origin.data.sourceCommandId ||
    parentSource.agentPrompt.commandId !== origin.data.sourceCommandId ||
    grant.reissuedHitlRequestId !== child.id ||
    grant.inputCommandId !== null ||
    grant.optionId !== response.optionId ||
    priorResponse?.optionId !== response.optionId
  )
    throw new PromptOwnerInvariantError("agent_permission_origin_identity");
  if (parent.respondedAt) return;
  await tx
    .update(hitlRequests)
    .set({
      respondedAt: new Date(),
      response: {
        ...priorResponse,
        _audit: {
          originalRequestId: parentSource.requestId,
          reissuedRequestId: source.requestId,
          reissuedHitlRequestId: child.id,
          deliveredViaAgentResume: true,
        },
      },
    })
    .where(eq(hitlRequests.id, parent.id));
  await recordAgentPermissionAcknowledgement(tx, parent.id);
  await completeAgentPermissionOrigin(
    tx,
    parent.id,
    new Set([...ancestors, child.id]),
  );
}

/** Called only by the transaction that first stamps the response marker. */
export async function recordAgentPermissionAcknowledgement(
  tx: Db,
  hitlRequestId: string,
): Promise<void> {
  const [hitl] = await tx
    .select()
    .from(hitlRequests)
    .where(eq(hitlRequests.id, hitlRequestId));

  if (!hitl?.respondedAt)
    throw new PromptOwnerInvariantError("agent_permission_ack_missing");
  await completeHitlAssignmentFromCurrentActor({
    db: tx,
    hitlRequestId,
    eventKind: "responded",
  });
  const [run] = await tx
    .select({ projectId: runs.projectId })
    .from(runs)
    .where(eq(runs.id, hitl.runId));

  if (run?.projectId)
    await emitWebhookEvent({
      db: tx,
      type: "hitl.responded",
      projectId: run.projectId,
      runId: hitl.runId,
      data: { hitlRequestId, kind: "permission", via: "auto" },
    });
}

/** Replayed canonical permission events recover the original input ACK. They
 * cannot authorize a second delivery or apply an old choice to a new request.
 */
export async function replayAgentPermissionDelivery(
  db: Db,
  client: BoundClient,
  event: PermissionEvent,
): Promise<boolean> {
  const [hitl] = await db
    .select()
    .from(hitlRequests)
    .where(
      and(
        eq(hitlRequests.runId, client.assignment.runId),
        eq(hitlRequests.kind, "permission"),
        sql`${hitlRequests.schema}->'agentPrompt'->>'assignmentId' = ${client.assignment.id}`,
        sql`${hitlRequests.schema}->>'supervisorSessionId' = ${event.sessionId}`,
        sql`${hitlRequests.schema}->>'requestId' = ${event.requestId}`,
      ),
    )
    .limit(1);

  if (!hitl) return false;
  if (hitl.respondedAt) return true;
  const response = hitl.response as Record<string, unknown> | null;

  if (response?._delivery === undefined) return false;
  const prepared = await db.transaction((tx) =>
    prepareAgentPermissionResponse(tx, client, hitl.id),
  );

  if (!prepared) return true;
  await prepared.deliver({
    onAck: async (tx) => {
      const [stamped] = await tx
        .update(hitlRequests)
        .set({ respondedAt: new Date() })
        .where(
          and(eq(hitlRequests.id, hitl.id), isNull(hitlRequests.respondedAt)),
        )
        .returning({ id: hitlRequests.id });

      await completeAgentPermissionDelivery(tx, hitl.id, prepared.commandId);
      if (stamped) {
        const [run] = await tx
          .select({ projectId: runs.projectId })
          .from(runs)
          .where(eq(runs.id, hitl.runId));

        if (run?.projectId)
          await emitWebhookEvent({
            db: tx,
            type: "hitl.responded",
            projectId: run.projectId,
            runId: hitl.runId,
            data: { hitlRequestId: hitl.id, kind: "permission", via: "auto" },
          });
      }
    },
  });

  return true;
}

/** Do not release a run before its already accepted input ACK/handoff commits. */
export async function requireAgentPermissionCompletion(
  db: Db,
  command: Readonly<ExecutionCommand>,
): Promise<void> {
  const [run] = await db.select().from(runs).where(eq(runs.id, command.runId));

  if (
    !run ||
    !["Running", "NeedsInput", "NeedsInputIdle"].includes(run.status) ||
    run.executionAssignmentId !== command.executionAssignmentId
  )
    return;
  const [pending] = await db
    .select()
    .from(hitlRequests)
    .where(
      and(
        eq(hitlRequests.runId, command.runId),
        eq(hitlRequests.kind, "permission"),
        isNull(hitlRequests.respondedAt),
        sql`${hitlRequests.schema}->'agentPrompt'->>'commandId' = ${command.id}`,
      ),
    )
    .limit(1);

  if (!pending) return;
  const response = pending.response as Record<string, unknown> | null;
  const [checkpoint] = await db
    .select({ id: executionCommands.id })
    .from(executionCommands)
    .where(
      and(
        eq(executionCommands.runId, command.runId),
        eq(
          executionCommands.executionAssignmentId,
          command.executionAssignmentId,
        ),
        eq(executionCommands.targetSessionId, command.targetSessionId ?? ""),
        eq(executionCommands.kind, "session.checkpoint"),
      ),
    )
    .limit(1);

  if (
    response?._delivery !== undefined ||
    checkpoint ||
    run.status === "NeedsInputIdle"
  )
    throw new PromptOwnerDeferred("agent_permission_completion_pending");
}
