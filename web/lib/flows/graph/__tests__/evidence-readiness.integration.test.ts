import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as fullSchema from "@/lib/db/schema";
import {
  testPlatformRunnerRow,
  testRunnerSnapshot,
} from "@/lib/__tests__/runner-fixtures";
import { recordArtifact } from "@/lib/flows/graph/artifact-store";
import { assertEvidenceReady } from "@/lib/flows/graph/evidence-readiness";
import {
  createGateResult,
  markGateFailed,
  markGatePassed,
} from "@/lib/flows/graph/gate-store";
import { runFlow } from "@/lib/flows/runner";

const schema = fullSchema as unknown as Record<string, any>;

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("maister_test")
    .withUsername("test")
    .withPassword("test")
    .start();

  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);
  await migrate(db, { migrationsFolder: "./lib/db/migrations" });
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

type Seeded = {
  runId: string;
  runtimeRoot: string;
};

async function seedGraphRun(manifest: unknown): Promise<Seeded> {
  const projectId = randomUUID();
  const slug = `proj-${projectId.slice(0, 8)}`;
  const executorId = randomUUID();
  const flowId = randomUUID();
  const taskId = randomUUID();
  const runId = randomUUID();
  const worktreePath = await mkdtemp(join(tmpdir(), "wt-"));
  const runtimeRoot = await mkdtemp(join(tmpdir(), "rt-"));

  await db.insert(schema.projects).values({ taskKey: `T${crypto.randomUUID().slice(0, 8)}`.toUpperCase(),
    id: projectId,
    slug,
    name: "Test",
    repoPath: `/tmp/${slug}`,
    maisterYamlPath: "/tmp/m.yaml",
  });
  await db
    .insert(schema.platformAcpRunners)
    .values(testPlatformRunnerRow(executorId, "claude"));
  await db.insert(schema.flows).values({
    id: flowId,
    projectId,
    flowRefId: "g",
    source: "github.com/x/y",
    version: "v1.0.0",
    installedPath: "/tmp/flows/g",
    manifest,
    schemaVersion: 1,
  });
  await db.insert(schema.tasks).values({ number: Math.trunc(Math.random() * 1e9) + 1,
    id: taskId,
    projectId,
    title: "t",
    prompt: "p",
    flowId,
  });
  await db.insert(schema.runs).values({
    id: runId,
    taskId,
    projectId,
    flowId,
    runnerId: executorId,
    capabilityAgent: "claude",
    runnerSnapshot: testRunnerSnapshot(executorId),
    flowVersion: "v1.0.0",
    status: "Running",
  });
  await db.insert(schema.workspaces).values({
    id: randomUUID(),
    runId,
    projectId,
    branch: "feature/test",
    worktreePath,
    parentRepoPath: `/tmp/${slug}`,
  });

  return { runId, runtimeRoot };
}

async function getNodeAttempts(runId: string) {
  return (await db
    .select()
    .from(schema.nodeAttempts)
    .where(eq(schema.nodeAttempts.runId, runId))) as unknown as any[];
}

