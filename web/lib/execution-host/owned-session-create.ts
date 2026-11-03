import "server-only";

import type { Db } from "./db";
import type { BoundClient } from "./client";
import type {
  CommandReceipt,
  CreateSessionPayload,
  ExecutionHostTransport,
} from "./contracts";
import type { CreateSessionResult } from "@/lib/supervisor-client";
import type { ExecutionCommand } from "@/lib/db/schema";
import type { SessionCreateOwner } from "./create-intent";
import type { HostSessionId } from "./types";
import type { Logger } from "pino";

import { randomUUID } from "node:crypto";

import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";

import { hasSessionCreateQuiescence } from "../../../runtime/session-create-quiescence";

import { assertAgentResumeCreateRequest } from "./agent-permission-handoff";
import {
  createIntentError,
  createOperationKey,
  latestOwnedCreate,
  lockCreateOwner,
  readCreateIntent,
  storeCreateIntent,
} from "./create-intent";
import {
  COMMAND_POLICY,
  deliverCommand,
  isFencedError,
  isUnknownOutcome,
} from "./deliverer";
import { applyCreateAck } from "./create-ack";
import { hostPressuredError, isHostPressureRefusal } from "./host-pressure";
import { buildEnvelope, issueCommand } from "./ledger";
import { lockConsensusDraftCommandAdmission } from "./consensus-command-admission";
import { casTransition, markFailed, requeueDelivering } from "./commands";
import { ensureSessionOutputIntents } from "./session-output-intents";
import { isReadoptableWorkspaceError } from "./adoption";
import {
  createContinuationObjectIds,
  type OwnedCreateContinuation,
} from "./create-continuation";
import { assertRuntimeObjectsReferenceable } from "./runtime-object-holds";
import { staleSessionBinding } from "./session-binding";
import { asHostSessionId } from "./types";
import { projectPrivateCreateFailure } from "./private-create-failure";

import { executionCommands, gateResults, nodeAttempts } from "@/lib/db/schema";
import { isMaisterError, MaisterError } from "@/lib/errors";
import { isTurnLostError } from "@/lib/reconcile-evidence";
import { isMaisterErrorCode } from "@/lib/errors-core";
import { pgErrorOf } from "@/lib/db/pg-error";

export type OwnedSessionOptions = Readonly<{
  assertCommit?: (tx: Db) => Promise<void>;
  prepareContinuation?: () => Promise<OwnedCreateContinuation>;
}>;
export type { OwnedCreateContinuation } from "./create-continuation";

/** Server-only replay source. Its prompt and runtime configuration must never
 * enter a public receipt, DTO or diagnostic log.
 */
