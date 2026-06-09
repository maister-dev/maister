import type { GateResult, Run } from "@/lib/db/schema";

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

async function seedGraphRun(
  manifest: unknown,
): Promise<{ runId: string; runtimeRoot: string }> {
  const projectId = randomUUID();
  const slug = `proj-${projectId.slice(0, 8)}`;
  const executorId = randomUUID();
  const flowId = randomUUID();
  const taskId = randomUUID();
  const runId = randomUUID();
  const worktreePath = await mkdtemp(join(tmpdir(), "wt-"));
  const runtimeRoot = await mkdtemp(join(tmpdir(), "rt-"));

  await db.insert(schema.projects).values({
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
  await db
    .insert(schema.tasks)
    .values({ id: taskId, projectId, title: "t", prompt: "p", flowId });
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

async function getRun(runId: string): Promise<Run> {
  const rows = (await db
    .select()
    .from(schema.runs)
    .where(eq(schema.runs.id, runId))) as unknown as Run[];

  return rows[0];
}

async function getGates(runId: string): Promise<GateResult[]> {
  return (await db
    .select()
    .from(schema.gateResults)
    .where(eq(schema.gateResults.runId, runId))) as unknown as GateResult[];
}

function oneNode(gates: unknown[]) {
  return {
    schemaVersion: 1,
    name: "g",
    compat: { engine_min: "1.1.0" },
    nodes: [
      {
        id: "work",
        type: "cli",
        action: { command: "echo work" },
        pre_finish: { gates },
        transitions: { success: "done" },
      },
    ],
  };
}

describe("gate execution", () => {
  it("blocking command_check passes (exit 0) → node finishes, gate passed, run Review", async () => {
    const seeded = await seedGraphRun(
      oneNode([
        { id: "fmt", kind: "command_check", mode: "blocking", command: "true" },
      ]),
    );

    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });

    expect((await getRun(seeded.runId)).status).toBe("Review");
    const gates = await getGates(seeded.runId);

    expect(gates).toHaveLength(1);
    expect(gates[0].gateId).toBe("fmt");
    expect(gates[0].status).toBe("passed");
    expect((gates[0].verdict as { verdict: string }).verdict).toBe("pass");
  });

  it("blocking command_check fails (exit 1) → node Failed, run Failed", async () => {
    const seeded = await seedGraphRun(
      oneNode([
        {
          id: "test",
          kind: "command_check",
          mode: "blocking",
          command: "false",
        },
      ]),
    );

    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });

    expect((await getRun(seeded.runId)).status).toBe("Failed");
    const gates = await getGates(seeded.runId);

    expect(gates[0].status).toBe("failed");
  });

  it("advisory command_check fails but the node still finishes (run Review)", async () => {
    const seeded = await seedGraphRun(
      oneNode([
        {
          id: "lint",
          kind: "command_check",
          mode: "advisory",
          command: "false",
        },
      ]),
    );

    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });

    expect((await getRun(seeded.runId)).status).toBe("Review");
    const gates = await getGates(seeded.runId);

    expect(gates[0].status).toBe("failed"); // recorded, did not block
  });

  it("artifact_required (no inputArtifacts) passes vacuously; external_check stays pending; node finishes", async () => {
    const seeded = await seedGraphRun(
      oneNode([
        { id: "art", kind: "artifact_required", mode: "blocking" },
        { id: "ext", kind: "external_check", mode: "blocking" },
      ]),
    );

    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });

    // The node finishes (artifact_required passes vacuously, external_check
    // stays pending — not a terminal failure at gate-exec time). However,
    // after Task 4 the readiness chokepoint fires for ALL flows regardless of
    // engine_min. The pending blocking external_check gate causes
    // assertEvidenceReady to return ready=false → run ends Failed.
    // (Pre-Task-4 the guard `artifactEnforcementActive &&` skipped the
    // chokepoint for engine_min "1.1.0" < "1.2.0", so the run reached Review.)
    expect((await getRun(seeded.runId)).status).toBe("Failed");
    const gates = await getGates(seeded.runId);

    // artifact_required with no inputArtifacts: vacuously all present → passed (T4.2)
    expect(gates.find((g) => g.gateId === "art")?.status).toBe("passed");
    expect(gates.find((g) => g.gateId === "ext")?.status).toBe("pending");
  });

  it("persists gate-declared inputArtifacts to gate_results.input_artifact_refs", async () => {
    const seeded = await seedGraphRun(
      oneNode([
        {
          id: "fmt",
          kind: "command_check",
          mode: "blocking",
          command: "true",
          inputArtifacts: ["impl-diff", "test-report"],
        },
      ]),
    );

    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });

    const gates = await getGates(seeded.runId);

    expect(gates[0].inputArtifactRefs).toEqual(["impl-diff", "test-report"]);
  });

  it("two blocking gates: a failing one fails the run, both verdicts recorded", async () => {
    const seeded = await seedGraphRun(
      oneNode([
        { id: "a", kind: "command_check", mode: "blocking", command: "true" },
        { id: "b", kind: "command_check", mode: "blocking", command: "false" },
      ]),
    );

    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });

    expect((await getRun(seeded.runId)).status).toBe("Failed");
    const gates = await getGates(seeded.runId);

    expect(gates.find((g) => g.gateId === "a")?.status).toBe("passed");
    expect(gates.find((g) => g.gateId === "b")?.status).toBe("failed");
  });
});

