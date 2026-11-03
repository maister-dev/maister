import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { BoundClient } from "@/lib/execution-host/client";
import type { ScratchCreateOwner } from "@/lib/execution-host/create-owner-contract";
import type { OwnedCreateContinuation } from "@/lib/execution-host/create-continuation";
import type { ScratchExecution } from "./events";
import type { ScratchPromptOwner } from "./prompt-owner";
import type { PromptResult } from "@/lib/execution-host";

import { and, eq, isNull, sql } from "drizzle-orm";
import pino from "pino";

import { lockScratchRunRows } from "./turn-completion";
import {
  freezeScratchPromptIntent,
  readScratchPromptIntent,
} from "./prompt-intent";
import { sendScratchPromptAndProjectEvents } from "./events";

import { hitlRequests, runMessages, runs, scratchRuns } from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import { assertCurrentSessionBinding } from "@/lib/execution-host/session-binding";
import { assertRuntimeObjectsReferenceable } from "@/lib/execution-host/runtime-object-holds";
import { readOwnedCreateContinuation } from "@/lib/execution-host/owned-session-create";
import { projectPrivateCreateFailure } from "@/lib/execution-host/private-create-failure";
import { isFencedError } from "@/lib/execution-host/deliverer";

/** A known-created session retains its assignment while the private first-turn handoff is uncertain. */
export class ScratchCreateHandoffPending extends MaisterError {
  constructor(diagnostic: MaisterError) {
    super(
      "PRECONDITION",
      "The scratch session is created; its frozen first turn is waiting for the database handoff to recover",
      {
        details: {
          reason: "scratch_create_handoff_pending",
          stage: "scratch_create_handoff",
          diagnosticCode: diagnostic.code,
          diagnostics: {
            ...diagnostic.details,
            stage: "scratch_create_handoff",
          },
        },
      },
    );
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export type ScratchCreateContinuation = Exclude<
  OwnedCreateContinuation,
  { kind: "sync_resolver" }
>;

const log = pino({
  name: "scratch-create-continuation",
  level: process.env.LOG_LEVEL ?? "info",
});

/** New create admission freezes the next action before any host executable effect. */
export async function assertScratchCreateContinuation(
  tx: Db,
  client: BoundClient,
  owner: ScratchCreateOwner,
  continuation: ScratchCreateContinuation,
): Promise<void> {
  if (owner.scratchRunId !== client.assignment.runId)
    throw new MaisterError(
      "CONFLICT",
      "Scratch create continuation belongs to another Run",
      { details: { reason: "command_invariant_conflict" } },
    );
  if (continuation.sourceMessageId) {
    const [message] = await tx
      .select({ id: runMessages.id })
      .from(runMessages)
      .where(
        and(
          eq(runMessages.id, continuation.sourceMessageId),
          eq(runMessages.runId, owner.scratchRunId),
          eq(runMessages.role, "user"),
        ),
      )
      .for("update");

    if (!message)
      throw new MaisterError(
        "CONFLICT",
        "Scratch create source message is no longer available",
        { details: { reason: "scratch_create_source_missing" } },
      );
  }
  const objectIds =
    continuation.payload?.contentBlocks?.flatMap((block) =>
      block.type === "runtime_object" ? [block.objectId] : [],
    ) ?? [];

  await assertRuntimeObjectsReferenceable(tx, objectIds);
  await tx
    .update(scratchRuns)
    .set({
      dialogStatus: "Starting",
      errorCode: null,
      errorMessage: null,
      errorMetadata: null,
      updatedAt: new Date(),
    })
    .where(eq(scratchRuns.runId, owner.scratchRunId));
}

function promptOwner(
  owner: ScratchCreateOwner,
  continuation: ScratchCreateContinuation,
): ScratchPromptOwner {
  if (owner.variant === "package_scratch")
    return {
      variant:
        continuation.kind === "package_initial"
          ? "package_initial"
          : "package_recovery",
      localPackageId: owner.localPackageId,
      postprocessActionId: owner.postprocessActionId,
      lockGeneration: owner.lockGeneration,
    };

  return { variant: continuation.kind === "initial" ? "initial" : "recovery" };
}

/** The exact ACK and private continuation own the Starting-to-dialog handoff. */
export async function completeOwnedScratchCreate(
  db: Db,
  execution: ScratchExecution,
  owner: ScratchCreateOwner,
  session: Readonly<{ sessionId: string; acpSessionId: string }>,
): Promise<ScratchCreateContinuation | null> {
  try {
    return await completeScratchCreateHandoff(db, execution, owner, session);
  } catch (error) {
    const diagnostic = projectPrivateCreateFailure(error, {
      runId: owner.scratchRunId,
      assignmentId: execution.client.assignment.id,
      assignmentEpoch: execution.client.assignment.epoch,
      stage: "scratch_create_handoff",
    });

    if (
      isFencedError(diagnostic) ||
      [
        "UNAUTHENTICATED",
        "UNAUTHORIZED",
        "PASSWORD_CHANGE_REQUIRED",
        "ACCOUNT_INACTIVE",
      ].includes(diagnostic.code)
    )
      throw diagnostic;
    log.warn(
      {
        runId: owner.scratchRunId,
        assignmentId: execution.client.assignment.id,
        assignmentEpoch: execution.client.assignment.epoch,
        hostSessionId: session.sessionId,
        stage: "scratch_create_handoff",
        diagnosticCode: diagnostic.code,
        diagnostics: { ...diagnostic.details, stage: "scratch_create_handoff" },
      },
      "scratch-create-handoff-retained",
    );
    throw new ScratchCreateHandoffPending(diagnostic);
  }
}

async function completeScratchCreateHandoff(
  db: Db,
  execution: ScratchExecution,
  owner: ScratchCreateOwner,
  session: Readonly<{ sessionId: string; acpSessionId: string }>,
): Promise<ScratchCreateContinuation | null> {
  const continuation = await readOwnedCreateContinuation(
    db,
    execution.client,
    owner,
  );

  if (!continuation || continuation.kind === "sync_resolver")
    throw new MaisterError(
      "CONFLICT",
      "Scratch session creation lost its frozen continuation",
      { details: { reason: "scratch_create_continuation_missing" } },
    );

  return db.transaction(async (tx) => {
    await lockScratchRunRows(tx, owner.scratchRunId);
    const [run] = await tx
      .select()
      .from(runs)
      .where(eq(runs.id, owner.scratchRunId));
    const [scratch] = await tx
      .select()
      .from(scratchRuns)
      .where(eq(scratchRuns.runId, owner.scratchRunId));

    if (
      run?.status !== "Running" ||
      run.executionAssignmentId !== execution.client.assignment.id ||
      !scratch ||
      !["Starting", "Running"].includes(scratch.dialogStatus)
    )
      return null;
    await assertCurrentSessionBinding(tx, {
      runId: run.id,
      sessionName: "default",
      assignmentId: execution.client.assignment.id,
      hostSessionId: session.sessionId,
      acpSessionId: session.acpSessionId,
    });
    if (scratch.activePromptIntent) {
      const current = readScratchPromptIntent(scratch.activePromptIntent);

      if (current.owner.ref.assignmentId === execution.client.assignment.id)
        return continuation;
    }
    await tx
      .update(scratchRuns)
      .set({
        dialogStatus: continuation.payload ? "Running" : "WaitingForUser",
        errorCode: null,
        errorMessage: null,
        errorMetadata: null,
        activePromptIntent: null,
        updatedAt: new Date(),
      })
      .where(eq(scratchRuns.runId, run.id));
    await tx
      .update(runs)
      .set({
        checkpointAt: null,
        ...(continuation.payload ? {} : { resumeStartedAt: null }),
      })
      .where(eq(runs.id, run.id));
    if (
      continuation.kind === "recovery" ||
      continuation.kind === "package_recovery"
    ) {
      await tx
        .update(hitlRequests)
        .set({ respondedAt: new Date() })
        .where(
          and(
            eq(hitlRequests.runId, run.id),
            eq(hitlRequests.kind, "permission"),
            isNull(hitlRequests.respondedAt),
            isNull(hitlRequests.response),
            isNull(hitlRequests.supersededAt),
            sql`${hitlRequests.schema}->>'supervisorSessionId' IS DISTINCT FROM ${session.sessionId}`,
          ),
        );
    }
    if (continuation.payload)
      await freezeScratchPromptIntent(tx, {
        client: execution.client,
        hostSessionId: session.sessionId,
        owner: promptOwner(owner, continuation),
        sourceMessageId: continuation.sourceMessageId,
        payload: continuation.payload,
      });
    log.info(
      {
        runId: run.id,
        assignmentId: execution.client.assignment.id,
        kind: continuation.kind,
        hasPrompt: continuation.payload !== null,
      },
      "scratch-create-continuation-ready",
    );

    return continuation;
  });
}

export async function dispatchOwnedScratchCreatePrompt(
  db: Db,
  execution: ScratchExecution,
  owner: ScratchCreateOwner,
  sessionId: string,
  continuation: ScratchCreateContinuation,
): Promise<PromptResult | null> {
  if (!continuation.payload) return null;
  const result = await sendScratchPromptAndProjectEvents({
    db,
    runId: owner.scratchRunId,
    sessionId,
    ...continuation.payload,
    execution,
    owner: promptOwner(owner, continuation),
  });

  if (owner.variant === "package_scratch") {
    const { postProcessRecoveredPackageTurn } = await import("./service");

    await postProcessRecoveredPackageTurn(db, owner.scratchRunId, owner);
  }

  return result;
}
