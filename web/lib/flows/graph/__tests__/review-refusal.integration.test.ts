// T4.4 INTEGRATION TEST: review refusal when evidence is not ready
//
// End-to-end test: a human_review node with a blocking artifact_required gate
// in pre_finish that checks for a required artifact. When the artifact is
// missing/stale, the gate fails, the node cannot finish (review is refused),
// and the run does not become Done. Once the artifact is produced and current,
// the approval succeeds and the run transitions to Done.

import type { Run } from "@/lib/db/schema";

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { eq } from "drizzle-orm";
import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { recordArtifact } from "@/lib/flows/graph/artifact-store";
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

async function getRun(runId: string): Promise<Run> {
  const rows = (await db
    .select()
    .from(schema.runs)
    .where(eq(schema.runs.id, runId))) as unknown as Run[];

  return rows[0];
}

async function writeDecision(
  seeded: SeededGraphRun,
  nodeId: string,
  decision: string,
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
    JSON.stringify({ decision }),
    "utf8",
  );
}

describe("T4.4: review refusal when evidence not ready (integration)", () => {
  it("blocking artifact_required gate failing in pre_finish prevents node approval", async () => {
    // This test validates the review refusal flow: when a human_review node
    // has a blocking artifact_required gate in pre_finish, and the required
    // artifact is missing/stale, approval is refused and the run stays in Review.
    const seeded = await seedGraphRun(db, {
      schemaVersion: 1,
      name: "g",
      compat: { engine_min: "1.1.0" },
      nodes: [
        {
          id: "work",
          type: "cli",
          action: { command: "echo work {{ review_comments ?? '' }}" },
          transitions: { success: "review" },
        },
        {
          id: "review",
          type: "human",
          pre_finish: {
            gates: [
              {
                id: "verify-evidence",
                kind: "artifact_required",
                mode: "blocking",
                inputArtifacts: ["implementation-diff"],
              },
            ],
          },
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

    // Run the flow; the human node pauses for HITL → NeedsInput
    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });

    let run = await getRun(seeded.runId);

    expect(run.status).toBe("NeedsInput");

    // Do NOT seed the "implementation-diff" artifact.
    // Write an approval decision; the gate fires at node-finish and must block.
    await writeDecision(seeded, "review", "approve");

    // Re-run: the human node reads the decision, pre_finish gate fires,
    // artifact is missing → blocking gate fails → node fails → run Failed.
    // RED: the run MUST NOT become Done (gate prevented approval).
    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });
    run = await getRun(seeded.runId);
    expect(run.status).not.toBe("Done");
    expect(run.status).toBe("Failed");
  });

  it("once required artifact becomes current, approval succeeds", async () => {
    // After a blocking artifact_required gate fails, once the artifact
    // is recorded and current, the gate should pass and approval should succeed.
    const seeded = await seedGraphRun(db, {
      schemaVersion: 1,
      name: "g",
      compat: { engine_min: "1.1.0" },
      nodes: [
        {
          id: "work",
          type: "cli",
          action: { command: "echo work" },
          transitions: { success: "review" },
        },
        {
          id: "review",
          type: "human",
          pre_finish: {
            gates: [
              {
                id: "verify-evidence",
                kind: "artifact_required",
                mode: "blocking",
                inputArtifacts: ["implementation-diff"],
              },
            ],
          },
          finish: {
            human: {
              role: "maintainer",
              decisions: ["approve"],
            },
          },
          transitions: { approve: "done" },
        },
      ],
    });

    // Run to review
    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });

    // Record the required artifact after work ran (run-level, no FK issue)
    await recordArtifact(
      {
        runId: seeded.runId,
        nodeId: "work",
        kind: "diff",
        producer: "runner",
        artifactDefId: "implementation-diff",
        locator: { kind: "inline", text: "diff content" },
        validity: "current",
        requiredFor: ["review"],
      },
      db,
    );

    // Write the approval decision so the next runFlow pass can finish the review
    await writeDecision(seeded, "review", "approve");

    // RED: Once the artifact is current and the blocking gate passes,
    // approval should succeed and the run MUST transition to Review
    // (graph-terminal state after a successful human approval).
    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });
    let run = await getRun(seeded.runId);

    expect(run.status).toBe("Review");
  });
});

// F1: the requiredFor:[review] contract must be enforced at the review-approval
// chokepoint even when the review node declares NO artifact_required gate. The
// gate alone only checks its own inputArtifacts; assertEvidenceReady("review")
// is the runner-side guard for the global requiredFor:[review] def-current rule.
describe("F1: review-evidence guard without an explicit gate (integration)", () => {
  it("refuses approval when a requiredFor:[review] def has no current row", async () => {
    const seeded = await seedGraphRun(db, {
      schemaVersion: 1,
      name: "g",
      compat: { engine_min: "1.2.0" },
      nodes: [
        {
          id: "work",
          type: "cli",
          action: { command: "echo work" },
          transitions: { success: "review" },
        },
        {
          id: "review",
          type: "human",
          // NO pre_finish.gates — the only evidence guard is the runner.
          finish: { human: { role: "maintainer", decisions: ["approve"] } },
          transitions: { approve: "done" },
        },
      ],
    });

    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });
    expect((await getRun(seeded.runId)).status).toBe("NeedsInput");

    // A requiredFor:[review] def exists but only as a stale (non-current) row.
    await recordArtifact(
      {
        runId: seeded.runId,
        nodeId: "work",
        kind: "diff",
        producer: "runner",
        artifactDefId: "impl-diff",
        locator: { kind: "inline", text: "v1" },
        validity: "stale",
        requiredFor: ["review"],
      },
      db,
    );

    await writeDecision(seeded, "review", "approve");
    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });

    const run = await getRun(seeded.runId);

    expect(run.status).not.toBe("Done");
    expect(run.status).toBe("Failed");
  });

  it("allows approval once the requiredFor:[review] def is current", async () => {
    const seeded = await seedGraphRun(db, {
      schemaVersion: 1,
      name: "g",
      compat: { engine_min: "1.2.0" },
      nodes: [
        {
          id: "work",
          type: "cli",
          action: { command: "echo work" },
          transitions: { success: "review" },
        },
        {
          id: "review",
          type: "human",
          finish: { human: { role: "maintainer", decisions: ["approve"] } },
          transitions: { approve: "done" },
        },
      ],
    });

    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });

    await recordArtifact(
      {
        runId: seeded.runId,
        nodeId: "work",
        kind: "diff",
        producer: "runner",
        artifactDefId: "impl-diff",
        locator: { kind: "inline", text: "v1" },
        validity: "current",
        requiredFor: ["review"],
      },
      db,
    );

    await writeDecision(seeded, "review", "approve");
    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });

    expect((await getRun(seeded.runId)).status).toBe("Review");
  });
});
