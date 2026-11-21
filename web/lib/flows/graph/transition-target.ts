import { z } from "zod";

import { autonomousFailureReason } from "@/lib/auto-promotion/completion-policy";

export const TERMINAL_TRANSITION_TARGET = "done";
export const terminalFailureTargetSchema = z.strictObject({
  end: z.literal("failed"),
  reason: autonomousFailureReason,
});
export const transitionTargetSchema = z.union([
  z.string().min(1),
  terminalFailureTargetSchema,
]);

export type TransitionTarget = z.infer<typeof transitionTargetSchema>;
export type TerminalFailureReason = z.infer<typeof autonomousFailureReason>;

export function transitionNodeId(
  target: TransitionTarget | undefined,
): string | null {
  return typeof target === "string" && target !== TERMINAL_TRANSITION_TARGET
    ? target
    : null;
}

export function transitionFailureReason(
  target: TransitionTarget | undefined,
): TerminalFailureReason | null {
  return target && typeof target === "object" ? target.reason : null;
}
