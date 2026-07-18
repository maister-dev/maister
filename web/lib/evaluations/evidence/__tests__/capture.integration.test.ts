import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { eq } from "drizzle-orm";
import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as fullSchema from "@/lib/db/schema";
import {
  captureEvidenceForExecution,
  type CaptureGitSource,
} from "@/lib/evaluations/evidence/capture";
import { sweepEvaluationEvidence } from "@/lib/evaluations/evidence/gc";
import { listSnapshotItemDtos } from "@/lib/evaluations/evidence/snapshots";
import { testPlatformRunnerRow } from "@/lib/__tests__/runner-fixtures";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

const schema = fullSchema as unknown as Record<string, any>;

let testDatabase: StartedPostgresTestDb;
let db: NodePgDatabase<typeof fullSchema>;
let projectId: string;
let taskId: string;
let flowId: string;
let executorId: string;
let studyId: string;
let executionId: string;
let runIdTerminal: string;
let runIdActive: string;
let participantTerminal: string;
let participantUnavailable: string;

// A deterministic fake git source: participant Runs keyed by runId; a participant
// with no runId (observed Run whose link was removed) resolves to `null` →
// unavailable, exercising honest absence without spawning git.
function fakeGit(): CaptureGitSource {
  return {
    async resolveWatermark({ runId }) {
      if (runId === runIdTerminal) {
        return {
          baseCommit: "b".repeat(40),
          tipSha: "a".repeat(40),
          runStatus: "Done",
          repoPath: "/repos/app",
        };
      }
      if (runId === runIdActive) {
        return {
          baseCommit: "c".repeat(40),
          tipSha: "d".repeat(40),
          runStatus: "Running",
          repoPath: "/repos/app",
        };
      }

      return null;
    },
    async readDiff({ tipSha }) {
      if (tipSha === "a".repeat(40)) {
        return {
          text: "diff --git a/x b/x\n+AWS_KEY=AKIAIOSFODNN7EXAMPLE\n+opened /repos/app/secret.ts\n",
          truncated: false,
          files: [{ path: "x", status: "M", additions: 2, deletions: 0 }],
        };
      }

      return {
        text: "diff --git a/y b/y\n+const clean = 1;\n",
        truncated: false,
        files: [{ path: "y", status: "M", additions: 1, deletions: 0 }],
      };
    },
  };
}

async function seedParticipant(args: {
  runId: string | null;
  displayOrder: number;
  label: string;
}): Promise<string> {
  const id = randomUUID();

  await db.insert(schema.evaluationParticipants).values({
    id,
    studyId,
    runId: args.runId,
    sourceType: "observed",
    label: args.label,
    displayOrder: args.displayOrder,
  });

  return id;
}

beforeAll(async () => {
  const root = await mkdtemp(join(tmpdir(), "maister-eval-capture-"));

  process.env.MAISTER_EVALUATION_EVIDENCE_ROOT = root;

  testDatabase = await startMainPostgresTestDb({
    databaseName: "maister_eval_capture_test",
  });
  db = testDatabase.db;

  projectId = randomUUID();
  taskId = randomUUID();
  flowId = randomUUID();
  executorId = randomUUID();

  await db.insert(schema.projects).values({
    taskKey: `T${randomUUID().slice(0, 8)}`.toUpperCase(),
    id: projectId,
    slug: `proj-${projectId.slice(0, 8)}`,
    name: "Test",
    repoPath: `/tmp/proj-${projectId.slice(0, 8)}`,
    maisterYamlPath: "/tmp/m.yaml",
  });
  await db
    .insert(schema.platformAcpRunners)
    .values(testPlatformRunnerRow(executorId, "claude"));
  await db.insert(schema.flows).values({
    id: flowId,
    projectId,
    flowRefId: "bugfix",
    source: "github.com/x/y",
    version: "v1.0.0",
    installedPath: "/tmp/flows/bugfix",
    manifest: { schemaVersion: 1, name: "Bugfix", nodes: [] },
    schemaVersion: 1,
  });
  await db.insert(schema.tasks).values({
    number: Number.parseInt(randomUUID().slice(0, 6), 16),
    id: taskId,
    projectId,
    title: "Implement widget",
    prompt: "Build the widget per spec.",
    flowId,
  });

  runIdTerminal = randomUUID();
  runIdActive = randomUUID();

  for (const runId of [runIdTerminal, runIdActive]) {
    await db.insert(schema.runs).values({
      id: runId,
      taskId,
      projectId,
      flowId,
      runnerId: executorId,
      capabilityAgent: "claude",
      flowVersion: "v1.0.0",
      runKind: "flow",
    });
  }

  studyId = randomUUID();
  await db.insert(schema.evaluationStudies).values({
    id: studyId,
    projectId,
    taskId,
    title: "S",
    status: "open",
  });

  participantTerminal = await seedParticipant({
    runId: runIdTerminal,
    displayOrder: 0,
    label: "A",
  });
  await seedParticipant({
    runId: runIdActive,
    displayOrder: 1,
    label: "B",
  });
  participantUnavailable = await seedParticipant({
    runId: null,
    displayOrder: 2,
    label: "C",
  });

  executionId = randomUUID();
  await db.insert(schema.evaluationExecutions).values({
    id: executionId,
    studyId,
    status: "capturing",
  });
}, 180_000);

