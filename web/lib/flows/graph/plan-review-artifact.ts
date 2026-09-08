import "server-only";

import type { Db } from "./runner-core";
import type { RuntimeObjectOutputBinding } from "@/lib/execution-host";
import type { ExecutionRuntimeObject } from "@/lib/db/schema";

import pino from "pino";

import {
  deterministicRuntimeOutputObjectId,
  readRuntimeObjectContent,
} from "@/lib/execution-host";
import { MaisterError } from "@/lib/errors";
import {
  parsePlanReviewContract,
  type PlanReviewV1,
} from "@/lib/flows/plan-review-contract";

const log = pino({
  name: "plan-review-artifact",
  level: process.env.LOG_LEVEL ?? "info",
});

export type PlanReviewOutputBindings = {
  planDocument: RuntimeObjectOutputBinding;
  planReview: RuntimeObjectOutputBinding;
};

export type CapturedPlanReviewArtifact = {
  objectId: string;
  bytes: number;
  hash: string;
};

export type CapturedPlanReviewArtifacts = {
  contract: PlanReviewV1;
  planDocument: CapturedPlanReviewArtifact;
  planReview: CapturedPlanReviewArtifact;
};

export function planReviewOutputBindings(input: {
  runId: string;
  nodeAttemptId: string;
  assignmentId: string;
}): PlanReviewOutputBindings {
  return {
    planDocument: {
      objectId: deterministicRuntimeOutputObjectId({
        runId: input.runId,
        sourceKey: `plan-review:${input.nodeAttemptId}:assignment:${input.assignmentId}:document`,
      }),
      kind: "plan_review",
      logicalName: "plan-document.md",
      mimeType: "text/markdown",
      generation: 1,
      retentionClass: "run",
      envName: "MAISTER_PLAN_DOCUMENT_FILE",
    },
    planReview: {
      objectId: deterministicRuntimeOutputObjectId({
        runId: input.runId,
        sourceKey: `plan-review:${input.nodeAttemptId}:assignment:${input.assignmentId}:contract`,
      }),
      kind: "plan_review",
      logicalName: "plan-review.json",
      mimeType: "application/json",
      generation: 1,
      retentionClass: "run",
      envName: "MAISTER_PLAN_REVIEW_FILE",
    },
  };
}

function validateOutputMetadata(
  metadata: ExecutionRuntimeObject,
  binding: RuntimeObjectOutputBinding,
  maxBytes: number,
): CapturedPlanReviewArtifact {
  if (
    metadata.id !== binding.objectId ||
    metadata.kind !== binding.kind ||
    metadata.logicalName !== binding.logicalName ||
    metadata.mimeType !== binding.mimeType ||
    metadata.generation !== binding.generation ||
    metadata.state !== "available" ||
    metadata.sizeBytes === null ||
    metadata.sha256 === null
  ) {
    throw new MaisterError(
      "PRECONDITION",
      `runtime output ${binding.logicalName} was not sealed by the execution host`,
      { details: { reason: "runtime_object_missing" } },
    );
  }
  if (metadata.sizeBytes > BigInt(maxBytes)) {
    throw new MaisterError(
      "PRECONDITION",
      `plan-review output exceeds the ${maxBytes}-byte limit`,
      { details: { reason: "runtime_object_too_large" } },
    );
  }

  return {
    objectId: metadata.id,
    bytes: Number(metadata.sizeBytes),
    hash: metadata.sha256,
  };
}

export function parsePlanReviewBytes(data: Uint8Array): PlanReviewV1 {
  let decoded: unknown;

  try {
    decoded = JSON.parse(new TextDecoder().decode(data)) as unknown;
  } catch (cause) {
    throw new MaisterError("CONFIG", "plan review contract is not valid JSON", {
      cause: cause instanceof Error ? cause : undefined,
    });
  }

  try {
    return parsePlanReviewContract(decoded);
  } catch (cause) {
    throw new MaisterError("CONFIG", "plan review contract does not match V1", {
      cause: cause instanceof Error ? cause : undefined,
    });
  }
}

export async function capturePlanReviewArtifacts(input: {
  db: Db;
  runId: string;
  bindings: PlanReviewOutputBindings;
  maxBytes: number;
}): Promise<CapturedPlanReviewArtifacts> {
  const [planDocument, planReview] = await Promise.all([
    readRuntimeObjectContent({
      db: input.db,
      runId: input.runId,
      objectId: input.bindings.planDocument.objectId,
    }),
    readRuntimeObjectContent({
      db: input.db,
      runId: input.runId,
      objectId: input.bindings.planReview.objectId,
    }),
  ]);
  const planDocumentMetadata = validateOutputMetadata(
    planDocument.object,
    input.bindings.planDocument,
    input.maxBytes,
  );
  const planReviewMetadata = validateOutputMetadata(
    planReview.object,
    input.bindings.planReview,
    input.maxBytes,
  );
  const contract = parsePlanReviewBytes(planReview.content.bytes);
  const captured = {
    contract,
    planDocument: planDocumentMetadata,
    planReview: planReviewMetadata,
  };

  log.info(
    {
      planDocumentObjectId: captured.planDocument.objectId,
      planDocumentBytes: captured.planDocument.bytes,
      planDocumentHash: captured.planDocument.hash,
      planReviewObjectId: captured.planReview.objectId,
      planReviewBytes: captured.planReview.bytes,
      planReviewHash: captured.planReview.hash,
    },
    "plan-review runtime objects captured",
  );

  return captured;
}
