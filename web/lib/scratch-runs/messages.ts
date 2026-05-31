import "server-only";

import type { ScratchMessageDraft } from "@/lib/scratch-runs/types";

export function nextScratchMessageSequence(
  existingSequences: readonly number[],
): number {
  if (existingSequences.length === 0) return 1;

  return Math.max(...existingSequences) + 1;
}

export function userScratchMessageDraft(args: {
  sequence: number;
  content: string;
}): ScratchMessageDraft {
  return {
    sequence: args.sequence,
    role: "user",
    content: args.content,
  };
}

export function assistantScratchMessageDraft(args: {
  sequence: number;
  content: string;
  supervisorEventId?: string;
}): ScratchMessageDraft {
  return {
    sequence: args.sequence,
    role: "assistant",
    content: args.content,
    supervisorEventId: args.supervisorEventId,
  };
}
