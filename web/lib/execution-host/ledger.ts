import type { Db } from "./db";
import type {
  ExecutionAssignment,
  ExecutionCommand,
  ExecutionHost,
} from "@/lib/db/schema";
import type {
  AssignmentId,
  CommandEnvelope,
  CommandId,
  CommandKind,
} from "./types";
import type { PromptOwner } from "./prompt-owner-contract";
import type { SendPromptInput } from "@/lib/supervisor-client";

import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import pino, { type Logger } from "pino";

import { canonicalCommandJson } from "../../../runtime/command-json";

import { isAdmissible } from "./assignments";
import { insertCommand, markFenced } from "./commands";
import { asAssignmentId, asCommandId } from "./types";
import { PromptOwnerSchema } from "./prompt-owner-contract";
import { readPromptRequest, storePromptRequest } from "./command-request";
import { redactPayload } from "./redact";

import { MaisterError } from "@/lib/errors";
import {
  executionAssignments,
  executionCommands,
  runs,
  runSessions,
  runSessionIncarnations,
} from "@/lib/db/schema";

const defaultLog = pino({
  name: "execution-host",
  level: process.env.LOG_LEVEL ?? "info",
}).child({ component: "ledger" });

export type IssueCommandInput<TPayload> = {
  assignment: ExecutionAssignment;
  host: ExecutionHost;
  kind: CommandKind;
  payload: TPayload;
  maxAttempts: number;
  targetSessionId?: string | null;
  driverless?: boolean;
  id?: CommandId | string;
  now?: Date;
  logger?: Logger;
};

export type IssuedCommand<TPayload> = {
  row: ExecutionCommand;
  envelope: CommandEnvelope<TPayload>;
};

export function buildEnvelope<TPayload>(args: {
  commandId: string;
  kind: CommandKind;
  hostKey: string;
  assignmentId: string;
  assignmentEpoch: number;
  runId: string;
  payload: TPayload;
  issuedAt?: Date;
}): CommandEnvelope<TPayload> {
  return {
    command: {
      id: asCommandId(args.commandId),
      kind: args.kind,
      issuedAt: (args.issuedAt ?? new Date()).toISOString(),
    },
    fence: {
      hostKey: args.hostKey,
      assignmentId: asAssignmentId(args.assignmentId),
      assignmentEpoch: args.assignmentEpoch,
      runId: args.runId,
    },
    payload: args.payload,
  };
}

function inputAction(payload: unknown): "select" | "cancel" | undefined {
  const action = (payload as { action?: unknown } | null)?.action;

  return action === "select" || action === "cancel" ? action : undefined;
}

export function fencedLocallyError(args: {
  runId: string;
  assignmentId: string;
  assignmentEpoch: number;
  state: string;
}): MaisterError {
  return new MaisterError(
    "CONFLICT",
    `assignment ${args.assignmentId} (epoch ${args.assignmentEpoch}) is ${args.state}; the command was fenced locally`,
    {
      details: {
        reason: "assignment_fenced",
        runId: args.runId,
        commandEpoch: args.assignmentEpoch,
        local: true,
      },
    },
  );
}

