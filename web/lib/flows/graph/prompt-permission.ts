import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { BoundClient, SupervisorEvent } from "@/lib/execution-host";
import type { PreparedInput } from "@/lib/execution-host/client";
import type { NodePromptOwner } from "./node-prompt-owner";
import type { GatePromptOwner } from "./prompt-owner";

import { randomUUID } from "node:crypto";

import { and, desc, eq, isNull, sql, type SQL } from "drizzle-orm";
import { z } from "zod";

import { nodePromptOperationKey } from "./node-prompt-owner";
import { gatePromptOperationKey } from "./prompt-owner";
import { lockFlowPromptOwner } from "./prompt-owner-authority";

import {
  executionCommands,
  gateResults,
  hitlRequests,
  nodeAttempts,
  runs,
} from "@/lib/db/schema";
import { PromptOwnerInvariantError } from "@/lib/execution-host/prompt-owners";
import { nextKeepaliveAt } from "@/lib/runs/keepalive-config";
import {
  createHitlAssignmentForRun,
  completeHitlAssignmentFromCurrentActor,
} from "@/lib/assignments/service";
import { emitWebhookEvent } from "@/lib/webhooks/outbox";

const nodeSourceSchema = z
  .object({
    version: z.literal(1),
    commandId: z.string().min(1),
    nodeAttemptId: z.string().min(1),
    promptOrdinal: z.number().int().nonnegative(),
    assignmentId: z.string().min(1),
    incarnationId: z.string().min(1),
  })
  .strict();

const gateSourceSchema = nodeSourceSchema
  .extend({
    variant: z.enum(["gate_ai", "gate_skill"]),
    gateId: z.string().min(1),
    evaluationId: z.string().min(1),
  })
  .strict();
const sourceSchema = z.union([nodeSourceSchema, gateSourceSchema]);

export type FlowPermissionOwner = NodePromptOwner | GatePromptOwner;

type PermissionSource = z.infer<typeof sourceSchema>;
type PermissionEvent = Extract<
  SupervisorEvent,
  { type: "session.permission_request" }
>;

const permissionEnvelopeSchema = z.object({
  flowPrompt: sourceSchema,
  supervisorSessionId: z.string().min(1),
  requestId: z.string().min(1),
});

const deliveryIntentSchema = z
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

export async function prepareFlowPermissionInput(
  tx: Db,
  client: BoundClient,
  hitlRequestId: string,
): Promise<PreparedInput | null> {
  const [hitl] = await tx
    .select()
    .from(hitlRequests)
    .where(eq(hitlRequests.id, hitlRequestId));
  const schema = parseOwnedPermission(hitl?.schema);

  if (!hitl || !schema) return null;
  await assertFlowPermissionDelivery(tx, schema);
  const response = hitl.response as Record<string, unknown> | null;

  if (typeof response?.optionId !== "string")
    throw new PromptOwnerInvariantError("permission_choice_missing");
  if (response._delivery !== undefined) {
    const parsed = deliveryIntentSchema.safeParse(response._delivery);

    if (
      !parsed.success ||
      parsed.data.hostSessionId !== schema.supervisorSessionId ||
      parsed.data.payload.requestId !== schema.requestId ||
      parsed.data.payload.optionId !== response.optionId
    )
      throw new PromptOwnerInvariantError("permission_delivery_intent");

    return client.reattachPermissionInput(
      tx,
      parsed.data.commandId,
      parsed.data.hostSessionId,
      parsed.data.payload,
    );
  }
  const payload = {
    kind: "permission",
    action: "select",
    requestId: schema.requestId,
    optionId: response.optionId,
  } as const;
  const delivery = await client.prepareInput(
    tx,
    schema.supervisorSessionId,
    payload,
  );

  await tx
    .update(hitlRequests)
    .set({
      response: {
        ...response,
        _delivery: {
          commandId: delivery.commandId,
          hostSessionId: schema.supervisorSessionId,
          payload,
        },
      },
    })
    .where(eq(hitlRequests.id, hitl.id));

  return delivery;
}

/** An operator may retry a definitive service refusal with a fresh input
 * command. Unknown outcomes keep their original identity; background replay
 * never grants itself this new delivery decision.
 */
