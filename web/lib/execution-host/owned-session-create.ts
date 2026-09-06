import "server-only";

import type { Db } from "./db";
import type { BoundClient } from "./client";
import type { CreateSessionPayload, ExecutionHostTransport } from "./contracts";
import type { CreateSessionResult } from "@/lib/supervisor-client";
import type { ExecutionCommand } from "@/lib/db/schema";
import type { FlowCreateOwner } from "./create-intent";
import type { HostSessionId } from "./types";
import type { Logger } from "pino";

import { eq } from "drizzle-orm";
import { z } from "zod";

import {
  createIntentError,
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
import { issueCommand } from "./ledger";
import { requeueDelivering } from "./commands";
import { ensureSessionOutputIntents } from "./session-output-intents";
import { isReadoptableWorkspaceError } from "./adoption";
import { staleSessionBinding } from "./session-binding";
import { asHostSessionId } from "./types";

import { executionCommands } from "@/lib/db/schema";
import { isMaisterError, MaisterError } from "@/lib/errors";
import { isMaisterErrorCode } from "@/lib/errors-core";

export type OwnedSessionOptions = Readonly<{
  assertCommit?: (tx: Db) => Promise<void>;
}>;
export class SessionCreatePending extends MaisterError {
  constructor(commandId: string, cause?: unknown) {
    super(
      "PRECONDITION",
      "session creation awaits its original command result",
      {
        details: { reason: "session_create_pending", commandId },
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

/** The create payload factory is called only for a first admission. Restarts
 * use private original bytes; credentials/capabilities are not re-resolved.
 */
export async function createOwnedSession(input: {
  db: Db;
  client: BoundClient;
  transport: ExecutionHostTransport;
  owner: FlowCreateOwner;
  preparePayload: () => Promise<
    Omit<CreateSessionPayload, "executionWorkspaceId">
  >;
  options?: OwnedSessionOptions;
  logger: Logger;
}): Promise<
  CreateSessionResult & {
    hostSessionId: HostSessionId;
    sessionFallback: boolean;
  }
> {
  const { db, client, transport, owner, logger } = input;
  const authority = {
    runId: client.assignment.runId,
    assignmentId: client.assignment.id,
    owner,
  };
  const assertOwner = async (tx: Db): Promise<void> => {
    await input.options?.assertCommit?.(tx);
    if (!(await lockCreateOwner(tx, authority)))
      throw staleSessionBinding(authority.runId, authority.assignmentId);
  };
  let original = await db.transaction(async (tx) => {
    await assertOwner(tx);

    return latestOwnedCreate(tx, authority);
  });
  let replacement: CreateSessionPayload | undefined;

  for (;;) {
    if (original?.state === "failed") {
      const { envelope, intent } = readCreateIntent(
        original,
        client.host.hostKey,
      );
      const failure = storedFailure(original);

      if (isUnknownOutcome(failure))
        throw new SessionCreatePending(original.id, failure);
      if (
        failure.code === "CHECKPOINT" &&
        envelope.payload.resumeSessionId &&
        intent.generation < 2
      ) {
        const { resumeSessionId, ...fresh } = envelope.payload;

        void resumeSessionId;
        replacement = fresh;
      } else if (
        isReadoptableWorkspaceError(failure) &&
        intent.generation < 2
      ) {
        replacement = {
          ...envelope.payload,
          executionWorkspaceId: await client.ensureWorkspace({ force: true }),
        };
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

      original = await db.transaction(async (tx) => {
        await assertOwner(tx);
        const existing = await latestOwnedCreate(tx, authority);

        if (existing && existing.id !== predecessor?.id) return existing;
        if (predecessor && (!existing || existing.state !== "failed"))
          throw createIntentError("create_replacement_source");
        const issued = await issueCommand(tx, {
          assignment: client.assignment,
          host: client.host,
          kind: "session.create",
          payload: normalized,
          maxAttempts: COMMAND_POLICY["session.create"].maxAttempts,
          logger,
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
          envelope: issued.envelope,
        });
        const [created] = await tx
          .update(executionCommands)
          .set({ createIntent: intent })
          .where(eq(executionCommands.id, issued.row.id))
          .returning();

        await input.options?.assertCommit?.(tx);
        if (!created) throw createIntentError("create_admission_missing");

        return created;
      });
      replacement = undefined;
    }
    const current = original;
    const { envelope, intent } = readCreateIntent(current, client.host.hostKey);
    const apply = (tx: Db, result: CreateSessionResult) =>
      applyCreateAck(tx, {
        commandId: current.id,
        runId: current.runId,
        assignmentId: current.executionAssignmentId,
        nodeAttemptId: owner.nodeAttemptId,
        sessionName: envelope.payload.sessionName ?? "default",
        result,
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
    if (current.state === "delivering") {
      await db.transaction(async (tx) => {
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
    } catch (error) {
      if (isFencedError(error)) throw error;
      const [settled] = await db
        .select()
        .from(executionCommands)
        .where(eq(executionCommands.id, current.id));

      if (!settled) throw createIntentError("create_command_missing");
      if (
        settled.state === "failed" &&
        isMaisterError(error) &&
        !isUnknownOutcome(error)
      ) {
        original = settled;
        continue;
      }
      throw new SessionCreatePending(current.id, error);
    }
  }
}
