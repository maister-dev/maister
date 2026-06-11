// RED (M16 Phase 4 §F): getRunReadiness must surface the manifest gate's
// external.description in ReadinessDTO.externalGates[].
//
// Spec: docs/api/external/operations.openapi.yaml lines 584-595
//   externalGates[].description — "Gate description from flow.yaml
//   gates[].external.description."
//   docs/flow-dsl.md §gates[].external block — description is surfaced in the
//   readiness response so CI consumers know what each gate expects.
//
// getRunReadiness EXISTS and ReadinessDTO already declares `description?`, but
// the implementation (lib/queries/readiness.ts ~103-115) only sets gateId,
// status, externalRunUrl, commitSha — it NEVER sources `description` from the
// flow manifest. So `description` is always undefined today. This test seeds a
// flow whose manifest declares the external_check gate WITH an external.description
// and asserts the DTO carries it. RED until the projection joins gate→manifest.

import { randomUUID } from "node:crypto";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as fullSchema from "@/lib/db/schema";
import {
  testPlatformRunnerRow,
  testRunnerSnapshot,
} from "@/lib/__tests__/runner-fixtures";
import { getRunReadiness } from "@/lib/queries/readiness";

const schema = fullSchema as unknown as Record<string, any>;

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("readiness_external_test")
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

const GATE_DESCRIPTION = "GitHub Actions full test suite on the run branch.";

// A graph manifest whose review node declares an external_check gate carrying
// an external.description — the value the readiness projection must surface.
const MANIFEST = {
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
      pre_finish: {
        gates: [
          {
            id: "ci",
            kind: "external_check",
            mode: "blocking",
            external: { description: GATE_DESCRIPTION, staleOnNewCommit: true },
          },
        ],
      },
      finish: { human: { role: "maintainer", decisions: ["approve"] } },
      transitions: { approve: "done" },
    },
  ],
};

async function seedRunWithExternalGate(): Promise<{
  runId: string;
  projectId: string;
}> {
  const projectId = randomUUID();
  const slug = `proj-${projectId.slice(0, 8)}`;
  const executorId = randomUUID();
  const flowId = randomUUID();
  const taskId = randomUUID();
  const runId = randomUUID();
  const nodeAttemptId = randomUUID();

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
    manifest: MANIFEST,
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
    runnerSnapshot: testRunnerSnapshot(executorId, "claude"),
    flowVersion: "v1.0.0",
    status: "Review",
  });
  await db.insert(schema.workspaces).values({
    id: randomUUID(),
    runId,
    projectId,
    branch: "feature/test",
    worktreePath: `/tmp/wt-${runId}`,
    parentRepoPath: `/tmp/${slug}`,
  });
  await db.insert(schema.nodeAttempts as any).values({
    id: nodeAttemptId,
    runId,
    nodeId: "review",
    nodeType: "check",
    attempt: 1,
    status: "Succeeded",
    startedAt: new Date("2026-06-02T10:00:00.000Z"),
  });
  await db.insert(schema.gateResults as any).values({
    id: randomUUID(),
    runId,
    nodeAttemptId,
    gateId: "ci",
    kind: "external_check",
    mode: "blocking",
    status: "pending",
  });

  return { runId, projectId };
}

describe("getRunReadiness — external gate description projection (M16 §F)", () => {
  it("surfaces the manifest gate's external.description in externalGates[]", async () => {
    const { runId, projectId } = await seedRunWithExternalGate();

    const dto = await getRunReadiness(runId, projectId, db);

    expect(dto).not.toBeNull();

    const gate = dto!.externalGates.find((g) => g.gateId === "ci");

    expect(gate).toBeDefined();
    expect(gate!.status).toBe("pending");
    // RED today: implementation never sources description → undefined.
    expect(gate!.description).toBe(GATE_DESCRIPTION);
  });

  it("carries externalRunUrl + commitSha from the gate verdict alongside description", async () => {
    const { runId, projectId } = await seedRunWithExternalGate();

    // Drive the gate to a passed verdict carrying url + commit (as the report
    // endpoint would write it).
    await db
      .update(schema.gateResults as any)
      .set({
        status: "passed",
        verdict: {
          externalRunUrl: "https://ci.example/run/7",
          commitSha: "abc123",
          reporterTokenId: "tok",
          reportedAt: "2026-06-02T10:00:00.000Z",
        },
      })
      .where((await import("drizzle-orm")).eq(schema.gateResults.runId, runId));

    const dto = await getRunReadiness(runId, projectId, db);
    const gate = dto!.externalGates.find((g) => g.gateId === "ci");

    expect(gate).toBeDefined();
    expect(gate!.externalRunUrl).toBe("https://ci.example/run/7");
    expect(gate!.commitSha).toBe("abc123");
    // description still comes from the manifest, not the verdict.
    expect(gate!.description).toBe(GATE_DESCRIPTION);
  });
});