export async function prepareFlowPermissionResponse(
  tx: Db,
  client: BoundClient,
  hitlRequestId: string,
): Promise<PreparedInput | null> {
  const [hitl] = await tx
    .select()
    .from(hitlRequests)
    .where(eq(hitlRequests.id, hitlRequestId));
  const schema = parseOwnedPermission(hitl?.schema);
  const response = hitl?.response as Record<string, unknown> | null;

  if (hitl && schema && response?._delivery !== undefined) {
    await assertFlowPermissionDelivery(tx, schema);
    const parsed = deliveryIntentSchema.safeParse(response._delivery);

    if (!parsed.success)
      throw new PromptOwnerInvariantError("permission_delivery_intent");
    const intent = parsed.data;
    const [prior] = await tx
      .select()
      .from(executionCommands)
      .where(eq(executionCommands.id, intent.commandId));
    const details = prior?.lastError?.details as
      | Record<string, unknown>
      | undefined;

    if (
      prior?.state === "failed" &&
      prior.lastError?.code === "EXECUTOR_UNAVAILABLE" &&
      details?.httpStatus === 503
    ) {
      if (
        prior.runId !== hitl.runId ||
        prior.executionAssignmentId !== schema.flowPrompt.assignmentId ||
        prior.kind !== "session.input" ||
        prior.targetSessionId !== schema.supervisorSessionId ||
        prior.payload.requestId !== schema.requestId ||
        prior.payload.optionId !== response.optionId
      )
        throw new PromptOwnerInvariantError("permission_retry_identity");
      const { _delivery, ...retained } = response;

      void _delivery;

      await tx
        .update(hitlRequests)
        .set({
          response: {
            ...retained,
            _audit: {
              ...(typeof retained._audit === "object" &&
              retained._audit !== null
                ? retained._audit
                : {}),
              previousDeliveryCommandId: intent.commandId,
            },
          },
        })
        .where(eq(hitlRequests.id, hitl.id));
    }
  }

  return prepareFlowPermissionInput(tx, client, hitlRequestId);
}

function parseOwnedPermission(
  value: unknown,
): z.infer<typeof permissionEnvelopeSchema> | null {
  if (typeof value !== "object" || value === null || !("flowPrompt" in value))
    return null;
  const parsed = permissionEnvelopeSchema.safeParse(value);

  if (!parsed.success)
    throw new PromptOwnerInvariantError("permission_source_shape");

  return parsed.data;
}

export function openNodePromptExists(): SQL {
  return sql`exists (
    select 1 from node_attempts permission_attempt
    join execution_commands permission_prompt on permission_prompt.run_id = permission_attempt.run_id
      and permission_prompt.owner_ref->>'nodeAttemptId' = permission_attempt.id
      and permission_prompt.owner_ref->>'promptOrdinal' = permission_attempt.action_prompt_ordinal::text
    where permission_attempt.run_id = ${runs.id}
      and permission_attempt.node_id = ${runs.currentStepId}
      and permission_attempt.execution_assignment_id = ${runs.executionAssignmentId}
      and permission_attempt.status = 'Running' and permission_attempt.ended_at is null
      and permission_attempt.finish_continuation is null
      and permission_prompt.execution_assignment_id = ${runs.executionAssignmentId}
      and permission_prompt.kind = 'session.prompt'
      and permission_prompt.owner_kind = 'flow_node_attempt'
      and permission_prompt.owner_ref->>'variant' = 'node'
      and (permission_attempt.action_completion is null or exists (
        select 1 from hitl_requests permission_hitl
        where permission_hitl.run_id = ${runs.id} and permission_hitl.kind = 'permission'
          and permission_hitl.schema->'flowPrompt'->>'commandId' = permission_prompt.id
          and permission_hitl.responded_at is null
      ))
  )`;
}