// ADR-166 E-EH-06: the `queued` row exists BEFORE any wire call, in the
// caller's transaction when one is passed. Admission by assignment state
// (D3): an inadmissible command is recorded and fenced locally — no wire call.
export async function issueCommand<TPayload>(
  db: Db,
  input: IssueCommandInput<TPayload>,
): Promise<IssuedCommand<TPayload>> {
  const logger = input.logger ?? defaultLog;
  const commandId = input.id ?? randomUUID();
  const row = await insertCommand(db, {
    id: commandId,
    runId: input.assignment.runId,
    assignmentId: input.assignment.id,
    hostId: input.host.id,
    assignmentEpoch: input.assignment.epoch,
    kind: input.kind,
    targetSessionId: input.targetSessionId ?? null,
    payload: input.payload,
    maxAttempts: input.maxAttempts,
    driverless: input.driverless ?? false,
    now: input.now,
  });

  logger.debug(
    {
      commandId,
      commandKind: input.kind,
      runId: input.assignment.runId,
      assignmentId: input.assignment.id,
      assignmentEpoch: input.assignment.epoch,
      hostKey: input.host.hostKey,
      driverless: input.driverless ?? false,
    },
    "command-queued",
  );

  if (
    !isAdmissible(input.kind, input.assignment.state, {
      inputAction: inputAction(input.payload),
    })
  ) {
    const err = fencedLocallyError({
      runId: input.assignment.runId,
      assignmentId: input.assignment.id,
      assignmentEpoch: input.assignment.epoch,
      state: input.assignment.state,
    });

    await markFenced(
      db,
      row.id,
      null,
      { code: "CONFLICT", reason: "assignment_fenced", local: true },
      { logger },
    );
    logger.error(
      {
        commandId,
        commandKind: input.kind,
        runId: input.assignment.runId,
        assignmentId: input.assignment.id,
        assignmentEpoch: input.assignment.epoch,
        state: input.assignment.state,
      },
      "command-fenced-locally",
    );

    throw err;
  }

  return {
    row,
    envelope: buildEnvelope({
      commandId,
      kind: input.kind,
      hostKey: input.host.hostKey,
      assignmentId: input.assignment.id,
      assignmentEpoch: input.assignment.epoch,
      runId: input.assignment.runId,
      payload: input.payload,
      issuedAt: row.createdAt,
    }),
  };
}

export type { AssignmentId };

export type PromptOwnerAdmission = Readonly<{
  owner: PromptOwner;
  logicalOperationKey: string;
}>;

function ownedPromptConflict(invariant: string): MaisterError {
  return new MaisterError(
    "CONFLICT",
    "prompt admission conflicts with its durable operation",
    {
      details: { reason: "command_invariant_conflict", invariant },
    },
  );
}

/** S2 owner adapters lock and validate their domain generation in admitOwner.
 * Its writes, routing locks, immutable request and owner reference commit in
 * one transaction. This dormant v2 entrypoint is activated after all adapters
 * have been migrated; it performs no remote I/O and allocates retry IDs only
 * after looking up the existing operation.
 */
