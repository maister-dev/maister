import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  capturePlanReviewArtifacts,
  planReviewStagingPaths,
} from "../plan-review-artifact";

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map(async (directory) => {
      await import("node:fs/promises").then(({ rm }) =>
        rm(directory, { recursive: true, force: true }),
      );
    }),
  );
});

function validContract(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    plan: { title: "Typed review", documentArtifact: "plan-document" },
    assumptions: [],
    decisions: [
      {
        id: "runtime",
        question: "Which runtime?",
        options: [
          { id: "node", label: "Node", consequences: "Use the existing runtime." },
          { id: "bun", label: "Bun", consequences: "Add a new runtime." },
        ],
        recommendation: "node",
        blocking: true,
      },
    ],
  };
}

describe("plan-review artifact capture", () => {
  it("validates staging outputs and copies immutable, hashed artifacts", async () => {
    const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "plan-review-"));
    tempDirectories.push(runtimeRoot);
    const paths = planReviewStagingPaths({
      runtimeRoot,
      projectSlug: "demo",
      runId: "run-1",
      nodeAttemptId: "attempt-1",
    });
    const plan = "# Typed review\n";
    const review = JSON.stringify(validContract());

    await mkdir(path.dirname(paths.planDocumentStagingPath), { recursive: true });
    await writeFile(paths.planDocumentStagingPath, plan);
    await writeFile(paths.planReviewStagingPath, review);

    const captured = await capturePlanReviewArtifacts({
      paths,
      maxBytes: 10_000,
    });

    expect(captured.contract.decisions).toHaveLength(1);
    expect(captured.planDocument.hash).toBe(
      createHash("sha256").update(plan).digest("hex"),
    );
    expect(captured.planReview.hash).toBe(
      createHash("sha256").update(review).digest("hex"),
    );
    await expect(readFile(paths.planDocumentArtifactPath, "utf8")).resolves.toBe(
      plan,
    );
    await expect(readFile(paths.planReviewArtifactPath, "utf8")).resolves.toBe(
      review,
    );
  });

  it("refuses malformed contract files before copying a review artifact", async () => {
    const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "plan-review-"));
    tempDirectories.push(runtimeRoot);
    const paths = planReviewStagingPaths({
      runtimeRoot,
      projectSlug: "demo",
      runId: "run-1",
      nodeAttemptId: "attempt-1",
    });

    await mkdir(path.dirname(paths.planDocumentStagingPath), { recursive: true });
    await writeFile(paths.planDocumentStagingPath, "# Plan\n");
    await writeFile(paths.planReviewStagingPath, "{not-json");

    await expect(
      capturePlanReviewArtifacts({ paths, maxBytes: 10_000 }),
    ).rejects.toMatchObject({ code: "CONFIG" });
    await expect(readFile(paths.planReviewArtifactPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