export function openGatePromptExists(): SQL {
  return sql`exists (
    select 1 from node_attempts permission_attempt
    join gate_results permission_gate on permission_gate.node_attempt_id = permission_attempt.id
      and permission_gate.run_id = permission_attempt.run_id
    join execution_commands permission_prompt on permission_prompt.run_id = permission_attempt.run_id
      and permission_prompt.owner_ref->>'nodeAttemptId' = permission_attempt.id
      and permission_prompt.owner_ref->>'evaluationId' = permission_gate.id
      and permission_prompt.owner_ref->>'gateId' = permission_gate.gate_id
    where permission_attempt.run_id = ${runs.id}
      and permission_attempt.node_id = ${runs.currentStepId}
      and permission_attempt.execution_assignment_id = ${runs.executionAssignmentId}
      and permission_attempt.status in ('Running', 'Succeeded')
      and permission_attempt.finish_continuation is null
      and permission_prompt.execution_assignment_id = ${runs.executionAssignmentId}
      and permission_prompt.kind = 'session.prompt'
      and permission_prompt.owner_kind = 'flow_node_attempt'
      and ((permission_prompt.owner_ref->>'variant' = 'gate_ai' and permission_gate.kind = 'ai_judgment')
        or (permission_prompt.owner_ref->>'variant' = 'gate_skill' and permission_gate.kind = 'skill_check'))
      and permission_gate.status in ('running', 'passed', 'failed')
      and not exists (
        select 1 from gate_results newer_gate
        where newer_gate.run_id = permission_gate.run_id
          and newer_gate.node_attempt_id = permission_gate.node_attempt_id
          and newer_gate.gate_id = permission_gate.gate_id
          and (newer_gate.created_at, newer_gate.id) > (permission_gate.created_at, permission_gate.id)
      )
      and (permission_gate.status = 'running' or exists (
        select 1 from hitl_requests permission_hitl
        where permission_hitl.run_id = ${runs.id} and permission_hitl.kind = 'permission'
          and permission_hitl.schema->'flowPrompt'->>'commandId' = permission_prompt.id
          and permission_hitl.responded_at is null
      ))
  )`;
}

export function openFlowPromptExists(): SQL {
  return sql`(${openNodePromptExists()} or ${openGatePromptExists()})`;
}

export async function hasOpenNodePrompt(
  db: Db,
  runId: string,
): Promise<boolean> {
  const [run] = await db
    .select({ id: runs.id })
    .from(runs)
    .where(and(eq(runs.id, runId), openNodePromptExists()));

  return run !== undefined;
}

export async function hasOpenGatePrompt(
  db: Db,
  runId: string,
): Promise<boolean> {
  const [run] = await db
    .select({ id: runs.id })
    .from(runs)
    .where(and(eq(runs.id, runId), openGatePromptExists()));

  return run !== undefined;
}

export async function hasPendingFlowPermission(
  db: Db,
  runId: string,
  commandId: string,
): Promise<boolean> {
  const [pending] = await db
    .select({ id: hitlRequests.id })
    .from(hitlRequests)
    .where(
      and(
        eq(hitlRequests.runId, runId),
        eq(hitlRequests.kind, "permission"),
        sql`${hitlRequests.schema}->'flowPrompt'->>'commandId' = ${commandId}`,
        isNull(hitlRequests.respondedAt),
      ),
    )
    .limit(1);

  return pending !== undefined;
}

/** A permission belongs to one accepted turn. A run/step match alone cannot
 * authorize a replayed answer or move the graph out of NeedsInput.
 */
