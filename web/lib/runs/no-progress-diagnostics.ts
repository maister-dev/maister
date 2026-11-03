import { z } from "zod";

const noProgressDiagnosticsSchema = z.object({
  threshold: z.number().int().positive(),
  countedOperations: z.number().int().nonnegative(),
  turnsSinceProgress: z.number().int().nonnegative(),
  progressResets: z.number().int().nonnegative(),
  pendingOperations: z.number().int().nonnegative(),
  ignoredUpdates: z.number().int().nonnegative(),
  progressMode: z.enum(["investigation", "read_only"]),
  stopReason: z.literal("no_progress"),
  recentOperations: z.array(
    z.object({
      toolCallId: z.string(),
      kind: z.string(),
      status: z.string(),
      progress: z.boolean(),
      reason: z.string(),
    }),
  ),
});

export type NoProgressDiagnostics = z.infer<typeof noProgressDiagnosticsSchema>;

/** Decode only diagnostic fields; tool arguments and results stay host-private. */
export function parseNoProgressDiagnostics(
  value: unknown,
): NoProgressDiagnostics | undefined {
  const parsed = noProgressDiagnosticsSchema.safeParse(value);

  return parsed.success ? parsed.data : undefined;
}
