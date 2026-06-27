// T4.4 INTEGRATION TEST: review refusal when evidence is not ready
//
// End-to-end test: a human_review node with a blocking artifact_required gate
// in pre_finish that checks for a required artifact. When the artifact is
// missing/stale, the gate fails, the node cannot finish (review is refused),
// and the run does not become Done. Once the artifact is produced and current,
// the approval succeeds and the run transitions to Done.

import type { Run } from "@/lib/db/schema";

import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
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
  slug: string;
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

  await db.insert(schema.projects).values({
    taskKey: `T${crypto.randomUUID().slice(0, 8)}`.toUpperCase(),
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
  await db.insert(schema.tasks).values({
    number: Math.trunc(Math.random() * 1e9) + 1,
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
    flowVersion: "v1.0.0",
    status: "Running",
  });
  await db.insert(schema.runSessions).values({
    id: randomUUID(),
    runId,
    sessionName: "default",
    runnerId: executorId,
    capabilityAgent: "claude",
    runnerSnapshot: testRunnerSnapshot(executorId),
  });
  await db.insert(schema.workspaces).values({
    id: randomUUID(),
    runId,
    projectId,
    branch: "feature/test",
    worktreePath,
    parentRepoPath: `/tmp/${slug}`,
  });

  return { runId, slug, runtimeRoot };
}

async function getRun(runId: string): Promise<Run> {
  const rows = (await db
    .select()
    .from(schema.runs)
    .where(eq(schema.runs.id, runId))) as unknown as Run[];

  return rows[0];
}

async function writeDecision(
  seeded: Seeded,
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
            },
          },
          transitions: { approve: "done", rework: "work" },
          rework: { allowedTargets: ["work"] },
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
    const seeded = await seedGraphRun({
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
    const seeded = await seedGraphRun({
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