// T4.2: artifact_required gate execution
describe("T4.2: artifact_required gate (M12 typed artifacts)", () => {
  it("artifact_required with all inputArtifacts present → gate passed", async () => {
    const seeded = await seedGraphRun(
      oneNode([
        {
          id: "verify-artifacts",
          kind: "artifact_required",
          mode: "blocking",
          inputArtifacts: ["impl-diff", "test-report"],
        },
      ]),
    );

    // Seed CURRENT artifacts before runFlow so the gate can see them.
    // nodeAttemptId is null (run-level artifact, no FK constraint issue).
    await recordArtifact(
      {
        runId: seeded.runId,
        nodeId: "work",
        kind: "diff",
        producer: "runner",
        artifactDefId: "impl-diff",
        locator: { kind: "inline", text: "impl changes" },
        validity: "current",
      },
      db,
    );
    await recordArtifact(
      {
        runId: seeded.runId,
        nodeId: "work",
        kind: "test_report",
        producer: "runner",
        artifactDefId: "test-report",
        locator: { kind: "inline", text: "all tests pass" },
        validity: "current",
      },
      db,
    );

    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });

    const gates = await getGates(seeded.runId);
    const verifyGate = gates.find((g) => g.gateId === "verify-artifacts");

    expect(verifyGate?.inputArtifactRefs).toEqual(["impl-diff", "test-report"]);
    // RED: gate must check artifacts and pass when all present
    expect(verifyGate?.status).toBe("passed");
  });

  it("artifact_required with missing inputArtifact → gate failed", async () => {
    const seeded = await seedGraphRun(
      oneNode([
        {
          id: "verify-artifacts",
          kind: "artifact_required",
          mode: "blocking",
          inputArtifacts: ["missing-artifact"],
        },
      ]),
    );

    // Do NOT seed any artifact; the gate must detect missing and fail
    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });

    const gates = await getGates(seeded.runId);
    const verifyGate = gates.find((g) => g.gateId === "verify-artifacts");

    // RED: gate must check artifacts and fail when missing
    expect(verifyGate?.status).toBe("failed");
  });

  it("artifact_required with stale inputArtifact → gate failed", async () => {
    const seeded = await seedGraphRun(
      oneNode([
        {
          id: "verify-artifacts",
          kind: "artifact_required",
          mode: "blocking",
          inputArtifacts: ["stale-artifact"],
        },
      ]),
    );

    // Seed a STALE artifact before runFlow; gate must detect non-current and fail.
    await recordArtifact(
      {
        runId: seeded.runId,
        nodeId: "work",
        kind: "lint_report",
        producer: "runner",
        artifactDefId: "stale-artifact",
        locator: { kind: "inline", text: "old data" },
        validity: "stale",
      },
      db,
    );

    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });

    const gates = await getGates(seeded.runId);
    const verifyGate = gates.find((g) => g.gateId === "verify-artifacts");

    // RED: gate must check validity and fail when stale
    expect(verifyGate?.status).toBe("failed");
  });

  it("artifact_required advisory mode with missing artifact → recorded failed but non-blocking", async () => {
    const seeded = await seedGraphRun(
      oneNode([
        {
          id: "optional-verify",
          kind: "artifact_required",
          mode: "advisory",
          inputArtifacts: ["missing"],
        },
      ]),
    );

    // Do NOT seed the artifact; gate must detect missing
    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });

    // RED: advisory gate fails (missing artifact) but does NOT block → node finishes → run Review
    expect((await getRun(seeded.runId)).status).toBe("Review");
    const gates = await getGates(seeded.runId);
    const optionalGate = gates.find((g) => g.gateId === "optional-verify");

    // RED: gate must check artifacts and record failed, but mode=advisory means non-blocking
    expect(optionalGate?.status).toBe("failed");
    expect(optionalGate?.mode).toBe("advisory");
  });

  it("artifact_required gate with output declaration → sets outputArtifactRef", async () => {
    const seeded = await seedGraphRun(
      oneNode([
        {
          id: "verify-and-output",
          kind: "artifact_required",
          mode: "blocking",
          inputArtifacts: ["input-def"],
          output: { id: "validated-output", kind: "lint_report" },
        },
      ]),
    );

    // Seed the required input artifact before runFlow so the gate can see it.
    await recordArtifact(
      {
        runId: seeded.runId,
        nodeId: "work",
        kind: "lint_report",
        producer: "runner",
        artifactDefId: "input-def",
        locator: { kind: "inline", text: "input data" },
        validity: "current",
      },
      db,
    );

    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });

    const gates = await getGates(seeded.runId);
    const verifyGate = gates.find((g) => g.gateId === "verify-and-output");

    // RED: gate must set outputArtifactRef when declared
    expect(verifyGate?.outputArtifactRef).toBe("validated-output");
  });
});
