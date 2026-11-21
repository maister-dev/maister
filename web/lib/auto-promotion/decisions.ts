import "server-only";

import type { Db } from "@/lib/execution-host/db";

import { runAutonomousDecisions } from "@/lib/db/schema";
import { emitDomainEvent } from "@/lib/domain-events/outbox";
import { encodeWaitDigest } from "@/lib/waits/store";
import { notifyAutonomousDecisionChanged } from "@/lib/runs/peek-wake";

type Decision = Omit<
  typeof runAutonomousDecisions.$inferInsert,
  "id" | "createdAt"
>;
type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

export async function recordAutonomousDecision(
  tx: Transaction,
  input: Decision,
): Promise<{ id: string; created: boolean }> {
  const id = encodeWaitDigest(input);
  const [decision] = await tx
    .insert(runAutonomousDecisions)
    .values({ id, ...input })
    .onConflictDoNothing({ target: runAutonomousDecisions.id })
    .returning({ at: runAutonomousDecisions.createdAt });

  if (decision) {
    await emitDomainEvent({
      db: tx,
      kind: "run.autonomous_decision",
      runId: input.runId,
      projectId: input.projectId,
      actor: { type: "system", id: null },
      occurredAt: decision.at,
      payload: { schemaVersion: 1, decisionId: id },
    });
    await notifyAutonomousDecisionChanged(tx, input.runId);
  }

  return { id, created: decision !== undefined };
}
