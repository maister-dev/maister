import type { freezeScratchPromptIntent } from "@/lib/scratch-runs/prompt-intent";

import { scratchPromptOperationKey } from "@/lib/scratch-runs/prompt-owner";

// Route wire fixtures have no assignment/incarnation tables. Real PostgreSQL
// admission and restart controls own the persistence contract.
export function scratchPromptIntentFixture(
  input: Parameters<typeof freezeScratchPromptIntent>[1],
): unknown {
  const assignment = input.client.assignment;
  const message = "messageId" in input.owner ? input.owner : null;
  const pkg = "localPackageId" in input.owner ? input.owner : null;

  return {
    version: 1,
    hostSessionId: input.hostSessionId,
    sourceMessageId: input.sourceMessageId,
    payload: input.payload,
    logicalOperationKey: scratchPromptOperationKey(input.owner, assignment.id),
    owner: {
      kind: "scratch_message",
      ref: {
        version: 1,
        variant: input.owner.variant,
        runId: assignment.runId,
        scratchRunId: assignment.runId,
        assignmentId: assignment.id,
        assignmentEpoch: assignment.epoch,
        runSessionId: "fixture-run-session",
        incarnationId: "fixture-incarnation",
        turnId: message?.messageId ?? assignment.id,
        promptOrdinal: message?.sequence ?? 0,
        ...(message ? { messageId: message.messageId } : {}),
        ...(pkg
          ? {
              localPackageId: pkg.localPackageId,
              postprocessActionId: pkg.postprocessActionId,
              lockGeneration: pkg.lockGeneration,
            }
          : {}),
      },
    },
  };
}
