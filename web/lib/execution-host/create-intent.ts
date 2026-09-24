import "server-only";

import type { Db } from "./db";
import type { ExecutionCommand } from "@/lib/db/schema";
import type { CreateSessionPayload } from "./contracts";
import type { CommandEnvelope } from "./types";

import { createHash } from "node:crypto";

import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";

import { canonicalCommandJson } from "../../../runtime/command-json";

import { lockCurrentSessionAssignment } from "./session-binding";
import { redactPayload } from "./redact";
import {
  assertAgentResumeTurn,
  assertAgentResumeCreateRequest,
} from "./agent-permission-handoff";

import {
  executionCommands,
  gateResults,
  nodeAttempts,
  runs,
  agentTurns,
} from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import {
  assertNodePermissionContinuation,
  assertGatePermissionContinuation,
} from "@/lib/execution-host/permission-handoff-source";

const id = z.string().min(1).max(128);

export const FlowCreateOwnerSchema = z.discriminatedUnion("variant", [
  z
    .object({
      variant: z.literal("node"),
      nodeAttemptId: id,
      promptOrdinal: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      variant: z.literal("gate_ai"),
      nodeAttemptId: id,
      gateId: id,
      evaluationId: id,
    })
    .strict(),
  z
    .object({
      variant: z.literal("gate_skill"),
      nodeAttemptId: id,
      gateId: id,
      evaluationId: id,
    })
    .strict(),
]);
export type FlowCreateOwner = z.infer<typeof FlowCreateOwnerSchema>;
const SessionCreateOwnerSchema = z.discriminatedUnion("variant", [
  ...FlowCreateOwnerSchema.options,
  z
    .object({
      variant: z.literal("agent"),
      turnId: id,
      promptOrdinal: z.number().int().nonnegative(),
    })
    .strict(),
]);