async function lockPermissionSource(
  tx: Db,
  source: PermissionSource,
  hostSessionId: string,
): Promise<void> {
  const [command] = await tx
    .select()
    .from(executionCommands)
    .where(eq(executionCommands.id, source.commandId));
  const ref = command?.ownerRef;

  if (
    !command ||
    command.kind !== "session.prompt" ||
    command.ownerKind !== "flow_node_attempt" ||
    !ref ||
    !("nodeAttemptId" in ref) ||
    !("promptOrdinal" in ref) ||
    (ref.variant !== "node" &&
      ref.variant !== "gate_ai" &&
      ref.variant !== "gate_skill") ||
    ("variant" in source
      ? ref.variant !== source.variant ||
        !("evaluationId" in ref) ||
        ref.evaluationId !== source.evaluationId ||
        ref.gateId !== source.gateId
      : ref.variant !== "node") ||
    ref.nodeAttemptId !== source.nodeAttemptId ||
    ref.promptOrdinal !== source.promptOrdinal ||
    ref.assignmentId !== source.assignmentId ||
    ref.incarnationId !== source.incarnationId ||
    command.executionAssignmentId !== source.assignmentId ||
    command.targetSessionId !== hostSessionId ||
    !(await lockFlowPromptOwner(tx, ref, hostSessionId))
  )
    throw new PromptOwnerInvariantError("permission_source_generation");
  const [row] = await tx
    .select({ attempt: nodeAttempts, run: runs })
    .from(nodeAttempts)
    .innerJoin(runs, eq(runs.id, nodeAttempts.runId))
    .where(eq(nodeAttempts.id, source.nodeAttemptId))
    .for("update");

  if (
    !row ||
    row.run.id !== command.runId ||
    row.run.runKind !== "flow" ||
    !["Running", "NeedsInput"].includes(row.run.status) ||
    row.run.currentStepId !== row.attempt.nodeId ||
    row.attempt.executionAssignmentId !== source.assignmentId ||
    row.attempt.finishContinuation !== null
  )
    throw new PromptOwnerInvariantError("permission_attempt_generation");
  if ("variant" in source) {
    const [evaluation] = await tx
      .select()
      .from(gateResults)
      .where(
        and(
          eq(gateResults.runId, command.runId),
          eq(gateResults.nodeAttemptId, source.nodeAttemptId),
          eq(gateResults.gateId, source.gateId),
        ),
      )
      .orderBy(desc(gateResults.createdAt), desc(gateResults.id))
      .limit(1)
      .for("update");

    if (
      !["Running", "Succeeded"].includes(row.attempt.status) ||
      !evaluation ||
      evaluation.id !== source.evaluationId ||
      evaluation.kind !==
        (source.variant === "gate_skill" ? "skill_check" : "ai_judgment") ||
      !["running", "passed", "failed"].includes(evaluation.status)
    )
      throw new PromptOwnerInvariantError("permission_evaluation_generation");
  } else if (
    !["Running", "NeedsInput"].includes(row.attempt.status) ||
    row.attempt.actionPromptOrdinal !== source.promptOrdinal ||
    row.attempt.endedAt !== null
  )
    throw new PromptOwnerInvariantError("permission_attempt_generation");
}

export async function assertFlowPermissionDelivery(
  tx: Db,
  schema: unknown,
): Promise<void> {
  const parsed = parseOwnedPermission(schema);

  if (!parsed) return;
  await lockPermissionSource(tx, parsed.flowPrompt, parsed.supervisorSessionId);
}

/** Called inside the session.input ACK transaction, after respondedAt. The
 * exact delivery identity and the graph wake commit with the command receipt.
 */
export async function completeFlowPermissionDelivery(
  tx: Db,
  hitlRequestId: string,
  deliveryCommandId: string,
): Promise<void> {
  const [hitl] = await tx
    .select()
    .from(hitlRequests)
    .where(eq(hitlRequests.id, hitlRequestId));

  const schema = parseOwnedPermission(hitl?.schema);

  if (!hitl || !schema) return;
  const priorResponse = hitl.response as Record<string, unknown> | null;
  const priorAudit = priorResponse?._audit as
    | Record<string, unknown>
    | undefined;

  if (
    hitl.respondedAt &&
    priorAudit?.deliveryCommandId === deliveryCommandId &&
    priorAudit.sourceCommandId === schema.flowPrompt.commandId &&
    priorAudit.assignmentId === schema.flowPrompt.assignmentId &&
    priorAudit.incarnationId === schema.flowPrompt.incarnationId &&
    priorAudit.requestId === schema.requestId
  )
    return;
  await assertFlowPermissionDelivery(tx, schema);
  const source = schema.flowPrompt;
  const [delivery] = await tx
    .select()
    .from(executionCommands)
    .where(eq(executionCommands.id, deliveryCommandId));
  const response = hitl.response as Record<string, unknown> | null;

  if (
    !hitl.respondedAt ||
    !response ||
    !delivery ||
    delivery.state !== "succeeded" ||
    delivery.kind !== "session.input" ||
    delivery.runId !== hitl.runId ||
    delivery.executionAssignmentId !== source.assignmentId ||
    delivery.targetSessionId !== schema.supervisorSessionId ||
    delivery.payload.requestId !== schema.requestId ||
    delivery.payload.optionId !== response.optionId
  )
    throw new PromptOwnerInvariantError("permission_delivery_identity");
  await tx
    .update(hitlRequests)
    .set({
      response: {
        ...response,
        _audit: {
          ...(typeof response._audit === "object" && response._audit !== null
            ? response._audit
            : {}),
          deliveryCommandId,
          sourceCommandId: source.commandId,
          assignmentId: source.assignmentId,
          incarnationId: source.incarnationId,
          requestId: schema.requestId,
        },
      },
    })
    .where(eq(hitlRequests.id, hitl.id));
  const [pending] = await tx
    .select({ id: hitlRequests.id })
    .from(hitlRequests)
    .where(
      and(
        eq(hitlRequests.runId, hitl.runId),
        eq(hitlRequests.kind, "permission"),
        sql`${hitlRequests.schema}->'flowPrompt'->>'commandId' = ${source.commandId}`,
        isNull(hitlRequests.respondedAt),
      ),
    )
    .limit(1);

  if (!pending)
    await tx
      .update(runs)
      .set({ status: "Running" })
      .where(
        and(
          eq(runs.id, hitl.runId),
          eq(runs.status, "NeedsInput"),
          eq(runs.executionAssignmentId, source.assignmentId),
        ),
      );
}

