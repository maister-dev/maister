import type { KnowledgeAccessCapture } from "@/lib/company/types";
import type { NodeAttemptOutputContract } from "@/lib/db/schema";
import type { RunResultContract } from "@/lib/run-results/types";
import type { WorkspacePolicy } from "@/lib/config.schema";

import { markNodeFailed, markNodeSucceeded } from "@/lib/flows/graph/ledger";
import { engineArtifactManifest } from "@/lib/run-results/artifact-manifest";
import {
  isResultProducerNode,
  usesStructuredKnowledgeContext,
} from "@/lib/run-results/contract";
import {
  publishRunResult,
  recordInvalidRunResult,
} from "@/lib/run-results/ledger";
import { validateFindingsReferences } from "@/lib/run-results/findings-references";
import { MaisterError } from "@/lib/errors";

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
  knowledgeAccess?: KnowledgeAccessCapture | null;
  structuredOutput: SeamOutcomeForClose;
};

export type AttemptResultClose = Readonly<{
  kind: "succeeded" | "reference_refused";
}>;

/** Signal refusal only after the caller's outer publication transaction has committed its failed attempt/result. */
export function assertSucceededAttemptResult(
  outcome: AttemptResultClose,
): void {
  if (outcome.kind === "reference_refused")
    throw new MaisterError(
      "PRECONDITION",
      "Execution result references or source authority changed before publication; inspect the retained invalid result",
      { details: { reason: "native_findings_reference_unavailable" } },
    );
}

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
): Promise<AttemptResultClose> {
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

    return { kind: "succeeded" };
  }

  const refused = await db.transaction(async (tx: Db): Promise<boolean> => {
    const validated = {
      kind: "valid" as const,
      value: structuredOutput.value as Record<string, unknown>,
      valueBytes: structuredOutput.valueBytes ?? 0,
    };
    const decision = usesStructuredKnowledgeContext(args)
      ? await validateFindingsReferences(
          tx,
          args.runId,
          args.resultContract,
          validated,
          args.nodeAttemptId,
        )
      : validated;

    if (decision.kind === "invalid") {
      await markNodeFailed(
        args.nodeAttemptId,
        { errorCode: "PRECONDITION", ...outputContract },
        tx,
      );
      await recordInvalidRunResult(tx, {
        runId: args.runId,
        contract: args.resultContract as RunResultContract,
        reason: decision.reason,
        producerKind: "flow_node",
        producerRef: args.nodeId,
        nodeAttemptId: args.nodeAttemptId,
      });

      return true;
    }
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

    return false;
  });

  return { kind: refused ? "reference_refused" : "succeeded" };
}
