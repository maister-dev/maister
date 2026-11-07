import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { ExecutionHosts } from "@/lib/execution-host/client";

import { and, desc, eq, sql } from "drizzle-orm";
import pino from "pino";

import {
  completeOwnedScratchCreate,
  dispatchOwnedScratchCreatePrompt,
} from "./create-continuation";
import { rollbackScratchClaim } from "./respawn";

import { executionCommands, runs, scratchRuns } from "@/lib/db/schema";
import { isMaisterError, MaisterError } from "@/lib/errors";
import { readCreateIntent } from "@/lib/execution-host/create-intent";
import {
  SessionCreatePending,
  readOwnedCreateContinuation,
} from "@/lib/execution-host/owned-session-create";
import { isFencedError } from "@/lib/execution-host/deliverer";

const log = pino({
  name: "scratch-create-recovery",
  level: process.env.LOG_LEVEL ?? "info",
});

/** Rediscover only the current placement's already accepted private create. */
export async function redriveOwnedScratchCreate(
  db: Db,
  runId: string,
  hosts: ExecutionHosts,
): Promise<void> {
  const [command] = await db
    .select({ command: executionCommands })
    .from(executionCommands)
    .innerJoin(
      runs,
      and(
        eq(runs.id, executionCommands.runId),
        eq(runs.executionAssignmentId, executionCommands.executionAssignmentId),
      ),
    )
    .innerJoin(scratchRuns, eq(scratchRuns.runId, runs.id))
    .where(
      and(
        eq(runs.id, runId),
        eq(runs.status, "Running"),
        eq(scratchRuns.dialogStatus, "Starting"),
        eq(executionCommands.kind, "session.create"),
        sql`${executionCommands.createIntent}->'owner'->>'variant' IN ('scratch','package_scratch')`,
      ),
    )
    .orderBy(desc(executionCommands.createdAt), desc(executionCommands.id))
    .limit(1);

  if (!command) return;
  const execution = await hosts.executionFor(runId, {
    assignmentId: command.command.executionAssignmentId,
  });
  const { intent } = readCreateIntent(
    command.command,
    execution.client.host.hostKey,
  );
  const owner = intent.owner;

  if (owner.variant !== "scratch" && owner.variant !== "package_scratch")
    return;
  let session: Awaited<ReturnType<typeof execution.client.createOwnedSession>>;

  try {
    session = await execution.client.createOwnedSession(owner, async () => {
      throw new MaisterError(
        "CONFLICT",
        "Retained scratch creation cannot rebuild its original request",
        { details: { reason: "scratch_create_request_missing" } },
      );
    });
  } catch (error) {
    if (error instanceof SessionCreatePending || isFencedError(error)) {
      log.debug(
        { runId, commandId: command.command.id },
        "scratch-create-retained-for-owner",
      );

      return;
    }
    const continuation = await readOwnedCreateContinuation(
      db,
      execution.client,
      owner,
    );

    if (
      continuation?.kind === "recovery" ||
      continuation?.kind === "package_recovery"
    ) {
      const recoveryState = continuation.recoveryState;

      await rollbackScratchClaim(
        db,
        runId,
        execution.client.assignment.id,
        {
          status: recoveryState.status,
          currentStepId: recoveryState.currentStepId,
          resumeRequestedAt: recoveryState.resumeRequestedAt
            ? new Date(recoveryState.resumeRequestedAt)
            : null,
        },
        "scratch_create_recovery_failed",
        {
          commandId: command.command.id,
          error,
          assignmentEpoch: execution.client.assignment.epoch,
        },
      );
    } else if (
      continuation?.kind === "initial" ||
      continuation?.kind === "package_initial"
    ) {
      const { markScratchCrashed } = await import("./service");

      await markScratchCrashed({
        db,
        runId,
        expectedAssignmentId: execution.client.assignment.id,
        err: error,
      });
    } else throw error;
    log.error(
      {
        runId,
        assignmentId: execution.client.assignment.id,
        assignmentEpoch: execution.client.assignment.epoch,
        commandId: command.command.id,
        stage: "session_create",
        errorCode: isMaisterError(error) ? error.code : "service_failure",
      },
      "scratch-retained-create-failed",
    );

    return;
  }
  const continuation = await completeOwnedScratchCreate(
    db,
    execution,
    owner,
    session,
  );

  if (!continuation) return;
  try {
    await dispatchOwnedScratchCreatePrompt(
      db,
      execution,
      owner,
      session.sessionId,
      continuation,
    );
  } catch (error) {
    const { failScratchMessageTurn } = await import("./service");

    await failScratchMessageTurn({
      db,
      runId,
      messageId:
        continuation.kind === "initial" ? continuation.sourceMessageId : null,
      hostSessionId: session.sessionId,
      isLocalPackageAssistant: owner.variant === "package_scratch",
      err: error,
    });
    throw error;
  }
  if (!continuation.payload) {
    const { wakeQueuedScratchDispatch } = await import("./service");

    wakeQueuedScratchDispatch(db, runId, hosts);
  }
}
