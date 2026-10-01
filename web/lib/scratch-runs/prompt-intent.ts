import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { BoundClient } from "@/lib/execution-host/client";
import type { PromptOwnerAdmission } from "@/lib/execution-host/ledger";
import type { SendPromptInput } from "@/lib/execution-host";
import type { ScratchPromptOwner } from "./prompt-owner";

import { and, eq, ne, notInArray, or, isNull, sql } from "drizzle-orm";
import { z } from "zod";

import { canonicalCommandJson } from "../../../runtime/command-json";

import { admitScratchPrompt } from "./prompt-owner";

import { executionCommands, runMessages, scratchRuns } from "@/lib/db/schema";
import { PromptPayloadSchema } from "@/lib/execution-host/command-request";
import { ScratchPromptOwnerSchema } from "@/lib/execution-host/prompt-owner-contract";
import { PromptOwnerInvariantError } from "@/lib/execution-host/prompt-owner-errors";
import { MaisterError } from "@/lib/errors";

const PromptIntentSchema = z
  .object({
    version: z.literal(1),
    owner: ScratchPromptOwnerSchema,
    logicalOperationKey: z.string().min(1).max(256),
    hostSessionId: z.string().min(1).max(128),
    sourceMessageId: z.string().min(1).max(128).nullable(),
    payload: PromptPayloadSchema,
  })
  .strict();

export type ScratchPromptIntent = z.infer<typeof PromptIntentSchema>;

/** Private, immutable admission data; never expose it in a DTO or log. */
export function readScratchPromptIntent(value: unknown): ScratchPromptIntent {
  const parsed = PromptIntentSchema.safeParse(value);

  if (!parsed.success)
    throw new PromptOwnerInvariantError("scratch_intent_shape");
  const intent = parsed.data;
  const ref = intent.owner.ref;

  if (
    ref.variant === "package_recovery" ||
    intent.logicalOperationKey !==
      `scratch_message:${ref.variant}:${ref.turnId}:${ref.promptOrdinal}` ||
    ref.scratchRunId !== ref.runId ||
    ("messageId" in ref
      ? ref.turnId !== ref.messageId || intent.sourceMessageId !== ref.messageId
      : ref.turnId !== ref.assignmentId || ref.promptOrdinal !== 0)
  )
    throw new PromptOwnerInvariantError("scratch_intent_identity");

  return intent;
}

export function scratchOwnerFromIntent(
  intent: ScratchPromptIntent,
): ScratchPromptOwner {
  const ref = intent.owner.ref;

  switch (ref.variant) {
    case "initial":
    case "recovery":
      return { variant: ref.variant };
    case "message":
      return {
        variant: ref.variant,
        messageId: ref.messageId,
        sequence: ref.promptOrdinal,
      };
    case "package_initial":
      return {
        variant: ref.variant,
        localPackageId: ref.localPackageId,
        postprocessActionId: ref.postprocessActionId,
        lockGeneration: ref.lockGeneration,
      };
    case "package_message":
      return {
        variant: ref.variant,
        messageId: ref.messageId,
        sequence: ref.promptOrdinal,
        localPackageId: ref.localPackageId,
        postprocessActionId: ref.postprocessActionId,
        lockGeneration: ref.lockGeneration,
      };
    case "package_recovery":
      throw new PromptOwnerInvariantError("scratch_intent_identity");
  }
}

