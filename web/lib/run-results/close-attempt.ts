import type { NodeAttemptOutputContract } from "@/lib/db/schema";
import type { RunResultContract } from "@/lib/run-results/types";
import type { WorkspacePolicy } from "@/lib/config.schema";

import { markNodeSucceeded } from "@/lib/flows/graph/ledger";
import { engineArtifactManifest } from "@/lib/run-results/artifact-manifest";
import { isResultProducerNode } from "@/lib/run-results/contract";
import { publishRunResult } from "@/lib/run-results/ledger";

// FIXME(any): dual drizzle-orm peer-dep variants (matches lib/services/tasks.ts).
type Db = any;

/** What the structured-output seam reported for this attempt. */
export type SeamOutcomeForClose = {
  ok: boolean;
  contract?: NodeAttemptOutputContract;
  value?: Record<string, unknown>;
  valueBytes?: number;
};

export type CloseSucceededAttemptArgs = {
  db: Db;
  runId: string;
  nodeId: string;
  nodeAttemptId: string;
  /** Everything `markNodeSucceeded` already took. */
  patch: {
    stdout?: string | null;
    vars?: Record<string, unknown>;
    exitCode?: number;
    decision?: string;
    workspacePolicy?: WorkspacePolicy;
    acpSessionId?: string;
  };
  /** The run's launch-time public-result contract, or null. */
  resultContract: RunResultContract | null;
  structuredOutput: SeamOutcomeForClose;
};

/**
 * Close a SUCCEEDED node attempt and, when the node is a producer of the run's
 * public result, publish that result — in ONE transaction (ADR-165 D9, W1).
 *
 * This exists because the two writes are one fact. A result row that outlives a
 * rolled-back attempt would be a public answer nothing produced; an attempt that
 * closes without its result would let `orchestrator_resume` wake a parent onto a
 * run whose result is not there yet. Replacing all three `markNodeSucceeded`
 * sites with this call is what makes "every publish shares its attempt's
 * transaction" a property of the code rather than of three call sites agreeing.
 *
 * A node that is not a producer, or a run with no contract, takes exactly the
 * old path — one `markNodeSucceeded`, no extra write.
 */
export async function closeSucceededAttemptWithResult(
  args: CloseSucceededAttemptArgs,
): Promise<void> {
  const { db, structuredOutput } = args;
  const outputContract =
    structuredOutput.ok && structuredOutput.contract
      ? { outputContract: structuredOutput.contract }
      : {};

  const publishes =
    structuredOutput.ok &&
    structuredOutput.value !== undefined &&
    args.resultContract !== null &&
    isResultProducerNode(args.resultContract, args.nodeId);

  if (!publishes) {
    await markNodeSucceeded(
      args.nodeAttemptId,
      { ...args.patch, ...outputContract },
      db,
    );

    return;
  }

  await db.transaction(async (tx: Db) => {
    await markNodeSucceeded(
      args.nodeAttemptId,
      { ...args.patch, ...outputContract },
      tx,
    );
    await publishRunResult(tx, {
      runId: args.runId,
      value: structuredOutput.value as Record<string, unknown>,
      valueBytes: structuredOutput.valueBytes ?? 0,
      contract: args.resultContract as RunResultContract,
      producerKind: "flow_node",
      producerRef: args.nodeId,
      nodeAttemptId: args.nodeAttemptId,
      // Engine-derived, read inside the SAME transaction so the manifest is
      // consistent with the attempt close it is committed alongside.
      artifactManifest: await engineArtifactManifest(tx, args.runId),
    });
  });
}
