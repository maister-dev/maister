import "server-only";

import type { PlanReviewV1 } from "../plan-review-contract";

import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import pino from "pino";

import { createHitlAssignmentForRun } from "@/lib/assignments/service";
import * as schemaModule from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";

const { hitlRequests } = schemaModule as unknown as Record<string, any>;

const log = pino({
  name: "plan-review-decisions",
  level: process.env.LOG_LEVEL ?? "info",
});

type Db = any;

export type PlanReviewDecisionRequestSchema = {
  version: 1;
  sourceArtifactId: string;
  decisionId: string;
  question: string;
  options: PlanReviewV1["decisions"][number]["options"];
  recommendation?: string;
};

export type PlanReviewDecisionRequest = {
  id: string;
  decisionId: string;
};

export function isPlanReviewDecisionRequestSchema(
  value: unknown,
): value is PlanReviewDecisionRequestSchema {
  if (!value || typeof value !== "object") return false;

  const schema = value as Partial<PlanReviewDecisionRequestSchema>;

  return (
    schema.version === 1 &&
    typeof schema.sourceArtifactId === "string" &&
    typeof schema.decisionId === "string" &&
    typeof schema.question === "string" &&
    Array.isArray(schema.options)
  );
}

export async function createPlanReviewDecisionRequests({
  db,
  projectId,
  runId,
  nodeId,
  parentHitlRequestId,
  sourceArtifactId,
  decisions,
  roleRefs,
}: {
  db: Db;
  projectId: string;
  runId: string;
  nodeId: string;
  parentHitlRequestId: string;
  sourceArtifactId: string;
  decisions: PlanReviewV1["decisions"];
  roleRefs: readonly string[];
}): Promise<PlanReviewDecisionRequest[]> {
  const requests: PlanReviewDecisionRequest[] = [];

  for (const decision of decisions) {
    const schema: PlanReviewDecisionRequestSchema = {
      version: 1,
      sourceArtifactId,
      decisionId: decision.id,
      question: decision.question,
      options: decision.options,
      ...(decision.recommendation
        ? { recommendation: decision.recommendation }
        : {}),
    };
    const requestId = randomUUID();
    const [inserted] = await db
      .insert(hitlRequests)
      .values({
        id: requestId,
        runId,
        stepId: nodeId,
        kind: "decision_request",
        schema,
        prompt: `Plan decision required: ${decision.question}`,
        parentHitlRequestId,
        sourceArtifactId,
        decisionId: decision.id,
      })
      .onConflictDoNothing()
      .returning({
        id: hitlRequests.id,
        parentHitlRequestId: hitlRequests.parentHitlRequestId,
      });
    const persisted =
      inserted ??
      (
        await db
          .select({
            id: hitlRequests.id,
            parentHitlRequestId: hitlRequests.parentHitlRequestId,
          })
          .from(hitlRequests)
          .where(
            and(
              eq(hitlRequests.runId, runId),
              eq(hitlRequests.sourceArtifactId, sourceArtifactId),
              eq(hitlRequests.decisionId, decision.id),
              eq(hitlRequests.kind, "decision_request"),
            ),
          )
          .limit(1)
      )[0];

    if (!persisted || persisted.parentHitlRequestId !== parentHitlRequestId) {
      throw new MaisterError(
        "CONFLICT",
        `plan decision ${decision.id} is already owned by another review`,
      );
    }

    await createHitlAssignmentForRun({
      db,
      runId,
      hitlRequestId: persisted.id,
      nodeId,
      actionKind: "decision_request",
      roleRefs,
      title: `Plan decision: ${decision.question}`,
    });
    requests.push({ id: persisted.id, decisionId: decision.id });
  }

  log.info(
    {
      projectId,
      runId,
      parentHitlRequestId,
      sourceArtifactId,
      decisionCount: requests.length,
    },
    "plan-review decision requests ensured",
  );

  return requests;
}
