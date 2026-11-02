import "server-only";

import type { Db } from "./db";
import type { CommandApplicationError } from "./types";

import { eq, sql } from "drizzle-orm";
import pino from "pino";

import { projectionTransaction } from "./events/projection-transaction";
import { runEventWakeBus } from "./events/run-wake";
import { commandSignals } from "./signals";
import { COMMAND_REQUEST_SCHEMA } from "./command-request";
import { PromptOwnerSchema } from "./prompt-owner-contract";
import {
  preservePromptApplicationHistory,
  promptApplicationFailureSnapshot,
} from "./prompt-owner-errors";

import { executionCommands } from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";

const log = pino({ name: "prompt-application-recovery" });
const observationToken = sql<string>`md5(concat_ws('|', ${executionCommands.id}, ${executionCommands.applicationState}, ${executionCommands.applicationAttempts}, ${executionCommands.updatedAt}::text, coalesce(${executionCommands.applicationError}::text,''), coalesce(${executionCommands.applicationClaimOwner},''), coalesce(${executionCommands.applicationClaimExpiresAt}::text,'')))`;

export type PromptApplicationObservation = Readonly<{
  commandId: string;
  runId: string;
  state: string;
  applicationState: string | null;
  attempts: number;
  error: CommandApplicationError | null;
  claimLive: boolean;
  claimExpiresAt: Date | null;
  completionAppliedAt: Date | null;
  observationToken: string;
}>;

const observation = {
  commandId: executionCommands.id,
  runId: executionCommands.runId,
  state: executionCommands.state,
  applicationState: executionCommands.applicationState,
  attempts: executionCommands.applicationAttempts,
  error: executionCommands.applicationError,
  claimLive: sql<boolean>`coalesce(${executionCommands.applicationClaimExpiresAt} > clock_timestamp(), false)`,
  claimExpiresAt: executionCommands.applicationClaimExpiresAt,
  completionAppliedAt: executionCommands.completionAppliedAt,
  observationToken,
};

/** Administrative read: deliberately excludes prompt/request bodies and output. */
export async function inspectPromptApplication(
  db: Db,
  commandId: string,
): Promise<PromptApplicationObservation> {
  const [row] = await db
    .select(observation)
    .from(executionCommands)
    .where(eq(executionCommands.id, commandId));

  if (!row)
    throw new MaisterError(
      "PRECONDITION",
      "Prompt application command does not exist",
      { details: { reason: "prompt_application_missing", commandId } },
    );

  return row;
}

/** Requeue only application of the original terminal command; never dispatch a prompt. */
export async function rearmPromptApplication(input: {
  db: Db;
  commandId: string;
  expectedToken: string;
}): Promise<PromptApplicationObservation> {
  const runId = await projectionTransaction(input.db, async (tx) => {
    const [row] = await tx
      .select({
        ...observation,
        kind: executionCommands.kind,
        terminalEvidence: executionCommands.terminalEvidenceSha256,
        lastError: executionCommands.lastError,
        requestSchema: executionCommands.requestSchema,
        ownerKind: executionCommands.ownerKind,
        ownerRef: executionCommands.ownerRef,
      })
      .from(executionCommands)
      .where(eq(executionCommands.id, input.commandId))
      .for("update");

    if (!row || row.observationToken !== input.expectedToken)
      throw new MaisterError(
        "CONFLICT",
        "Prompt application changed since inspection; inspect it again",
        {
          details: {
            reason: "prompt_application_observation_changed",
            commandId: input.commandId,
          },
        },
      );
    if (row.claimLive)
      throw new MaisterError(
        "CONFLICT",
        "Prompt application is still owned by a live worker; wait for bounded preparation or claim expiry",
        {
          details: {
            reason: "prompt_application_claim_live",
            commandId: input.commandId,
          },
        },
      );
    if (
      row.kind !== "session.prompt" ||
      row.requestSchema !== COMMAND_REQUEST_SCHEMA ||
      !PromptOwnerSchema.safeParse({ kind: row.ownerKind, ref: row.ownerRef })
        .success ||
      !["succeeded", "failed", "fenced"].includes(row.state) ||
      row.completionAppliedAt !== null ||
      !["pending", "applying", "poisoned"].includes(row.applicationState ?? "")
    )
      throw new MaisterError(
        "PRECONDITION",
        "Only an unapplied terminal prompt can be rearmed",
        {
          details: {
            reason: "prompt_application_not_recoverable",
            commandId: input.commandId,
          },
        },
      );
    const notSent =
      row.state === "failed" &&
      row.lastError?.details !== null &&
      typeof row.lastError?.details === "object" &&
      "transport" in row.lastError.details &&
      row.lastError.details.transport === "not_sent";

    if (
      row.error?.reason === "prompt_terminal_conflict" ||
      (row.terminalEvidence === null && !notSent)
    )
      throw new MaisterError(
        "PRECONDITION",
        "Conflicting or unverified terminal evidence requires repair before result application",
        {
          details: {
            reason: "prompt_application_evidence_unverified",
            commandId: input.commandId,
          },
        },
      );
    const diagnostic = preservePromptApplicationHistory(row.error, {
      ...(row.error ?? { phase: "continuation" as const }),
      reason: "prompt_owner_rearmed",
      recoveryRequestedAt: new Date().toISOString(),
      previousAttempts: row.attempts,
      recoveryOrigin:
        row.error?.recoveryOrigin ??
        (row.error ? promptApplicationFailureSnapshot(row.error) : undefined),
    });

    await tx
      .update(executionCommands)
      .set({
        applicationState: "pending",
        applicationAttempts: 0,
        applicationClaimOwner: null,
        applicationClaimExpiresAt: null,
        applicationNextRetryAt: null,
        applicationError: diagnostic,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(eq(executionCommands.id, input.commandId));

    return row.runId;
  });

  commandSignals.wake(input.commandId);
  runEventWakeBus.wake(runId);
  log.info(
    { commandId: input.commandId, runId },
    "[FIX:prompt-application] original terminal command rearmed",
  );

  return inspectPromptApplication(input.db, input.commandId);
}