export async function readOwnedCreateContinuation(
  db: Db,
  client: BoundClient,
  owner: SessionCreateOwner,
): Promise<OwnedCreateContinuation | null> {
  return db
    .transaction(async (tx) => {
      const authority = {
        runId: client.assignment.runId,
        assignmentId: client.assignment.id,
        owner,
      };

      if (!(await lockCreateOwner(tx, authority, "create")))
        throw staleSessionBinding(authority.runId, authority.assignmentId);
      const original = await latestOwnedCreate(tx, authority);

      if (!original) return null;
      const { intent } = readCreateIntent(original, client.host.hostKey);

      if (
        !(await lockCreateOwner(
          tx,
          { ...authority, owner: intent.owner },
          "create",
        ))
      )
        throw staleSessionBinding(authority.runId, authority.assignmentId);

      return intent.continuation ?? null;
    })
    .catch((error: unknown) => {
      throw privateCreateFailure(error, client);
    });
}
export class SessionCreatePending extends MaisterError {
  constructor(
    commandId: string | null,
    cause?: unknown,
    operationKey?: string,
  ) {
    super(
      "PRECONDITION",
      "session creation awaits its original command result",
      {
        details: {
          reason: "session_create_pending",
          ...(commandId === null ? {} : { commandId }),
          ...(operationKey === undefined ? {} : { operationKey }),
        },
        ...(cause instanceof Error ? { cause } : {}),
      },
    );
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

const ResultSchema = z.object({
  sessionId: z.string().min(1),
  acpSessionId: z.string().min(1),
  pid: z.number().int(),
  steeringSupported: z.boolean().optional(),
});

function storedFailure(command: ExecutionCommand): MaisterError {
  const code = command.lastError?.code;

  if (typeof code !== "string" || !isMaisterErrorCode(code))
    throw createIntentError("create_failure_shape");

  return new MaisterError(code, "the original session creation was refused", {
    details: {
      ...(command.lastError?.details as Record<string, unknown> | undefined),
      commandId: command.id,
    },
  });
}

async function assertCreateReplacementQuiescence(
  db: Db,
  command: ExecutionCommand,
  failure: MaisterError,
): Promise<void> {
  const [current] = await db
    .select()
    .from(executionCommands)
    .where(eq(executionCommands.id, command.id));

  if (!current || !hasSessionCreateQuiescence(current.receiptEvidence?.body))
    throw new SessionCreatePending(command.id, failure);
}

type OwnedSessionCreateInput = {
  db: Db;
  client: BoundClient;
  transport: ExecutionHostTransport;
  owner: SessionCreateOwner;
  preparePayload: () => Promise<
    Omit<CreateSessionPayload, "executionWorkspaceId">
  >;
  options?: OwnedSessionOptions;
  logger: Logger;
};
type OwnedSessionCreateResult = CreateSessionResult & {
  hostSessionId: HostSessionId;
  sessionFallback: boolean;
};

function privateCreateFailure(
  error: unknown,
  client: BoundClient,
): MaisterError {
  const projected = projectPrivateCreateFailure(error, {
    runId: client.assignment.runId,
    assignmentId: client.assignment.id,
    assignmentEpoch: client.assignment.epoch,
  });

  if (
    projected !== error &&
    error instanceof SessionCreatePending &&
    typeof error.details?.commandId === "string"
  )
    return new SessionCreatePending(error.details.commandId, projected);

  return projected;
}

function createStorageFailure(
  error: unknown,
  client: BoundClient,
  commandId: string,
): MaisterError {
  const failure = privateCreateFailure(error, client);

  if (
    isMaisterError(error) ||
    (error &&
      typeof error === "object" &&
      "cause" in error &&
      failure === error.cause)
  )
    return failure;

  return new SessionCreatePending(commandId, failure);
}

/** The create payload factory is called only for a first admission. Restarts
 * use private original bytes; credentials/capabilities are not re-resolved.
 */
export async function createOwnedSession(
  input: OwnedSessionCreateInput,
): Promise<OwnedSessionCreateResult> {
  const knownCreate: { commandId: string | null } = { commandId: null };

  try {
    return await createOwnedSessionFromIntent(input, (commandId) => {
      knownCreate.commandId = commandId;
    });
  } catch (error) {
    if (knownCreate.commandId)
      throw createStorageFailure(error, input.client, knownCreate.commandId);
    throw privateCreateFailure(error, input.client);
  }
}

async function createOwnedSessionFromIntent(
  input: OwnedSessionCreateInput,
  recordKnownCreate: (commandId: string) => void,
): Promise<OwnedSessionCreateResult> {
  const { db, client, transport, owner, logger } = input;
  const authority = {
    runId: client.assignment.runId,
    assignmentId: client.assignment.id,
    owner,
  };
  const assertOwner = async (tx: Db): Promise<void> => {
    await input.options?.assertCommit?.(tx);
    if (!(await lockCreateOwner(tx, authority, "create")))
      throw staleSessionBinding(authority.runId, authority.assignmentId);
  };
  let original: ExecutionCommand | undefined;

  try {
    original = await db.transaction(async (tx) => {
      await assertOwner(tx);
      const existing = await latestOwnedCreate(tx, authority);

      if (existing) {
        const { intent } = readCreateIntent(existing, client.host.hostKey);

        if (
          !(await lockCreateOwner(
            tx,
            { ...authority, owner: intent.owner },
            "create",
          ))
        )
          throw staleSessionBinding(authority.runId, authority.assignmentId);
      }

      return existing;
    });
  } catch (error) {
    const failure = privateCreateFailure(error, client);

    if (
      isMaisterError(error) ||
      failure === error ||
      (error &&
        typeof error === "object" &&
        "cause" in error &&
        failure === error.cause)
    )
      throw failure;
    // A failed lookup can hide an already admitted or created session. Retain
    // its owner without inventing a command ID; re-entry locks before reading.
    throw new SessionCreatePending(null, failure, createOperationKey(owner));
  }
  if (original) recordKnownCreate(original.id);
  const persistCreateRejection = async (
    command: ExecutionCommand,
  ): Promise<void> => {
    if (command.receiptEvidence) return;
    let receipt: CommandReceipt | null;

    try {
      receipt = await transport.getCommandReceipt(command.id);
    } catch (error) {
      if (!isMaisterError(error) || error.code !== "EXECUTOR_UNAVAILABLE")
        throw error;
      logger.warn(
        { commandId: command.id, runId: command.runId, code: error.code },
        "owned-create-rejection-receipt-unavailable",
      );

      return;
    }
    if (!receipt) {
      logger.warn(
        { commandId: command.id, runId: command.runId },
        "owned-create-rejection-receipt-missing",
      );

      return;
    }
    if (
      receipt.commandId !== command.id ||
      receipt.runId !== command.runId ||
      receipt.kind !== "session.create" ||
      receipt.assignmentEpoch !== command.assignmentEpoch
    )
      throw createIntentError("create_receipt_identity");
    if (
      receipt.phase !== "rejected" ||
      receipt.inflight ||
      receipt.httpStatus < 400 ||
      (!receipt.completedAt && !receipt.evidenceV2?.terminal)
    ) {
      logger.warn(
        {
          commandId: command.id,
          runId: command.runId,
          phase: receipt.phase,
          inflight: receipt.inflight,
          httpStatus: receipt.httpStatus,
        },
        "owned-create-rejection-not-proven",
      );

      return;
    }
    await db.transaction(async (tx) => {
      await assertOwner(tx);
      await tx
        .update(executionCommands)
        .set({ receiptEvidence: receipt })
        .where(
          and(
            eq(executionCommands.id, command.id),
            eq(executionCommands.state, "failed"),
            isNull(executionCommands.receiptEvidence),
          ),
        );
    });
    logger.info(
      {
        commandId: command.id,
        runId: command.runId,
        assignmentEpoch: command.assignmentEpoch,
      },
      "owned-create-rejection-recorded",
    );
  };
  let replacement: CreateSessionPayload | undefined;
  const failAndReload = async (
    commandId: string,
    attempts: number,
    error: Record<string, unknown>,
  ): Promise<ExecutionCommand> => {
    await db.transaction(async (tx) => {
      await assertOwner(tx);
      await markFailed(tx, commandId, attempts, error, { logger });
    });
    const [reloaded] = await db
      .select()
      .from(executionCommands)
      .where(eq(executionCommands.id, commandId));

    if (!reloaded) throw createIntentError("create_command_missing");

    return reloaded;
  };

  for (;;) {
    if (original?.state === "failed") {
      const { envelope, intent } = readCreateIntent(
        original,
        client.host.hostKey,
      );
      const failure = storedFailure(original);

      if (isUnknownOutcome(failure))
        throw new SessionCreatePending(original.id, failure);
      // ADR-183 D8: an outbox refusal is a park, not a failure. The deliverer
      // gives its first caller `host_pressured`; the stored failure this loop
      // re-reads must say the same, or the driver fails the node.
      if (isHostPressureRefusal(failure))
        throw hostPressuredError(failure, original.id);
      if (
        failure.code === "CHECKPOINT" &&
        "nodeAttemptId" in owner &&
        envelope.payload.resumeSessionId &&
        intent.generation < 2
      ) {
        const [attempt] = await db
          .select({ resume: nodeAttempts.actionResume })
          .from(nodeAttempts)
          .where(eq(nodeAttempts.id, owner.nodeAttemptId));

        const [evaluation] =
          owner.variant === "gate_ai" || owner.variant === "gate_skill"
            ? await db
                .select({ resume: gateResults.permissionResume })
                .from(gateResults)
                .where(eq(gateResults.id, owner.evaluationId))
            : [];

        if (
          ((attempt?.resume?.kind === "permission" ||
            attempt?.resume?.kind === "permission_continue") &&
            attempt.resume.assignmentId === authority.assignmentId) ||
          evaluation?.resume?.assignmentId === authority.assignmentId
        )
          throw failure;
        await assertCreateReplacementQuiescence(db, original, failure);
        const { resumeSessionId, ...fresh } = envelope.payload;

        void resumeSessionId;
        replacement = fresh;
      } else if (
        isReadoptableWorkspaceError(failure) &&
        intent.generation < 2
      ) {
        await assertCreateReplacementQuiescence(db, original, failure);
        replacement = {
          ...envelope.payload,
          executionWorkspaceId: await client.ensureWorkspace({ force: true }),
        };
      } else if (isTurnLostError(original.lastError) && intent.generation < 2) {
        await assertCreateReplacementQuiescence(db, original, failure);
        // A lost logical turn is not process-exit evidence. The original host
        // must prove retirement before these stored bytes start a new process.
        replacement = { ...envelope.payload };
      } else throw failure;
      logger.warn(
        {
          runId: authority.runId,
          commandId: original.id,
          generation: intent.generation,
          code: failure.code,
        },
        "session-create-replacement-authorized",
      );
    }
    if (!original || replacement) {
      const payload = replacement ?? {
        ...(await input.preparePayload()),
        executionWorkspaceId: await client.ensureWorkspace(),
      };
      const normalized = {
        ...payload,
        sessionName: payload.sessionName ?? "default",
      };

      await ensureSessionOutputIntents(db, client, normalized);
      const predecessor = original;
      const continuation = predecessor
        ? readCreateIntent(predecessor, client.host.hostKey).intent.continuation
        : await input.options?.prepareContinuation?.();

      const commandId = randomUUID();
      const issuedAt = new Date();
      const admission: { returnedCandidate: ExecutionCommand | null } = {
        returnedCandidate: null,
      };

      try {
        original = await db.transaction(async (tx) => {
          await lockConsensusDraftCommandAdmission(tx, authority.runId);
          await assertOwner(tx);
          if (owner.variant === "agent")
            await assertAgentResumeCreateRequest(tx, owner.turnId, normalized);
          const existing = await latestOwnedCreate(tx, authority);

          if (existing && existing.id !== predecessor?.id) {
            admission.returnedCandidate = existing;

            return existing;
          }
          if (predecessor && (!existing || existing.state !== "failed"))
            throw createIntentError("create_replacement_source");
          if (continuation)
            await assertRuntimeObjectsReferenceable(
              tx,
              createContinuationObjectIds(continuation),
            );
          const envelope = buildEnvelope({
            commandId,
            kind: "session.create",
            hostKey: client.host.hostKey,
            assignmentId: client.assignment.id,
            assignmentEpoch: client.assignment.epoch,
            runId: authority.runId,
            payload: normalized,
            issuedAt,
          });
          const intent = storeCreateIntent({
            owner,
            generation: predecessor
              ? readCreateIntent(predecessor, client.host.hostKey).intent
                  .generation + 1
              : 0,
            supersedesCommandId: predecessor?.id ?? null,
            sessionFallback: Boolean(
              predecessor &&
              (predecessor.createIntent?.sessionFallback ||
                (readCreateIntent(predecessor, client.host.hostKey).envelope
                  .payload.resumeSessionId &&
                  !normalized.resumeSessionId)),
            ),
            envelope,
            ...(continuation ? { continuation } : {}),
          });
          const issued = await issueCommand(tx, {
            id: commandId,
            now: issuedAt,
            assignment: client.assignment,
            host: client.host,
            kind: "session.create",
            payload: normalized,
            createIntent: intent,
            maxAttempts: COMMAND_POLICY["session.create"].maxAttempts,
            logger,
          });

          await input.options?.assertCommit?.(tx);
          admission.returnedCandidate = issued.row;

          return issued.row;
        });
      } catch (error) {
        // Only a completed callback can have sent COMMIT. Its lost reply cannot
        // establish rollback, even when Drizzle subsequently sends ROLLBACK.
        const candidate = admission.returnedCandidate;
        const sqlState = pgErrorOf(error)?.code;
        const rolledBack =
          sqlState?.startsWith("23") ||
          (sqlState?.startsWith("40") && sqlState !== "40003");

        if (!candidate || rolledBack) throw error;
        const failure = privateCreateFailure(error, client);

        // The next continuation reacquires the same owner lock before reading
        // the operation key, serializing with a late server commit or rollback.
        // Do not add another potentially unavailable DB call to this catch.
        throw new SessionCreatePending(candidate.id, failure);
      }
      recordKnownCreate(original.id);
      replacement = undefined;
    }
    const current = original;
    const { envelope, intent } = readCreateIntent(current, client.host.hostKey);
    const apply = (tx: Db, result: CreateSessionResult) =>
      applyCreateAck(tx, {
        commandId: current.id,
        runId: current.runId,
        assignmentId: current.executionAssignmentId,
        nodeAttemptId: "nodeAttemptId" in owner ? owner.nodeAttemptId : null,
        sessionName: envelope.payload.sessionName ?? "default",
        result: {
          ...result,
          steeringSupported: result.steeringSupported ?? null,
        },
      });
    const resultValue = (result: CreateSessionResult) => ({
      ...result,
      hostSessionId: asHostSessionId(result.sessionId),
      sessionFallback: intent.sessionFallback,
    });

    if (current.state === "succeeded") {
      const result = ResultSchema.safeParse(current.result);

      if (!result.success) throw createIntentError("create_result_shape");
      await db.transaction(async (tx) => {
        if ((await apply(tx, result.data)) !== "applied")
          throw staleSessionBinding(
            current.runId,
            current.executionAssignmentId,
          );
      });

      return resultValue(result.data);
    }
    if (current.state === "failed") continue;
    if (!["queued", "delivering"].includes(current.state))
      throw storedFailure(current);
    if (current.nextAttemptAt && current.nextAttemptAt.getTime() > Date.now())
      throw new SessionCreatePending(current.id);
    if (current.attempts > 0) {
      let receipt: CommandReceipt | null;

      try {
        receipt = await transport.getCommandReceipt(current.id);
      } catch (error) {
        if (!isMaisterError(error) || error.code !== "EXECUTOR_UNAVAILABLE")
          throw error;
        throw new SessionCreatePending(current.id, error);
      }
      if (receipt) {
        if (
          receipt.commandId !== current.id ||
          receipt.runId !== current.runId ||
          receipt.kind !== "session.create" ||
          receipt.assignmentEpoch !== current.assignmentEpoch
        )
          throw createIntentError("create_receipt_identity");
        if (receipt.phase === "accepted") {
          // Neither V1 liveness nor an empty new registry proves the old OS
          // process retired. Keep the same create until terminal host proof.
          throw new SessionCreatePending(current.id);
        }
        if (receipt.phase === "rejected") {
          original = await failAndReload(
            current.id,
            current.attempts,
            receipt.body,
          );
          await persistCreateRejection(original);
          continue;
        }
        const result = ResultSchema.safeParse(receipt.body);

        if (receipt.httpStatus !== 201 || !result.success)
          throw createIntentError("create_receipt_result");
        const bindingDisposition = await db.transaction(async (tx) => {
          await assertOwner(tx);
          const settled = await casTransition(
            tx,
            current.id,
            ["queued", "delivering"],
            current.attempts,
            {
              state: "succeeded",
              result: result.data,
              completedAt: new Date(),
              deliveringSince: null,
              nextAttemptAt: null,
            },
            { logger },
          );

          if (!settled.changed) throw new SessionCreatePending(current.id);

          return apply(tx, result.data);
        });

        logger.info(
          {
            commandId: current.id,
            runId: current.runId,
            assignmentEpoch: current.assignmentEpoch,
            bindingDisposition,
          },
          "owned-create-receipt-folded",
        );

        // A dead incarnation cannot become active again, but that does not
        // erase the host's committed create receipt. Match deliverCommand's
        // historical ACK semantics: commit evidence before yielding authority.
        if (bindingDisposition === "stale")
          throw staleSessionBinding(
            current.runId,
            current.executionAssignmentId,
          );

        return resultValue(result.data);
      }
    }
    if (current.state === "delivering") {
      await db.transaction(async (tx) => {
        await lockConsensusDraftCommandAdmission(tx, current.runId);
        await assertOwner(tx);
        await requeueDelivering(tx, current.id, { logger });
      });
    }
    try {
      const result = await deliverCommand({
        db,
        command: current,
        envelope,
        logger,
        send: () =>
          transport.createSession(envelope, {
            timeoutMs: COMMAND_POLICY["session.create"].timeoutMs,
          }),
        onAck: apply,
      });

      return resultValue(result);
    } catch (originalError) {
      const error = privateCreateFailure(originalError, client);

      if (isFencedError(error)) throw error;
      let settled: ExecutionCommand | undefined;

      try {
        [settled] = await db
          .select()
          .from(executionCommands)
          .where(eq(executionCommands.id, current.id));
      } catch (reloadError) {
        throw new SessionCreatePending(
          current.id,
          new MaisterError(
            "EXECUTOR_UNAVAILABLE",
            "The original session creation outcome cannot yet be read",
            {
              cause: error,
              details: {
                reason: "session_create_outcome_read_pending",
                diagnostics: privateCreateFailure(reloadError, client).details,
              },
            },
          ),
        );
      }

      if (!settled) throw createIntentError("create_command_missing");
      if (
        settled.state === "failed" &&
        isMaisterError(error) &&
        !isUnknownOutcome(error)
      ) {
        await persistCreateRejection(settled);
        original = settled;
        continue;
      }
      throw new SessionCreatePending(current.id, error);
    }
  }
}
