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

import { randomUUID } from "node:crypto";

import pino, { type Logger } from "pino";

import { isAdmissible } from "./assignments";
import { insertCommand, markFenced } from "./commands";
import { asAssignmentId, asCommandId } from "./types";

import { MaisterError } from "@/lib/errors";

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

// ADR-165 E-EH-06: the `queued` row exists BEFORE any wire call, in the
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