export async function handleFlowPermission(input: {
  db: Db;
  client: BoundClient;
  owner: FlowPermissionOwner;
  hostSessionId: string;
  stepId: string;
  event: PermissionEvent;
  prompt: string;
}): Promise<void> {
  const { db, client, owner, event, hostSessionId } = input;
  const runId = client.assignment.runId;
  const prepared = await db.transaction(async (tx) => {
    const [command] = await tx
      .select()
      .from(executionCommands)
      .where(
        and(
          eq(executionCommands.runId, runId),
          eq(
            executionCommands.logicalOperationKey,
            owner.variant === "node"
              ? nodePromptOperationKey(owner)
              : gatePromptOperationKey(owner),
          ),
        ),
      );
    const ref = command?.ownerRef;

    if (!command || !ref || !("incarnationId" in ref))
      throw new PromptOwnerInvariantError("permission_source_missing");
    const source: PermissionSource = {
      version: 1,
      commandId: command.id,
      nodeAttemptId: owner.nodeAttemptId,
      promptOrdinal: owner.variant === "node" ? owner.promptOrdinal : 0,
      assignmentId: client.assignment.id,
      incarnationId: ref.incarnationId,
      ...(owner.variant === "node"
        ? {}
        : {
            variant: owner.variant,
            gateId: owner.gateId,
            evaluationId: owner.evaluationId,
          }),
    };

    await lockPermissionSource(tx, source, hostSessionId);
    const [existing] = await tx
      .select()
      .from(hitlRequests)
      .where(
        and(
          eq(hitlRequests.runId, runId),
          eq(hitlRequests.kind, "permission"),
          sql`${hitlRequests.schema}->'flowPrompt'->>'commandId' = ${command.id}`,
          sql`${hitlRequests.schema}->>'requestId' = ${event.requestId}`,
        ),
      )
      .for("update")
      .limit(1);

    if (existing?.respondedAt) return null;
    const hitlRequestId = existing?.id ?? randomUUID();

    if (!existing) {
      await tx.insert(hitlRequests).values({
        id: hitlRequestId,
        runId,
        stepId: input.stepId,
        kind: "permission",
        prompt: input.prompt,
        schema: {
          requestId: event.requestId,
          options: event.options,
          toolCall: event.toolCall,
          supervisorSessionId: hostSessionId,
          flowPrompt: source,
        },
      });
      await createHitlAssignmentForRun({
        db: tx,
        runId,
        hitlRequestId,
        stepId: input.stepId,
        actionKind: "permission",
        roleRefs: [],
        title: input.prompt,
      });
    }
    const [run] = await tx
      .select({ projectId: runs.projectId })
      .from(runs)
      .where(eq(runs.id, runId));

    if (!run?.projectId)
      throw new PromptOwnerInvariantError("permission_project_missing");
    const changed = await tx
      .update(runs)
      .set({ status: "NeedsInput", keepaliveUntil: nextKeepaliveAt() })
      .where(and(eq(runs.id, runId), eq(runs.status, "Running")))
      .returning({ id: runs.id });

    if (!existing)
      await emitWebhookEvent({
        db: tx,
        type: "hitl.requested",
        projectId: run.projectId,
        runId,
        data: { hitlRequestId, kind: "permission", nodeId: null },
      });
    if (changed.length > 0)
      await emitWebhookEvent({
        db: tx,
        type: "run.needs_input",
        projectId: run.projectId,
        runId,
        data: { reason: "permission", nodeId: null },
      });
    const optionId = (existing?.response as { optionId?: string } | null)
      ?.optionId;

    if (!optionId) return null;
    if (!event.options.some((option) => option.optionId === optionId))
      throw new PromptOwnerInvariantError("permission_replay_option");
    const delivery = await prepareFlowPermissionInput(
      tx,
      client,
      hitlRequestId,
    );

    if (!delivery)
      throw new PromptOwnerInvariantError("permission_delivery_intent_missing");

    return { delivery, hitlRequestId, optionId, projectId: run.projectId };
  });

  if (!prepared) return;
  await deliverPreparedFlowPermission(db, runId, prepared);
}