describe("T4.4: assertEvidenceReady (integration)", () => {
  it("no merge evidence declared → ready=true (evidence is opt-in)", async () => {
    const seeded = await seedGraphRun({
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

    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });

    // No requiredFor:[merge] artifacts and no artifact_required gates declared.
    // Evidence is opt-in → vacuously ready (nothing blocks merge). A flow opts
    // into merge gating by declaring requiredFor:[merge] produces or a blocking
    // artifact_required gate.
    const result = await assertEvidenceReady(seeded.runId, "merge", db);

    expect(result.ready).toBe(true);
    expect(result.reasons).toHaveLength(0);
  });

  it("artifact with requiredFor:[merge] current → ready=true", async () => {
    const seeded = await seedGraphRun({
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

    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });

    const attempts = await getNodeAttempts(seeded.runId);
    const workAttempt = attempts.find((a) => a.nodeId === "work");

    if (workAttempt) {
      // Seed a CURRENT artifact with requiredFor:[merge]
      await recordArtifact(
        {
          runId: seeded.runId,
          nodeId: "work",
          nodeAttemptId: workAttempt.id,
          kind: "diff",
          producer: "runner",
          artifactDefId: "merge-artifact",
          locator: { kind: "inline", text: "merged content" },
          validity: "current",
          requiredFor: ["merge"],
        },
        db,
      );
    }

    // RED: assertEvidenceReady must return ready=true when artifact current
    const result = await assertEvidenceReady(seeded.runId, "merge", db);

    expect(result.ready).toBe(true);
    expect(result.reasons).toHaveLength(0);
  });

  it("artifact with requiredFor:[merge] stale → ready=false", async () => {
    const seeded = await seedGraphRun({
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
      ],
    });

    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });

    const attempts = await getNodeAttempts(seeded.runId);
    const workAttempt = attempts.find((a) => a.nodeId === "work");

    if (workAttempt) {
      // Seed a STALE artifact
      await recordArtifact(
        {
          runId: seeded.runId,
          nodeId: "work",
          nodeAttemptId: workAttempt.id,
          kind: "diff",
          producer: "runner",
          artifactDefId: "stale-merge",
          locator: { kind: "inline", text: "old content" },
          validity: "stale",
          requiredFor: ["merge"],
        },
        db,
      );
    }

    // RED: assertEvidenceReady must return ready=false when artifact stale
    const result = await assertEvidenceReady(seeded.runId, "merge", db);

    expect(result.ready).toBe(false);
    expect(result.reasons.length).toBeGreaterThan(0);
  });

  it("blocking artifact_required gate failed → ready=false", async () => {
    const seeded = await seedGraphRun({
      schemaVersion: 1,
      name: "g",
      compat: { engine_min: "1.1.0" },
      nodes: [
        {
          id: "work",
          type: "cli",
          action: { command: "echo work" },
          pre_finish: {
            gates: [
              {
                id: "verify-merge",
                kind: "artifact_required",
                mode: "blocking",
                inputArtifacts: ["missing-for-merge"],
              },
            ],
          },
          transitions: { success: "done" },
        },
      ],
    });

    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });

    // Gate fails because artifact is missing
    // RED: assertEvidenceReady must return ready=false when blocking gate fails
    const result = await assertEvidenceReady(seeded.runId, "merge", db);

    expect(result.ready).toBe(false);
    expect(result.reasons.length).toBeGreaterThan(0);
  });

  it("blocking artifact_required gate passed → does not block readiness", async () => {
    const seeded = await seedGraphRun({
      schemaVersion: 1,
      name: "g",
      compat: { engine_min: "1.1.0" },
      nodes: [
        {
          id: "work",
          type: "cli",
          action: { command: "echo work" },
          pre_finish: {
            gates: [
              {
                id: "verify-merge",
                kind: "artifact_required",
                mode: "blocking",
                inputArtifacts: ["verified-for-merge"],
              },
            ],
          },
          transitions: { success: "done" },
        },
      ],
    });

    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });

    const attempts = await getNodeAttempts(seeded.runId);
    const workAttempt = attempts.find((a) => a.nodeId === "work");

    if (workAttempt) {
      // Seed the required artifact so gate passes
      await recordArtifact(
        {
          runId: seeded.runId,
          nodeId: "work",
          nodeAttemptId: workAttempt.id,
          kind: "lint_report",
          producer: "runner",
          artifactDefId: "verified-for-merge",
          locator: { kind: "inline", text: "verified" },
          validity: "current",
        },
        db,
      );
    }

    // RED: assertEvidenceReady must return ready=true when blocking gate passes
    const result = await assertEvidenceReady(seeded.runId, "merge", db);

    expect(result.ready).toBe(true);
  });

  it("advisory artifact_required gate failed → does not block readiness", async () => {
    const seeded = await seedGraphRun({
      schemaVersion: 1,
      name: "g",
      compat: { engine_min: "1.1.0" },
      nodes: [
        {
          id: "work",
          type: "cli",
          action: { command: "echo work" },
          pre_finish: {
            gates: [
              {
                id: "optional-check",
                kind: "artifact_required",
                mode: "advisory",
                inputArtifacts: ["optional-artifact"],
              },
            ],
          },
          transitions: { success: "done" },
        },
      ],
    });

    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });

    // Advisory gate fails (artifact missing) but does not block
    // RED: assertEvidenceReady must return ready=true (advisory is non-blocking)
    const result = await assertEvidenceReady(seeded.runId, "merge", db);

    expect(result.ready).toBe(true);
  });

  it("phase='review' checks requiredFor:[review] or [review,merge]", async () => {
    const seeded = await seedGraphRun({
      schemaVersion: 1,
      name: "g",
      compat: { engine_min: "1.1.0" },
      nodes: [
        {
          id: "work",
          type: "cli",
          action: { command: "echo work" },
          transitions: { success: "done" },
        },
      ],
    });

    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });

    const attempts = await getNodeAttempts(seeded.runId);
    const workAttempt = attempts.find((a) => a.nodeId === "work");

    if (workAttempt) {
      // Seed artifact with requiredFor:[review,merge]
      await recordArtifact(
        {
          runId: seeded.runId,
          nodeId: "work",
          nodeAttemptId: workAttempt.id,
          kind: "lint_report",
          producer: "runner",
          artifactDefId: "review-and-merge-artifact",
          locator: { kind: "inline", text: "content" },
          validity: "current",
          requiredFor: ["review", "merge"],
        },
        db,
      );
    }

    // RED: assertEvidenceReady(phase="review") must check [review,merge] artifacts
    const result = await assertEvidenceReady(seeded.runId, "review", db);

    expect(result.ready).toBe(true);
  });

  it("phase='merge' ignores requiredFor:[review]-only artifacts", async () => {
    const seeded = await seedGraphRun({
      schemaVersion: 1,
      name: "g",
      compat: { engine_min: "1.1.0" },
      nodes: [
        {
          id: "work",
          type: "cli",
          action: { command: "echo work" },
          transitions: { success: "done" },
        },
      ],
    });

    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });

    const attempts = await getNodeAttempts(seeded.runId);
    const workAttempt = attempts.find((a) => a.nodeId === "work");

    if (workAttempt) {
      // Seed artifact with requiredFor:[review] only
      await recordArtifact(
        {
          runId: seeded.runId,
          nodeId: "work",
          nodeAttemptId: workAttempt.id,
          kind: "lint_report",
          producer: "runner",
          artifactDefId: "review-only",
          locator: { kind: "inline", text: "review data" },
          validity: "stale",
          requiredFor: ["review"],
        },
        db,
      );
    }

    // assertEvidenceReady(phase="merge") must IGNORE [review]-only artifacts.
    const result = await assertEvidenceReady(seeded.runId, "merge", db);

    // The stale [review]-only artifact is irrelevant to the merge phase, and
    // no [merge] evidence is declared → vacuously ready for merge.
    expect(result.ready).toBe(true);
  });
});

