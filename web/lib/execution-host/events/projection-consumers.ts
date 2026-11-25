import "server-only";

import type { Db } from "@/lib/execution-host/db";

import { sql } from "drizzle-orm";

import { executionEventConsumers } from "@/lib/db/schema";

// Names are versioned durable cursor identities. Keep this data-only module
// independent from handlers so ingest can seed work without loading them.
export const CANONICAL_PROJECTION_CONSUMERS = {
  prompt: "canonical-prompt-command-v1",
  lifecycle: "canonical-session-lifecycle-v1",
  runtimeObject: "canonical-runtime-object-v1",
  artifact: "canonical-artifact-projector-v1",
  transcript: "canonical-run-transcript-v2",
  cost: "canonical-run-cost-v1",
  context: "canonical-context-v1",
} as const;

export async function seedCanonicalProjectionConsumers(
  tx: Db,
  runId: string,
  maxAvailableSequence: bigint = -1n,
): Promise<void> {
  await tx
    .insert(executionEventConsumers)
    .values(
      Object.values(CANONICAL_PROJECTION_CONSUMERS).map((consumerName) => ({
        consumerName,
        runId,
        maxAvailableSequence,
      })),
    )
    .onConflictDoUpdate({
      target: [
        executionEventConsumers.consumerName,
        executionEventConsumers.runId,
      ],
      set: {
        maxAvailableSequence: sql`GREATEST(${executionEventConsumers.maxAvailableSequence}, EXCLUDED.max_available_sequence)`,
      },
    });
}
