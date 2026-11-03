import "server-only";

import { z } from "zod";

import { PromptPayloadSchema } from "./command-request";

const scratchPayload = {
  version: z.literal(1),
  sourceMessageId: z.string().min(1).max(128).nullable(),
  payload: PromptPayloadSchema.nullable(),
};
const recoveryState = z
  .object({
    status: z.enum(["Crashed", "NeedsInputIdle"]),
    currentStepId: z.string().min(1).max(128).nullable(),
    resumeRequestedAt: z.string().datetime().nullable(),
  })
  .strict();

/** Private continuation bytes frozen before a session exists; never project or log them. */
export const OwnedCreateContinuationSchema = z.discriminatedUnion("kind", [
  z
    .object({ ...scratchPayload, kind: z.enum(["initial", "package_initial"]) })
    .strict(),
  z
    .object({
      ...scratchPayload,
      kind: z.enum(["recovery", "package_recovery"]),
      recoveryState,
    })
    .strict(),
  z
    .object({
      version: z.literal(1),
      kind: z.literal("sync_resolver"),
      prompt: z
        .object({
          stepId: z.literal("sync"),
          prompt: z.string().max(1_000_000),
        })
        .strict(),
      runnerTier: z.string().min(1).max(128),
    })
    .strict(),
]);

export type OwnedCreateContinuation = z.infer<
  typeof OwnedCreateContinuationSchema
>;

export function createContinuationObjectIds(
  continuation: OwnedCreateContinuation,
): readonly string[] {
  if (continuation.kind === "sync_resolver" || !continuation.payload) return [];

  return (continuation.payload.contentBlocks ?? []).flatMap((block) =>
    block.type === "runtime_object" ? [block.objectId] : [],
  );
}