afterAll(async () => {
  delete process.env.MAISTER_EVALUATION_EVIDENCE_ROOT;
  await testDatabase?.stop();
});

describe("captureEvidenceForExecution", () => {
  it("captures a commit-anchored snapshot with coverage classes, redaction, and honest absence", async () => {
    const result = await captureEvidenceForExecution(
      { executionId, evidenceProtocolDigest: "proto-cap-1" },
      { git: fakeGit() },
      db,
    );

    expect(result.reused).toBe(false);
    expect(result.snapshotId).toBeTruthy();

    // captured (ground_truth + file summaries), redacted (secret+path diff),
    // uncommitted_not_captured (active Run), unavailable (removed link).
    expect(result.coverage.redacted).toBe(1);
    expect(result.coverage.uncommitted_not_captured).toBe(1);
    expect(result.coverage.unavailable).toBe(1);
    expect(result.warnings.length).toBeGreaterThanOrEqual(2);

    const dtos = await listSnapshotItemDtos(result.snapshotId, db);
    const byCoverage = dtos.reduce<Record<string, number>>((acc, d) => {
      acc[d.coverageClass] = (acc[d.coverageClass] ?? 0) + 1;

      return acc;
    }, {});

    // Ground-truth (shared, participantId null) + 2 diffs + 2 file summaries +
    // 1 uncommitted marker + 1 unavailable diff = 7 items.
    expect(dtos.length).toBe(7);
    expect(byCoverage.uncommitted_not_captured).toBe(1);
    expect(byCoverage.unavailable).toBe(1);
    expect(byCoverage.redacted).toBe(1);

    // The redacted diff item records the redaction count, and DTOs never leak
    // the locator or blobKey.
    const redactedItem = dtos.find((d) => d.coverageClass === "redacted");

    expect(redactedItem?.redaction).toMatchObject({
      count: expect.any(Number),
    });
    for (const d of dtos) {
      expect(d).not.toHaveProperty("locator");
      expect(d).not.toHaveProperty("blobKey");
    }

    // The persisted watermark carries no host repoPath (D3 privacy).
    const [snap] = await db
      .select({
        participantWatermarks:
          schema.evaluationEvidenceSnapshots.participantWatermarks,
        coverageSummary: schema.evaluationEvidenceSnapshots.coverageSummary,
        status: schema.evaluationEvidenceSnapshots.status,
      })
      .from(schema.evaluationEvidenceSnapshots)
      .where(eq(schema.evaluationEvidenceSnapshots.id, result.snapshotId));

    expect(snap.status).toBe("sealed");
    expect(JSON.stringify(snap.participantWatermarks)).not.toContain("/repos");
    expect(snap.participantWatermarks[participantTerminal].tipSha).toBe(
      "a".repeat(40),
    );
    expect(snap.participantWatermarks[participantUnavailable].unavailable).toBe(
      true,
    );
    expect(snap.coverageSummary.redacted).toBe(1);
  });

  it("reuses the sealed snapshot for a second execution with identical watermarks", async () => {
    const secondExec = randomUUID();

    await db.insert(schema.evaluationExecutions).values({
      id: secondExec,
      studyId,
      status: "capturing",
    });

    const first = await captureEvidenceForExecution(
      { executionId, evidenceProtocolDigest: "proto-reuse-2" },
      { git: fakeGit() },
      db,
    );
    const second = await captureEvidenceForExecution(
      { executionId: secondExec, evidenceProtocolDigest: "proto-reuse-2" },
      { git: fakeGit() },
      db,
    );

    expect(second.reused).toBe(true);
    expect(second.snapshotId).toBe(first.snapshotId);
  });

  it("refuses to capture a study with fewer than 2 live participants", async () => {
    const soloStudy = randomUUID();

    await db.insert(schema.evaluationStudies).values({
      id: soloStudy,
      projectId,
      taskId,
      title: "solo",
      status: "open",
    });
    await db.insert(schema.evaluationParticipants).values({
      id: randomUUID(),
      studyId: soloStudy,
      runId: runIdTerminal,
      sourceType: "observed",
      label: "only",
      displayOrder: 0,
    });
    const soloExec = randomUUID();

    await db.insert(schema.evaluationExecutions).values({
      id: soloExec,
      studyId: soloStudy,
      status: "capturing",
    });

    await expect(
      captureEvidenceForExecution(
        { executionId: soloExec, evidenceProtocolDigest: "proto-solo" },
        { git: fakeGit() },
        db,
      ),
    ).rejects.toThrow(/fewer than 2 live participants/);
  });
});

