import "server-only";

import type { AggregateResult } from "./algorithms";
import type { DisagreementResult } from "./disagreement";
import type { Db } from "@/lib/evaluations/db";

import { desc, eq } from "drizzle-orm";

import { sha256, stableStringify } from "../digest";

import { getDb } from "@/lib/db/client";
import { evaluationAggregateResults } from "@/lib/db/schema";

function splitAlgorithm(algorithm: string): { id: string; version: string } {
  const at = algorithm.lastIndexOf("@");

  return { id: algorithm.slice(0, at), version: algorithm.slice(at + 1) };
}

// Persist a computed aggregate as an APPEND-ONLY row (D13): exact included
// attempt ids, unrounded calculations, display rounding, exclusions, caps,
// quorum decision, dispersion, and a content digest binding it to the method +
// result-schema digests. A review adjudication writes a NEW revision — the raw
// attempts and prior aggregate are never overwritten.
export async function persistAggregate(
  args: {
    executionId: string;
    result: AggregateResult;
    disagreement: DisagreementResult;
    methodDigests: { definitionDigest: string; schemaDigest: string };
  },
  db?: Db,
): Promise<{ id: string; revision: number; digest: string }> {
  const d = db ?? getDb();
  const { result, disagreement } = args;
  const { id: algorithmId, version: algorithmVersion } = splitAlgorithm(
    result.algorithm,
  );

  const inputs = {
    includedAttemptIds: result.includedAttemptIds,
    algorithmDigest: `${result.algorithm}`,
    methodDefinitionDigest: args.methodDigests.definitionDigest,
    methodSchemaDigest: args.methodDigests.schemaDigest,
  };
  const calculations = {
    perCriterion: result.perCriterion,
    rawTotal: result.rawTotal,
  };
  const digest = sha256(
    stableStringify({
      executionId: args.executionId,
      inputs,
      calculations,
      quorum: { quorum: result.quorum, quorumMet: result.quorumMet },
    }),
  );

  const [prev] = await d
    .select({ revision: evaluationAggregateResults.revision })
    .from(evaluationAggregateResults)
    .where(eq(evaluationAggregateResults.executionId, args.executionId))
    .orderBy(desc(evaluationAggregateResults.revision))
    .limit(1);
  const revision = (prev?.revision ?? 0) + 1;

  const [row] = await d
    .insert(evaluationAggregateResults)
    .values({
      executionId: args.executionId,
      algorithmId,
      algorithmVersion,
      inputs,
      calculations,
      displayValues: {
        displayTotal: result.displayTotal,
        perCriterion: result.perCriterion.map((c) => ({
          criterionId: c.criterionId,
          displayValue: c.displayValue,
          state: c.state,
        })),
      },
      caps: { totalCapped: result.totalCapped },
      quorum: { quorum: result.quorum, quorumMet: result.quorumMet },
      exclusions: { excludedAttempts: result.excludedAttempts },
      dispersion: {
        level: disagreement.level,
        signals: disagreement.signals,
      },
      warnings: disagreement.reviewRequired ? ["review_required"] : [],
      digest,
      revision,
    })
    .returning({ id: evaluationAggregateResults.id });

  return { id: row.id, revision, digest };
}