type PreparedFlowPermissionDelivery = Readonly<{
  delivery: PreparedInput;
  hitlRequestId: string;
  optionId: string;
  projectId: string;
}>;

async function deliverPreparedFlowPermission(
  db: Db,
  runId: string,
  prepared: PreparedFlowPermissionDelivery,
): Promise<void> {
  await prepared.delivery.deliver({
    onAck: async (tx) => {
      const stamped = await tx
        .update(hitlRequests)
        .set({ respondedAt: new Date() })
        .where(
          and(
            eq(hitlRequests.id, prepared.hitlRequestId),
            isNull(hitlRequests.respondedAt),
          ),
        )
        .returning({ id: hitlRequests.id });

      await completeFlowPermissionDelivery(
        tx,
        prepared.hitlRequestId,
        prepared.delivery.commandId,
      );
      if (stamped.length > 0)
        await emitWebhookEvent({
          db: tx,
          type: "hitl.responded",
          projectId: prepared.projectId,
          runId,
          data: {
            hitlRequestId: prepared.hitlRequestId,
            kind: "permission",
            via: "auto",
          },
        });
    },
  });
  await completeHitlAssignmentFromCurrentActor({
    db,
    hitlRequestId: prepared.hitlRequestId,
    eventKind: "responded",
    payload: {
      optionId: prepared.optionId,
      deliveryCommandId: prepared.delivery.commandId,
    },
  });
}

/** A completed prompt may return before its replay stream starts. Reconcile
 * already admitted inputs directly so that fast return cannot starve delivery.
 * Responses without an admitted command still wait for the permission event.
 */
export async function replayAdmittedFlowPermissionInputs(
  db: Db,
  client: BoundClient,
  commandId: string,
): Promise<void> {
  const runId = client.assignment.runId;
  const candidates = await db
    .select({ id: hitlRequests.id })
    .from(hitlRequests)
    .where(
      and(
        eq(hitlRequests.runId, runId),
        eq(hitlRequests.kind, "permission"),
        sql`${hitlRequests.schema}->'flowPrompt'->>'commandId' = ${commandId}`,
        sql`${hitlRequests.response}->'_delivery' IS NOT NULL`,
        isNull(hitlRequests.respondedAt),
      ),
    );

  for (const candidate of candidates) {
    const prepared = await db.transaction(
      async (tx): Promise<PreparedFlowPermissionDelivery | null> => {
        const [source] = await tx
          .select()
          .from(hitlRequests)
          .where(eq(hitlRequests.id, candidate.id));

        if (!source || source.respondedAt) return null;
        // Acquire run/assignment authority before any HITL row lock, matching
        // concurrent user responses and the input ACK transaction.
        await assertFlowPermissionDelivery(tx, source.schema);
        const [current] = await tx
          .select()
          .from(hitlRequests)
          .where(eq(hitlRequests.id, candidate.id))
          .for("update");
        const response = current?.response as Record<string, unknown> | null;

        if (
          !current ||
          current.respondedAt ||
          response?._delivery === undefined
        )
          return null;
        if (typeof response.optionId !== "string")
          throw new PromptOwnerInvariantError("permission_choice_missing");
        const delivery = await prepareFlowPermissionInput(
          tx,
          client,
          current.id,
        );
        const [run] = await tx
          .select({ projectId: runs.projectId })
          .from(runs)
          .where(eq(runs.id, runId));

        if (!delivery || !run?.projectId)
          throw new PromptOwnerInvariantError(
            "permission_delivery_intent_missing",
          );

        return {
          delivery,
          hitlRequestId: current.id,
          optionId: response.optionId,
          projectId: run.projectId,
        };
      },
    );

    if (prepared) await deliverPreparedFlowPermission(db, runId, prepared);
  }
}
