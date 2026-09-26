import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { ScratchMessageDraft } from "@/lib/scratch-runs/types";

import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";

import { runMessages, runTranscriptStates } from "@/lib/db/schema";
import { lockTranscriptState } from "@/lib/execution-host/events/run-message-store";

export function userScratchMessageDraft(args: {
  content: string;
}): ScratchMessageDraft {
  return {
    role: "user",
    content: args.content,
  };
}

export function assistantScratchMessageDraft(args: {
  content: string;
  supervisorEventId?: string;
}): ScratchMessageDraft {
  return {
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
    // ADR-182: how a user row reaches the agent. A `steered` or `queued` row is
    // appended while a turn runs, so it leaves that turn's open rows and usage
    // alone — the steer's acceptance event closes them, a queued row's own
    // dispatch starts the next turn.
    delivery?: "queued" | "prompted" | "steered";
    steerCommandId?: string;
  },
): Promise<{ id: string; sequence: number }> {
  const state = await lockTranscriptState(tx, input.runId, null);
  // Scratch transcripts are 1-based: `lockTranscriptState` seeds an empty scope
  // at 0, and the user prompt is always the first row of a scratch run, so this
  // floor is what makes sequence 1 that prompt. The canonical projector needs
  // no floor — it never writes a scratch run's first row.
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
    delivery: input.delivery ?? null,
    steerCommandId: input.steerCommandId ?? null,
  });
  const duringTurn =
    input.delivery === "steered" || input.delivery === "queued";

  await tx
    .update(runTranscriptStates)
    .set(
      duringTurn
        ? { nextSequence: sequence + 1 }
        : {
            nextSequence: sequence + 1,
            openTextSequence: null,
            openThoughtSequence: null,
            usageSequence: input.role === "user" ? null : state.usageSequence,
          },
    )
    .where(eq(runTranscriptStates.id, state.id));

  return { id, sequence };
}