// ============================================================================
// M29 (ADR-074, D-C7): assertion-failed mutation gates must not self-clear
// ============================================================================

describe("M29: readiness assertion-awareness (integration)", () => {
  const plainWorkManifest = {
    schemaVersion: 1,
    name: "g",
    compat: { engine_min: "1.2.0" },
    nodes: [
      {
        id: "work",
        type: "cli",
        action: { command: "echo work" },
        transitions: { success: "done" },
      },
    ],
  };

  // Seed the D-C7 trap: a failed blocking artifact_required gate whose input
  // artifact IS current. Returns the work attempt id.
  async function seedAssertionFailedGate(
    runId: string,
    workAttemptId: string,
    verdictPayload: Record<string, unknown> | undefined,
  ): Promise<void> {
    await recordArtifact(
      {
        runId,
        nodeId: "work",
        nodeAttemptId: workAttemptId,
        kind: "diff",
        producer: "runner",
        artifactDefId: "impl-diff",
        locator: { kind: "inline", text: "diff content" },
        validity: "current",
      },
      db,
    );

    const { id } = await createGateResult({
      runId,
      nodeAttemptId: workAttemptId,
      gateId: "impl-mutation",
      kind: "artifact_required",
      mode: "blocking",
      status: "running",
      inputArtifactRefs: ["impl-diff"],
      db,
    });

    await markGateFailed(
      id,
      {
        verdict: "fail",
        reasons: ["must_touch: no path matched [src/**]"],
        ...(verdictPayload !== undefined ? { payload: verdictPayload } : {}),
      },
      db,
    );
  }

  it("blocked: assertion-failed blocking gate stays failed even with inputs present", async () => {
    const seeded = await seedGraphRun(plainWorkManifest);

    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });

    const workAttempt = (await getNodeAttempts(seeded.runId)).find(
      (a) => a.nodeId === "work",
    )!;

    await seedAssertionFailedGate(seeded.runId, workAttempt.id, {
      assertionFailed: true,
    });

    const result = await assertEvidenceReady(seeded.runId, "review", db);

    expect(result.ready).toBe(false);
    expect(result.reasons.some((r) => r.includes("impl-mutation"))).toBe(true);
  });

  it("legacy regression: failed gate WITHOUT assertion verdict clears on inputs-present", async () => {
    const seeded = await seedGraphRun(plainWorkManifest);

    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });

    const workAttempt = (await getNodeAttempts(seeded.runId)).find(
      (a) => a.nodeId === "work",
    )!;

    await seedAssertionFailedGate(seeded.runId, workAttempt.id, undefined);

    const result = await assertEvidenceReady(seeded.runId, "review", db);

    expect(result.ready).toBe(true);
  });

  it("unblocked after a passing rework attempt re-runs the gate", async () => {
    const seeded = await seedGraphRun(plainWorkManifest);

    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });

    const workAttempt = (await getNodeAttempts(seeded.runId)).find(
      (a) => a.nodeId === "work",
    )!;

    await seedAssertionFailedGate(seeded.runId, workAttempt.id, {
      assertionFailed: true,
    });

    expect((await assertEvidenceReady(seeded.runId, "review", db)).ready).toBe(
      false,
    );

    // Rework re-run: attempt 2 re-executes the gate and passes — the failed
    // attempt-1 row drops out of the live (latest-attempt) gate set.
    const attempt2Id = randomUUID();

    await db.insert(schema.nodeAttempts).values({
      id: attempt2Id,
      runId: seeded.runId,
      nodeId: "work",
      nodeType: "cli",
      attempt: 2,
      status: "Succeeded",
    });

    const { id: gate2 } = await createGateResult({
      runId: seeded.runId,
      nodeAttemptId: attempt2Id,
      gateId: "impl-mutation",
      kind: "artifact_required",
      mode: "blocking",
      status: "running",
      inputArtifactRefs: ["impl-diff"],
      db,
    });

    await markGatePassed(
      gate2,
      { verdict: "pass", reasons: ["mutation assertions passed"] },
      db,
    );

    expect((await assertEvidenceReady(seeded.runId, "review", db)).ready).toBe(
      true,
    );
  });
});
