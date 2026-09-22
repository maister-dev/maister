import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { ScratchMessageDraft } from "@/lib/scratch-runs/types";

import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";

import { runMessages, runTranscriptStates } from "@/lib/db/schema";
import { lockTranscriptState } from "@/lib/execution-host/events/run-message-store";

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

/** Scratch user messages and notices share the durable reply allocator. */
export async function appendScratchMessage(
  tx: Db,
  input: {
    id?: string;
    runId: string;
    role: "user" | "system";
    content: string;
    supervisorEventId?: string;
  },
): Promise<{ id: string; sequence: number }> {
  const state = await lockTranscriptState(tx, input.runId, null);
  const sequence = Math.max(1, state.nextSequence);
  const id = input.id ?? randomUUID();

  await tx.insert(runMessages).values({
    id,
    runId: input.runId,
    nodeAttemptId: null,
    sequence,
    role: input.role,
    content: input.content,
    supervisorEventId: input.supervisorEventId ?? null,
  });
  await tx
    .update(runTranscriptStates)
    .set({
      nextSequence: sequence + 1,
      openTextSequence: null,
      openThoughtSequence: null,
      usageSequence: input.role === "user" ? null : state.usageSequence,
    })
    .where(eq(runTranscriptStates.id, state.id));

  return { id, sequence };
}
