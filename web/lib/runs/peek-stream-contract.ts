import { z } from "zod";

const id = z.string().min(1).max(256);

export const peekFrameSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("peek.ready"),
      anchorRunId: id,
      selectedRunId: id.nullable(),
      selectionState: z.enum(["none", "ready", "unavailable"]),
    })
    .strict(),
  z
    .object({
      type: z.literal("run.changed"),
      runId: id,
      kind: z.enum(["execution", "summary", "transcript"]),
    })
    .strict(),
  z.object({ type: z.literal("peek.changed") }).strict(),
  z
    .object({
      type: z.literal("peek.resync"),
      reason: z.enum([
        "listener_reconnected",
        "visibility",
        "manual",
        "transport",
      ]),
    })
    .strict(),
  z.object({ type: z.literal("peek.selection_unavailable") }).strict(),
]);
export type PeekFrame = z.infer<typeof peekFrameSchema>;
