import type { Db } from "@/lib/execution-host/db";
import type { BoundClient } from "@/lib/execution-host/client";
import type { PromptOwnerAdmission } from "@/lib/execution-host/ledger";

import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";

import { nodeAttempts, runSessionIncarnations } from "@/lib/db/schema";
import { waitForPromptIncarnation } from "@/lib/execution-host/prompt-incarnation";

// S2.12 made the prompt owner mandatory, so a transport-level suite still has
// to produce a REAL one — there is no test-only unowned path to fall back to.
// This seeds the ledger row an owner references and binds the live incarnation,
// which is exactly what a production dispatch does; suites that assert owner
// SEMANTICS build their own refs instead of using this.
export async function seedNodePromptOwner(
  db: Db,
  client: BoundClient,
  hostSessionId: string,
  opts: {
    stepId?: string;
    attempt?: number;
    promptOrdinal?: number;
    startedAt?: Date;
  } = {},
): Promise<(tx: Db) => Promise<PromptOwnerAdmission>> {
  const runId = client.assignment.runId;
  const nodeId = opts.stepId ?? "s1";
  const promptOrdinal = opts.promptOrdinal ?? 0;
  // A real attempt starts BEFORE the prompt it dispatches. Seeding it at "now"
  // would put every run inside reconcile's grace window, which silently changes
  // what a recovery test measures — so the default is comfortably outside it.
  const startedAt = opts.startedAt ?? new Date(Date.now() - 60 * 60 * 1000);

  await waitForPromptIncarnation(db, client, hostSessionId);
  const [incarnation] = await db
    .select()
    .from(runSessionIncarnations)
    .where(eq(runSessionIncarnations.hostSessionId, hostSessionId));

  if (!incarnation)
    throw new Error(`no active incarnation for host session ${hostSessionId}`);

  const [attempt] = await db
    .insert(nodeAttempts)
    .values({
      id: randomUUID(),
      runId,
      nodeId,
      nodeType: "ai_coding",
      attempt: opts.attempt ?? 1,
      status: "Running",
      executionAssignmentId: client.assignment.id,
      actionPromptOrdinal: promptOrdinal,
      startedAt,
    })
    .returning({ id: nodeAttempts.id });

  return async () => ({
    logicalOperationKey: `flow_node_attempt:node:${attempt.id}:${promptOrdinal}`,
    owner: {
      kind: "flow_node_attempt",
      ref: {
        version: 1,
        variant: "node",
        nodeAttemptId: attempt.id,
        promptOrdinal,
        runId,
        runSessionId: incarnation.runSessionId,
        incarnationId: incarnation.id,
        assignmentId: client.assignment.id,
        assignmentEpoch: client.assignment.epoch,
      },
    },
  });
}
