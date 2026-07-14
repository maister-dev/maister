import "server-only";

import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import pino from "pino";

import { atomicWriteBuffer } from "@/lib/atomic";
import { MaisterError } from "@/lib/errors";
import {
  parsePlanReviewContract,
  type PlanReviewV1,
} from "@/lib/flows/plan-review-contract";

const log = pino({
  name: "plan-review-artifact",
  level: process.env.LOG_LEVEL ?? "info",
});

export type PlanReviewStagingPaths = {
  planDocumentStagingPath: string;
  planReviewStagingPath: string;
  planDocumentArtifactPath: string;
  planReviewArtifactPath: string;
  planDocumentArtifactRelativePath: string;
  planReviewArtifactRelativePath: string;
};

export type CapturedPlanReviewArtifact = {
  bytes: number;
  hash: string;
  relativePath: string;
};

export type CapturedPlanReviewArtifacts = {
  contract: PlanReviewV1;
  planDocument: CapturedPlanReviewArtifact;
  planReview: CapturedPlanReviewArtifact;
};

function runDirectory(
  runtimeRoot: string,
  projectSlug: string,
  runId: string,
): string {
  return path.join(runtimeRoot, ".maister", projectSlug, "runs", runId);
}

function artifactHash(data: Buffer): string {
  return createHash("sha256").update(Uint8Array.from(data)).digest("hex");
}

function captureError(
  code: "CONFIG" | "PRECONDITION",
  message: string,
  cause?: unknown,
): MaisterError {
  return new MaisterError(code, message, {
    cause: cause instanceof Error ? cause : undefined,
  });
}

async function readBoundedRegularFile(
  filePath: string,
  maxBytes: number,
  label: "plan document" | "plan review contract",
): Promise<Buffer> {
  let fileStats: Awaited<ReturnType<typeof stat>>;

  try {
    fileStats = await stat(filePath);
  } catch (err) {
    throw captureError(
      "PRECONDITION",
      `${label} staging output is missing`,
      err,
    );
  }

  if (!fileStats.isFile()) {
    throw captureError("PRECONDITION", `${label} staging output is not a file`);
  }

  if (fileStats.size > maxBytes) {
    throw captureError(
      "PRECONDITION",
      `${label} staging output exceeds the ${maxBytes}-byte limit`,
    );
  }

  try {
    return await readFile(filePath);
  } catch (err) {
    throw captureError("PRECONDITION", `${label} staging output is unreadable`, err);
  }
}

function parsePlanReviewBytes(data: Buffer): PlanReviewV1 {
  let decoded: unknown;

  try {
    decoded = JSON.parse(data.toString("utf8")) as unknown;
  } catch (err) {
    throw captureError("CONFIG", "plan review contract is not valid JSON", err);
  }

  try {
    return parsePlanReviewContract(decoded);
  } catch (err) {
    throw captureError("CONFIG", "plan review contract does not match V1", err);
  }
}

export function planReviewStagingPaths({
  runtimeRoot,
  projectSlug,
  runId,
  nodeAttemptId,
}: {
  runtimeRoot: string;
  projectSlug: string;
  runId: string;
  nodeAttemptId: string;
}): PlanReviewStagingPaths {
  const directory = runDirectory(runtimeRoot, projectSlug, runId);
  const stagingDirectory = path.join(directory, "plan-review-staging", nodeAttemptId);
  const artifactDirectory = path.join(directory, "artifacts", nodeAttemptId);
  const planDocumentArtifactRelativePath = path.join(
    "artifacts",
    nodeAttemptId,
    "plan-document.md",
  );
  const planReviewArtifactRelativePath = path.join(
    "artifacts",
    nodeAttemptId,
    "plan-review.json",
  );

  return {
    planDocumentStagingPath: path.join(stagingDirectory, "plan.md"),
    planReviewStagingPath: path.join(stagingDirectory, "plan-review.json"),
    planDocumentArtifactPath: path.join(artifactDirectory, "plan-document.md"),
    planReviewArtifactPath: path.join(artifactDirectory, "plan-review.json"),
    planDocumentArtifactRelativePath,
    planReviewArtifactRelativePath,
  };
}

export async function capturePlanReviewArtifacts({
  paths,
  maxBytes,
}: {
  paths: PlanReviewStagingPaths;
  maxBytes: number;
}): Promise<CapturedPlanReviewArtifacts> {
  const [planDocument, planReview] = await Promise.all([
    readBoundedRegularFile(
      paths.planDocumentStagingPath,
      maxBytes,
      "plan document",
    ),
    readBoundedRegularFile(
      paths.planReviewStagingPath,
      maxBytes,
      "plan review contract",
    ),
  ]);
  const contract = parsePlanReviewBytes(planReview);

  await atomicWriteBuffer(
    paths.planDocumentArtifactPath,
    Uint8Array.from(planDocument),
  );
  await atomicWriteBuffer(
    paths.planReviewArtifactPath,
    Uint8Array.from(planReview),
  );

  const captured = {
    contract,
    planDocument: {
      bytes: planDocument.byteLength,
      hash: artifactHash(planDocument),
      relativePath: paths.planDocumentArtifactRelativePath,
    },
    planReview: {
      bytes: planReview.byteLength,
      hash: artifactHash(planReview),
      relativePath: paths.planReviewArtifactRelativePath,
    },
  };

  log.info(
    {
      planDocumentBytes: captured.planDocument.bytes,
      planDocumentHash: captured.planDocument.hash,
      planReviewBytes: captured.planReview.bytes,
      planReviewHash: captured.planReview.hash,
    },
    "plan-review artifacts captured",
  );

  return captured;
}