/** Caller has written the winning Running state in this same transaction. */
export async function freezeScratchPromptIntent(
  tx: Db,
  input: Readonly<{
    client: BoundClient;
    hostSessionId: string;
    owner: ScratchPromptOwner;
    sourceMessageId: string | null;
    payload: SendPromptInput;
  }>,
): Promise<ScratchPromptIntent> {
  const admission = await admitScratchPrompt(
    tx,
    input.client,
    input.hostSessionId,
    input.owner,
  );
  const intent = readScratchPromptIntent({
    version: 1,
    owner: admission.owner,
    logicalOperationKey: admission.logicalOperationKey,
    hostSessionId: input.hostSessionId,
    sourceMessageId: input.sourceMessageId,
    payload: input.payload,
  });

  await assertScratchIntentSource(tx, intent);
  // Measure PostgreSQL's actual JSONB text encoding, including its spaces and
  // UTF-8 bytes, rather than assuming compact JavaScript JSON has the same size.
  const size = await tx.execute<{ bytes: number }>(
    sql`SELECT octet_length(${JSON.stringify(intent)}::jsonb::text) AS bytes`,
  );

  if (!size.rows[0] || size.rows[0].bytes > 4_194_304)
    throw new PromptOwnerInvariantError("scratch_intent_size");
  await tx
    .update(scratchRuns)
    .set({ activePromptIntent: intent })
    .where(eq(scratchRuns.runId, input.client.assignment.runId));

  return intent;
}

/** Called only inside issueOwnedPrompt's transaction, after the run lock. */
export async function admitFrozenScratchPrompt(
  tx: Db,
  client: BoundClient,
  hostSessionId: string,
  owner: ScratchPromptOwner,
  payload: SendPromptInput,
): Promise<PromptOwnerAdmission> {
  const admission = await admitScratchPrompt(tx, client, hostSessionId, owner);
  const [scratch] = await tx
    .select({ intent: scratchRuns.activePromptIntent })
    .from(scratchRuns)
    .where(eq(scratchRuns.runId, client.assignment.runId));
  const intent = readScratchPromptIntent(scratch?.intent);

  if (intent.logicalOperationKey !== admission.logicalOperationKey)
    throw new MaisterError(
      "CONFLICT",
      "scratch turn belongs to a newer frozen intent",
      {
        details: { reason: "prompt_owner_superseded" },
      },
    );
  await assertScratchIntentSource(tx, intent);

  if (
    intent.hostSessionId !== hostSessionId ||
    intent.logicalOperationKey !== admission.logicalOperationKey ||
    canonicalCommandJson(intent.owner) !==
      canonicalCommandJson(admission.owner) ||
    canonicalCommandJson(intent.payload) !==
      canonicalCommandJson(JSON.parse(JSON.stringify(payload)))
  )
    throw new PromptOwnerInvariantError("scratch_intent_changed");
  const blocker = await findScratchPromptObligation(tx, intent);

  if (blocker) throw new PromptOwnerInvariantError("scratch_prompt_obligation");

  return admission;
}

/** An older applied turn is harmless; every unsettled obligation is evidence
 * that this incarnation cannot be given a different prompt yet. */
export async function findScratchPromptObligation(
  tx: Db,
  intent: ScratchPromptIntent,
): Promise<string | null> {
  const [command] = await tx
    .select({ id: executionCommands.id })
    .from(executionCommands)
    .where(
      and(
        eq(executionCommands.runId, intent.owner.ref.runId),
        eq(executionCommands.kind, "session.prompt"),
        eq(executionCommands.targetSessionId, intent.hostSessionId),
        or(
          isNull(executionCommands.logicalOperationKey),
          ne(executionCommands.logicalOperationKey, intent.logicalOperationKey),
        ),
        notInArray(executionCommands.applicationState, [
          "applied",
          "superseded",
        ]),
      ),
    )
    .limit(1);

  return command?.id ?? null;
}

async function assertScratchIntentSource(
  tx: Db,
  intent: ScratchPromptIntent,
): Promise<void> {
  if (!intent.sourceMessageId) return;
  const [source] = await tx
    .select({ id: runMessages.id })
    .from(runMessages)
    .where(
      and(
        eq(runMessages.id, intent.sourceMessageId),
        eq(runMessages.runId, intent.owner.ref.runId),
        eq(runMessages.role, "user"),
        or(isNull(runMessages.delivery), eq(runMessages.delivery, "prompted")),
      ),
    )
    .for("update")
    .limit(1);

  if (!source) throw new PromptOwnerInvariantError("scratch_intent_source");
}
