import { z } from "zod";

const sequence = z.string().regex(/^(0|[1-9][0-9]{0,18})$/);

export const ContextSnapshotSchema = z
  .object({
    type: z.literal("session.context_snapshot"),
    runId: z.string(),
    runSessionId: z.string().nullable(),
    incarnationId: z.string().nullable(),
    bindingObservedAt: z.iso.datetime({ precision: 6 }).nullable().optional(),
    nodeAttemptId: z.string().nullable(),
    lifecycleSequence: sequence.nullable(),
    contextSequence: sequence.nullable(),
    transcriptSequence: sequence.nullable(),
    transcriptRevision: sequence.nullable().optional(),
    usage: z
      .object({
        used: z.number().int().nonnegative(),
        size: z.number().int().positive(),
        sizeSource: z.literal("agent_reported"),
        observedAt: z.string(),
        sourceSequence: sequence,
      })
      .strict()
      .nullable(),
    activeCompactions: z.number().int().nonnegative(),
    completedCompactions: z.number().int().nonnegative(),
    coverage: z.enum(["from_incarnation_start", "partial"]),
    windowAdvisory: z.literal("window_unverified").nullable(),
    configuredWindowTokens: z.number().int().positive().nullable().optional(),
  })
  .strict();

export type ContextSnapshot = z.infer<typeof ContextSnapshotSchema>;

export function contextTranscriptRevision(
  snapshot: ContextSnapshot | null | undefined,
): string | null {
  return snapshot?.transcriptRevision ?? snapshot?.transcriptSequence ?? null;
}

function comparableSequence(value: string | null): bigint {
  return value === null ? -1n : BigInt(value);
}

export function latestContextSnapshot(
  hydration: ContextSnapshot | null,
  live: ContextSnapshot | null,
): ContextSnapshot | null {
  if (!hydration) return live;
  if (
    !live ||
    live.runId !== hydration.runId ||
    live.nodeAttemptId !== hydration.nodeAttemptId
  )
    return hydration;
  if (live.incarnationId !== hydration.incarnationId) {
    if (live.bindingObservedAt && hydration.bindingObservedAt) {
      return live.bindingObservedAt >= hydration.bindingObservedAt
        ? live
        : hydration;
    }

    return comparableSequence(live.lifecycleSequence) >=
      comparableSequence(hydration.lifecycleSequence)
      ? live
      : hydration;
  }

  return comparableSequence(live.contextSequence) >=
    comparableSequence(hydration.contextSequence)
    ? live
    : hydration;
}