export async function issueOwnedPrompt(
  db: Db,
  input: {
    assignment: ExecutionAssignment;
    host: ExecutionHost;
    targetSessionId: string;
    payload: SendPromptInput;
    maxAttempts: number;
    admitOwner: (tx: Db) => Promise<PromptOwnerAdmission>;
    now?: Date;
    logger?: Logger;
  },
): Promise<IssuedCommand<SendPromptInput>> {
  return db.transaction(async (tx) => {
    const admission = await input.admitOwner(tx);
    const parsed = PromptOwnerSchema.safeParse(admission.owner);

    if (
      !parsed.success ||
      admission.logicalOperationKey.length < 1 ||
      admission.logicalOperationKey.length > 256
    )
      throw ownedPromptConflict("owner_shape");
    const owner = parsed.data;
    const ref = owner.ref;
    const keyPrefix = `${owner.kind}:${ref.variant}:`;

    if (
      !admission.logicalOperationKey.startsWith(keyPrefix) ||
      admission.logicalOperationKey.length === keyPrefix.length
    )
      throw ownedPromptConflict("owner_key_namespace");

    if (
      ref.runId !== input.assignment.runId ||
      ref.assignmentId !== input.assignment.id ||
      ref.assignmentEpoch !== input.assignment.epoch ||
      input.host.id !== input.assignment.executionHostId
    )
      throw ownedPromptConflict("owner_binding");

    const [binding] = await tx
      .select({ incarnationId: runSessionIncarnations.id })
      .from(runs)
      .innerJoin(
        executionAssignments,
        eq(executionAssignments.id, runs.executionAssignmentId),
      )
      .innerJoin(runSessions, eq(runSessions.runId, runs.id))
      .innerJoin(
        runSessionIncarnations,
        eq(runSessionIncarnations.runSessionId, runSessions.id),
      )
      .where(
        and(
          eq(runs.id, ref.runId),
          eq(executionAssignments.id, ref.assignmentId),
          eq(executionAssignments.epoch, ref.assignmentEpoch),
          eq(executionAssignments.executionHostId, input.host.id),
          eq(executionAssignments.state, "active"),
          eq(runSessions.id, ref.runSessionId),
          eq(runSessions.executionAssignmentId, ref.assignmentId),
          eq(runSessions.hostSessionId, input.targetSessionId),
          eq(runSessionIncarnations.id, ref.incarnationId),
          eq(runSessionIncarnations.runId, ref.runId),
          eq(runSessionIncarnations.executionAssignmentId, ref.assignmentId),
          eq(runSessionIncarnations.assignmentEpoch, ref.assignmentEpoch),
          eq(runSessionIncarnations.executionHostId, input.host.id),
          eq(runSessionIncarnations.hostSessionId, input.targetSessionId),
          eq(runSessionIncarnations.state, "active"),
        ),
      )
      .for("update")
      .limit(1);

    if (!binding) throw ownedPromptConflict("inactive_incarnation");
    const [existing] = await tx
      .select()
      .from(executionCommands)
      .where(
        and(
          eq(executionCommands.runId, ref.runId),
          eq(executionCommands.kind, "session.prompt"),
          eq(
            executionCommands.logicalOperationKey,
            admission.logicalOperationKey,
          ),
        ),
      )
      .for("update")
      .limit(1);
    const commandId = existing?.id ?? randomUUID();
    const issuedAt = existing?.createdAt ?? input.now ?? new Date();
    const envelope = buildEnvelope({
      commandId,
      kind: "session.prompt",
      hostKey: input.host.hostKey,
      assignmentId: ref.assignmentId,
      assignmentEpoch: ref.assignmentEpoch,
      runId: ref.runId,
      payload: input.payload,
      issuedAt,
    });
    const request = storePromptRequest({
      envelope,
      targetSessionId: input.targetSessionId,
    });

    if (existing) {
      const frozen = readPromptRequest(existing, input.host.hostKey);

      if (
        existing.requestCanonicalJson !== request.requestCanonicalJson ||
        existing.ownerKind !== owner.kind ||
        canonicalCommandJson(existing.ownerRef) !== canonicalCommandJson(ref)
      )
        throw ownedPromptConflict("logical_operation_request_changed");

      (input.logger ?? defaultLog).debug(
        {
          commandId,
          ownerKind: owner.kind,
          ownerVariant: ref.variant,
          requestSchema: request.requestSchema,
          requestSha256: request.requestSha256,
        },
        "owned-prompt-reattached",
      );

      return {
        row: existing,
        envelope: {
          ...envelope,
          requestVersion: 2,
          target: frozen.target,
          payload: frozen.payload,
        },
      };
    }
    const [row] = await tx
      .insert(executionCommands)
      .values({
        id: commandId,
        runId: ref.runId,
        executionAssignmentId: ref.assignmentId,
        executionHostId: input.host.id,
        assignmentEpoch: ref.assignmentEpoch,
        kind: "session.prompt",
        targetSessionId: input.targetSessionId,
        payload: redactPayload("session.prompt", input.payload),
        ownerKind: owner.kind,
        ownerRef: ref,
        logicalOperationKey: admission.logicalOperationKey,
        ...request,
        maxAttempts: input.maxAttempts,
        createdAt: issuedAt,
        updatedAt: issuedAt,
      })
      .returning();
    const frozen = readPromptRequest(row, input.host.hostKey);

    (input.logger ?? defaultLog).debug(
      {
        commandId,
        ownerKind: owner.kind,
        ownerVariant: ref.variant,
        requestSchema: request.requestSchema,
        requestSha256: request.requestSha256,
      },
      "owned-prompt-admitted",
    );

    return {
      row,
      envelope: {
        ...envelope,
        requestVersion: 2,
        target: frozen.target,
        payload: frozen.payload,
      },
    };
  });
}
