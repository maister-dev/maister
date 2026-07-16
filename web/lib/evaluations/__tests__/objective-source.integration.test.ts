import { randomUUID } from "node:crypto";

import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as fullSchema from "@/lib/db/schema";
import { evaluateObjectiveCheck } from "@/lib/evaluations/objective/providers";
import { loadObjectiveFactSource } from "@/lib/evaluations/objective/source";
import { testPlatformRunnerRow } from "@/lib/__tests__/runner-fixtures";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

const schema = fullSchema as unknown as Record<string, any>;

let testDatabase: StartedPostgresTestDb;
let db: NodePgDatabase;
let runId: string;
let bareRunId: string;

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "maister_eval_objsource_test",
  });
  db = testDatabase.db;

  const projectId = randomUUID();
  const taskId = randomUUID();
  const flowId = randomUUID();
  const executorId = randomUUID();

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
    title: "T",
    prompt: "p",
    flowId,
  });

  runId = randomUUID();
  bareRunId = randomUUID();
  for (const id of [runId, bareRunId]) {
    await db.insert(schema.runs).values({
      id,
      taskId,
      projectId,
      flowId,
      runnerId: executorId,
      capabilityAgent: "claude",
      flowVersion: "v1.0.0",
      runKind: "flow",
    });
  }

  const nodeAttemptId = randomUUID();

  await db.insert(schema.nodeAttempts).values({
    id: nodeAttemptId,
    runId,
    nodeId: "checks",
    nodeType: "check",
    attempt: 1,
    status: "Succeeded",
  });
  // A passed and a failed gate + a still-pending gate (never a verdict).
  for (const [gateId, status] of [
    ["lint", "passed"],
    ["test", "failed"],
    ["review", "pending"],
  ] as const) {
    await db.insert(schema.gateResults).values({
      id: randomUUID(),
      runId,
      nodeAttemptId,
      gateId,
      kind: "command_check",
      status,
    });
  }
  // A produced diff artifact (current) — used for completeness.
  await db.insert(schema.artifactInstances).values({
    id: randomUUID(),
    runId,
    kind: "diff",
    producer: "runner",
    artifactDefId: "diff",
    locator: { kind: "file", path: "d.patch" },
    validity: "current",
  });
}, 180_000);

afterAll(async () => {
  await testDatabase?.stop();
});

describe("loadObjectiveFactSource (live readers)", () => {
  it("maps real gate verdicts and drives the gate_result provider honestly", async () => {
    const source = await loadObjectiveFactSource({ runId }, db);

    expect(source.gateResults).toEqual([
      { gateId: "lint", status: "passed" },
      { gateId: "test", status: "failed" },
    ]);

    // The failed gate makes the gate_result check FAIL (a recorded fact).
    const outcome = evaluateObjectiveCheck(
      { id: "g", provider: "gate_result@1", policy: "gate" },
      source,
    );

    expect(outcome.status).toBe("failed");
    expect(outcome.reason).toContain("test");
  });

  it("computes artifact completeness against the required set", async () => {
    const source = await loadObjectiveFactSource(
      { runId, requiredArtifactDefIds: ["diff", "test_report"] },
      db,
    );

    expect(source.artifactCompleteness).toEqual({
      requiredPresent: false,
      missing: ["test_report"],
    });

    const outcome = evaluateObjectiveCheck(
      { id: "a", provider: "artifact_completeness@1", policy: "gate" },
      source,
    );

    expect(outcome.status).toBe("failed");
    expect(outcome.reason).toContain("test_report");
  });

  it("returns honest absence for an observed Run with no recorded facts", async () => {
    const source = await loadObjectiveFactSource({ runId: bareRunId }, db);

    // Queried, but the run declared no gates → provider says not_run, never PASS.
    expect(source.gateResults).toEqual([]);

    const outcome = evaluateObjectiveCheck(
      { id: "g", provider: "gate_result@1", policy: "gate" },
      source,
    );

    expect(outcome.status).toBe("not_run");
  });

  it("marks trusted_host_check unavailable unless the profile is registered", async () => {
    const source = await loadObjectiveFactSource(
      { runId, registeredHostProfiles: new Set(["ci-fast"]) },
      db,
    );

    const registered = evaluateObjectiveCheck(
      {
        id: "h",
        provider: "trusted_host_check@1",
        policy: "gate",
        hostCheckProfile: "ci-fast",
      },
      source,
    );
    const missing = evaluateObjectiveCheck(
      {
        id: "h",
        provider: "trusted_host_check@1",
        policy: "gate",
        hostCheckProfile: "ci-unknown",
      },
      source,
    );

    // Registered → not_run pending capture (never PASS from appearance);
    // unregistered → unavailable.
    expect(registered.status).toBe("not_run");
    expect(missing.status).toBe("unavailable");
  });
});
