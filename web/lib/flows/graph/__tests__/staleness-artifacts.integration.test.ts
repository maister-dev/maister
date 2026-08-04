// T4.1: Test that markDownstreamStale ALSO marks downstream node artifacts
// as stale (validity=current → stale), not just node_attempts.
//
// Contract: When an upstream node is reworked, both:
// 1. Downstream node_attempts are marked Stale
// 2. Downstream node's current artifacts are marked stale (validity=current → stale)
// 3. Recording a new artifact for the same def supersedes stale → current

import type { ArtifactInstance, NodeAttempt } from "@/lib/db/schema";

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  getCurrentArtifact,
  getArtifactsForRun,
  recordArtifact,
  supersedePrior,
} from "@/lib/flows/graph/artifact-store";
import { runFlow } from "@/lib/flows/runner";
import {
  schema,
  seedGraphRun,
  type SeededGraphRun,
} from "@/test-support/graph-run-seed";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

let testDatabase: StartedPostgresTestDb;
let db: NodePgDatabase;

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "maister_test",
  });

  db = testDatabase.db;
}, 180_000);

afterAll(async () => {
  await testDatabase?.stop();
});

async function getAttempts(runId: string): Promise<NodeAttempt[]> {
  return (await db
    .select()
    .from(schema.nodeAttempts)
    .where(eq(schema.nodeAttempts.runId, runId))) as unknown as NodeAttempt[];
}

async function getArtifacts(runId: string): Promise<ArtifactInstance[]> {
  return getArtifactsForRun(runId, db);
}

async function writeDecision(
  seeded: SeededGraphRun,
  nodeId: string,
  decision: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const dir = join(
    seeded.runtimeRoot,
    ".maister",
    seeded.slug,
    "runs",
    seeded.runId,
  );

  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, `input-${nodeId}.json`),
    JSON.stringify({ decision, ...extra }),
    "utf8",
  );
}

describe("T4.1: artifact staleness on rework", () => {
  it("rework → downstream node's current artifacts are marked stale", async () => {
    const seeded = await seedGraphRun(db, {
      schemaVersion: 1,
      name: "g",
      compat: { engine_min: "1.1.0" },
      nodes: [
        {
          id: "work",
          type: "cli",
          action: { command: "echo work {{ review_comments ?? '' }}" },
          transitions: { success: "check" },
        },
        {
          id: "check",
          type: "cli",
          action: { command: "echo check" },
          transitions: { success: "review" },
        },
        {
          id: "review",
          type: "human",
          finish: {
            human: {
              role: "maintainer",
              decisions: ["approve", "rework"],
              commentsVar: "review_comments",
            },
          },
          transitions: { approve: "done", rework: "work" },
          rework: {
            allowedTargets: ["work"],
            workspacePolicies: ["keep"],
            maxLoops: 1,
            commentsVar: "review_comments",
          },
        },
      ],
    });

    // Run to completion
    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });

    const firstAttempts = await getAttempts(seeded.runId);
    const checkFirstAttempt = firstAttempts.find((a) => a.nodeId === "check");

    // Manually seed an artifact for the check node (simulating a produced artifact)
    if (checkFirstAttempt) {
      await recordArtifact(
        {
          runId: seeded.runId,
          nodeId: "check",
          nodeAttemptId: checkFirstAttempt.id,
          kind: "lint_report",
          producer: "runner",
          artifactDefId: "check-result",
          locator: { kind: "inline", text: "check passed" },
          validity: "current",
        },
        db,
      );
    }

    // Verify the artifact is current before rework
    let checkArtifact = await getCurrentArtifact(
      seeded.runId,
      "check-result",
      db,
    );

    expect(checkArtifact).toBeDefined();
    expect(checkArtifact?.validity).toBe("current");

    // Now rework from review back to work
    await writeDecision(seeded, "review", "rework", {
      reworkTarget: "work",
      comments: "fix it",
    });

    // Rerun the flow (it should handle the rework decision)
    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });

    // After rework, the downstream check artifact MUST be stale
    const allArtifacts = await getArtifacts(seeded.runId);
    const stalledCheckArtifact = allArtifacts.find(
      (a) => a.artifactDefId === "check-result",
    );

    // RED: artifact validity must transition from current → stale on rework
    expect(stalledCheckArtifact).toBeDefined();
    expect(stalledCheckArtifact?.validity).toBe("stale");
  });

  it("after staling, recording a new artifact for the same def supersedes stale → current", async () => {
    const seeded = await seedGraphRun(db, {
      schemaVersion: 1,
      name: "g",
      compat: { engine_min: "1.1.0" },
      nodes: [
        {
          id: "work",
          type: "cli",
          action: { command: "echo work" },
          transitions: { success: "check" },
        },
        {
          id: "check",
          type: "cli",
          action: { command: "echo check" },
          transitions: { success: "done" },
        },
      ],
    });

    // Run to completion
    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });

    const attempts = await getAttempts(seeded.runId);
    const checkAttempt = attempts.find((a) => a.nodeId === "check");

    // Record an initial artifact
    if (checkAttempt) {
      await recordArtifact(
        {
          runId: seeded.runId,
          nodeId: "check",
          nodeAttemptId: checkAttempt.id,
          kind: "lint_report",
          producer: "runner",
          artifactDefId: "test-report",
          locator: { kind: "inline", text: "v1" },
          validity: "current",
        },
        db,
      );

      // Manually stale it (simulating what markDownstreamStale does)
      const artifacts = await getArtifacts(seeded.runId);
      const testReportId = artifacts.find(
        (a) => a.artifactDefId === "test-report",
      )?.id;

      expect(testReportId).toBeDefined();

      // Stale the artifact
      if (testReportId) {
        await db
          .update(schema.artifactInstances)
          .set({ validity: "stale" })
          .where(eq(schema.artifactInstances.id, testReportId));
      }

      // Verify it's now stale
      let staleArtifact = await getCurrentArtifact(
        seeded.runId,
        "test-report",
        db,
      );

      expect(staleArtifact).toBeUndefined(); // getCurrentArtifact only returns validity='current'

      // Record a new artifact with supersedePrior
      const newArtifactId = randomUUID();

      await recordArtifact(
        {
          id: newArtifactId,
          runId: seeded.runId,
          nodeId: "check",
          nodeAttemptId: checkAttempt.id,
          kind: "lint_report",
          producer: "runner",
          artifactDefId: "test-report",
          locator: { kind: "inline", text: "v2" },
          validity: "current",
        },
        db,
      );

      await supersedePrior(
        seeded.runId,
        "check",
        "test-report",
        newArtifactId,
        db,
      );

      // RED: new artifact must be current, old stale artifact superseded
      const newCurrent = await getCurrentArtifact(
        seeded.runId,
        "test-report",
        db,
      );

      expect(newCurrent).toBeDefined();
      expect(newCurrent?.id).toBe(newArtifactId);
      expect(newCurrent?.validity).toBe("current");
    }
  });
});