export type SessionCreateOwner = z.infer<typeof SessionCreateOwnerSchema>;
const CreateIntentSchema = z
  .object({
    version: z.literal(1),
    owner: SessionCreateOwnerSchema,
    operationKey: z.string().min(1).max(256),
    generation: z.number().int().nonnegative(),
    supersedesCommandId: id.nullable(),
    sessionFallback: z.boolean(),
    requestCanonicalJson: z.string().min(1),
    requestSha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

export type SessionCreateIntent = z.infer<typeof CreateIntentSchema>;

export function createIntentError(invariant: string): MaisterError {
  return new MaisterError(
    "CONFLICT",
    "session creation intent failed validation",
    {
      details: { reason: "command_invariant_conflict", invariant },
    },
  );
}

export function createOperationKey(owner: SessionCreateOwner): string {
  if (owner.variant === "agent")
    return `agent-create:${owner.turnId}:${owner.promptOrdinal}`;

  return owner.variant === "node"
    ? `flow-create:node:${owner.nodeAttemptId}:${owner.promptOrdinal}`
    : `flow-create:${owner.variant}:${owner.evaluationId}`;
}

export function storeCreateIntent(input: {
  owner: SessionCreateOwner;
  generation: number;
  supersedesCommandId: string | null;
  sessionFallback: boolean;
  envelope: CommandEnvelope<CreateSessionPayload>;
}): SessionCreateIntent {
  // The typed caller constructs the private payload before transport. JSON
  // wire normalization removes optional undefined fields only once.
  const requestCanonicalJson = canonicalCommandJson(
    JSON.parse(JSON.stringify(input.envelope)),
  );
  const parsed = CreateIntentSchema.safeParse({
    version: 1,
    owner: input.owner,
    operationKey: createOperationKey(input.owner),
    generation: input.generation,
    supersedesCommandId: input.supersedesCommandId,
    sessionFallback: input.sessionFallback,
    requestCanonicalJson,
    requestSha256: createHash("sha256")
      .update(requestCanonicalJson)
      .digest("hex"),
  });

  if (!parsed.success) throw createIntentError("create_intent_shape");

  return parsed.data;
}

export function readCreateIntent(
  row: ExecutionCommand,
  hostKey: string,
): {
  intent: SessionCreateIntent;
  envelope: CommandEnvelope<CreateSessionPayload>;
} {
  const parsed = CreateIntentSchema.safeParse(row.createIntent);

  if (!parsed.success) throw createIntentError("create_intent_shape");
  const intent = parsed.data;

  if (
    createHash("sha256").update(intent.requestCanonicalJson).digest("hex") !==
    intent.requestSha256
  )
    throw createIntentError("create_request_digest");
  let envelope: CommandEnvelope<CreateSessionPayload>;

  try {
    envelope = JSON.parse(
      intent.requestCanonicalJson,
    ) as CommandEnvelope<CreateSessionPayload>;
  } catch (error) {
    if (error instanceof SyntaxError)
      throw createIntentError("create_request_json");
    throw error;
  }
  if (
    canonicalCommandJson(envelope) !== intent.requestCanonicalJson ||
    intent.operationKey !== createOperationKey(intent.owner) ||
    row.kind !== "session.create" ||
    envelope?.command?.id !== row.id ||
    envelope.command.kind !== row.kind ||
    envelope.command.issuedAt !== row.createdAt.toISOString() ||
    envelope.fence?.runId !== row.runId ||
    envelope.fence.hostKey !== hostKey ||
    envelope.fence.assignmentId !== row.executionAssignmentId ||
    envelope.fence.assignmentEpoch !== row.assignmentEpoch ||
    (envelope.payload?.nodeAttemptId ?? null) !==
      (intent.owner.variant === "agent" ? null : intent.owner.nodeAttemptId) ||
    canonicalCommandJson(redactPayload("session.create", envelope.payload)) !==
      canonicalCommandJson(row.payload)
  )
    throw createIntentError("create_request_binding");

  return { intent, envelope };
}

export async function latestOwnedCreate(
  tx: Db,
  input: {
    runId: string;
    assignmentId: string;
    owner: SessionCreateOwner;
  },
): Promise<ExecutionCommand | undefined> {
  const [row] = await tx
    .select()
    .from(executionCommands)
    .where(
      and(
        eq(executionCommands.runId, input.runId),
        eq(executionCommands.executionAssignmentId, input.assignmentId),
        eq(executionCommands.kind, "session.create"),
        sql`${executionCommands.createIntent}->>'operationKey' = ${createOperationKey(input.owner)}`,
      ),
    )
    .orderBy(
      desc(sql`(${executionCommands.createIntent}->>'generation')::integer`),
    )
    .limit(1);

  return row;
}

/** Which question the owner check answers. `create`: may this owner open a
 * session now — only a Running run may, or a node/gate continuing a permission
 * answer. `ack`: is a session the host already made still this owner's? A run
 * or attempt paused for an answer (permission, hook trip, interrupt) still owns
 * it: the prompt was admitted on it and the turn resumes there. Asking the
 * `create` question of an acknowledgement read that pause as a moved owner and
 * marked a live, admitted session `lost`. */
export type CreateOwnerCheck = "create" | "ack";

const PAUSED_OWNER_RUN_STATUSES: ReadonlySet<string> = new Set([
  "NeedsInput",
  "NeedsInputIdle",
]);

/** Run-first locks serialize creation with domain claims. A create receipt
 * remains historical after its exact visit/evaluation stops owning the cursor.
 */
export async function lockCreateOwner(
  tx: Db,
  input: {
    runId: string;
    assignmentId: string;
    owner: SessionCreateOwner;
  },
  check: CreateOwnerCheck,
): Promise<boolean> {
  const assignment = await lockCurrentSessionAssignment(tx, input);

  if (!assignment) return false;
  const [run] = await tx.select().from(runs).where(eq(runs.id, input.runId));

  if (input.owner.variant === "agent") {
    const [turn] = await tx
      .select()
      .from(agentTurns)
      .where(eq(agentTurns.id, input.owner.turnId))
      .for("update");

    const current =
      run?.runKind === "agent" &&
      (run.status === "Running" ||
        (check === "ack" && PAUSED_OWNER_RUN_STATUSES.has(run.status))) &&
      turn?.runId === run.id &&
      turn.ordinal === input.owner.promptOrdinal &&
      turn.executionAssignmentId === assignment.id &&
      turn.assignmentEpoch === assignment.epoch &&
      (turn.state === "claimed" || turn.state === "dispatched");

    if (current) await assertAgentResumeTurn(tx, turn, assignment);

    return current;
  }
  const [attempt] = await tx
    .select()
    .from(nodeAttempts)
    .where(eq(nodeAttempts.id, input.owner.nodeAttemptId))
    .for("update");
  const resume = attempt?.actionResume;
  const permissionResume =
    input.owner.variant === "node" &&
    resume?.kind === "permission" &&
    resume.assignmentId === input.assignmentId &&
    resume.promptOrdinal === input.owner.promptOrdinal;

  if (
    !run ||
    run.runKind !== "flow" ||
    !(
      run.status === "Running" ||
      (check === "ack" && PAUSED_OWNER_RUN_STATUSES.has(run.status)) ||
      (run.status === "NeedsInput" &&
        (permissionResume || input.owner.variant !== "node"))
    ) ||
    !attempt ||
    attempt.runId !== run.id ||
    attempt.executionAssignmentId !== input.assignmentId ||
    run.currentStepId !== attempt.nodeId ||
    attempt.finishContinuation !== null
  )
    return false;
  if (input.owner.variant === "node") {
    await assertNodePermissionContinuation(tx, attempt, assignment);

    return (
      (attempt.status === "Running" ||
        (check === "ack" && attempt.status === "NeedsInput")) &&
      attempt.endedAt === null &&
      ["ai_coding", "judge", "orchestrator"].includes(attempt.nodeType) &&
      attempt.actionPromptOrdinal === input.owner.promptOrdinal &&
      attempt.actionCompletion === null
    );
  }
  if (
    !["Running", "Succeeded"].includes(attempt.status) &&
    !(check === "ack" && attempt.status === "NeedsInput")
  )
    return false;
  const [evaluation] = await tx
    .select()
    .from(gateResults)
    .where(
      and(
        eq(gateResults.runId, run.id),
        eq(gateResults.nodeAttemptId, attempt.id),
        eq(gateResults.gateId, input.owner.gateId),
      ),
    )
    .orderBy(desc(gateResults.createdAt), desc(gateResults.id))
    .limit(1)
    .for("update");

  if (evaluation?.permissionResume?.kind === "permission_continue")
    await assertGatePermissionContinuation(tx, evaluation, assignment.id);

  return (
    evaluation?.id === input.owner.evaluationId &&
    evaluation.status === "running" &&
    (run.status === "Running" ||
      (check === "ack" && PAUSED_OWNER_RUN_STATUSES.has(run.status)) ||
      evaluation.permissionResume?.assignmentId === input.assignmentId) &&
    evaluation.kind ===
      (input.owner.variant === "gate_ai" ? "ai_judgment" : "skill_check")
  );
}

/** An unowned create has no generation, so its recency is its place among the
 * unowned creates of the same logical session on the same assignment. Applying
 * an older one's acknowledgement after a newer one bound would retire the live
 * successor (same-epoch supersession) and re-point the binding to the orphan. */
async function newestUnownedCreate(
  tx: Db,
  row: ExecutionCommand,
): Promise<boolean> {
  const [newest] = await tx
    .select({ id: executionCommands.id })
    .from(executionCommands)
    .where(
      and(
        eq(executionCommands.runId, row.runId),
        eq(executionCommands.executionAssignmentId, row.executionAssignmentId),
        eq(executionCommands.kind, "session.create"),
        isNull(executionCommands.createIntent),
        sql`coalesce(${executionCommands.payload}->>'sessionName', 'default') = ${row.payload.sessionName ?? "default"}`,
      ),
    )
    .orderBy(desc(executionCommands.createdAt), desc(executionCommands.id))
    .limit(1);

  return newest?.id === row.id;
}

export async function currentCreateCommand(
  tx: Db,
  row: ExecutionCommand,
): Promise<boolean> {
  if (!row.createIntent) return newestUnownedCreate(tx, row);
  const parsed = CreateIntentSchema.safeParse(row.createIntent);

  if (!parsed.success) throw createIntentError("create_intent_shape");
  const input = {
    runId: row.runId,
    assignmentId: row.executionAssignmentId,
    owner: parsed.data.owner,
  };

  if (!(await lockCreateOwner(tx, input, "ack"))) return false;
  if (input.owner.variant === "agent")
    await assertAgentResumeCreateRequest(tx, input.owner.turnId, row.payload);

  return (await latestOwnedCreate(tx, input))?.id === row.id;
}