describe("sweepEvaluationEvidence", () => {
  it("marks orphan preparing snapshots pending_delete and finalizes unreferenced pending_delete", async () => {
    const old = new Date(Date.now() - 3 * 60 * 60 * 1000);
    const orphanId = randomUUID();
    const staleDeleteId = randomUUID();
    const referencedDeleteId = randomUUID();

    // A crashed capture: preparing, created long ago.
    await db.insert(schema.evaluationEvidenceSnapshots).values({
      id: orphanId,
      studyId,
      status: "preparing",
      participantWatermarks: {},
      evidenceProtocolDigest: "orphan",
      createdAt: old,
    });
    // A pending_delete past grace, cited by no execution → deletable.
    await db.insert(schema.evaluationEvidenceSnapshots).values({
      id: staleDeleteId,
      studyId,
      status: "pending_delete",
      participantWatermarks: {},
      evidenceProtocolDigest: "stale",
      pendingDeleteAt: old,
    });
    // A pending_delete cited by an execution → the guard keeps it.
    await db.insert(schema.evaluationEvidenceSnapshots).values({
      id: referencedDeleteId,
      studyId,
      status: "pending_delete",
      participantWatermarks: {},
      evidenceProtocolDigest: "referenced",
      pendingDeleteAt: old,
    });
    const citingExec = randomUUID();

    await db.insert(schema.evaluationExecutions).values({
      id: citingExec,
      studyId,
      status: "queued",
      evidenceSnapshotId: referencedDeleteId,
    });

    const summary = await sweepEvaluationEvidence(
      { orphanPreparingAgeMs: 60_000, pendingDeleteGraceMs: 60_000 },
      db,
    );

    expect(summary.orphansMarked).toBeGreaterThanOrEqual(1);
    expect(summary.deleted).toBeGreaterThanOrEqual(1);

    const rows = await db
      .select({
        id: schema.evaluationEvidenceSnapshots.id,
        status: schema.evaluationEvidenceSnapshots.status,
      })
      .from(schema.evaluationEvidenceSnapshots);
    const status = (id: string) =>
      rows.find((r: { id: string }) => r.id === id)?.status;

    expect(status(orphanId)).toBe("pending_delete");
    expect(status(staleDeleteId)).toBe("deleted");
    // The cited snapshot is NOT finalized — the reference guard holds.
    expect(status(referencedDeleteId)).toBe("pending_delete");
  });
});
