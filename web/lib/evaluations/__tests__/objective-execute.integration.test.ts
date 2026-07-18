import type { ObjectiveCheckSpec } from "@/lib/evaluations/objective/providers";

import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as fullSchema from "@/lib/db/schema";
import { runObjectiveChecks } from "@/lib/evaluations/objective/execute";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

const schema = fullSchema as unknown as Record<string, any>;

let testDatabase: StartedPostgresTestDb;
let db: NodePgDatabase<typeof fullSchema>;
let executionId: string;
let participantA: string;
let participantB: string;

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "maister_eval_objective_test",
  });
  db = testDatabase.db;

  const projectId = randomUUID();

  await db.insert(schema.projects).values({
    taskKey: `T${randomUUID().slice(0, 8)}`.toUpperCase(),
    id: projectId,
    slug: `proj-${projectId.slice(0, 8)}`,
    name: "Test",
    repoPath: `/tmp/proj-${projectId.slice(0, 8)}`,
    maisterYamlPath: "/tmp/m.yaml",
  });

  const flowId = randomUUID();

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

  const taskId = randomUUID();

  await db.insert(schema.tasks).values({
    number: Number.parseInt(randomUUID().slice(0, 6), 16),
    id: taskId,
    projectId,
    title: "T",
    prompt: "p",
    flowId,
  });

  const studyId = randomUUID();

  await db.insert(schema.evaluationStudies).values({
    id: studyId,
    projectId,
    taskId,
    title: "Study",
    status: "open",
  });

  executionId = randomUUID();
  await db.insert(schema.evaluationExecutions).values({
    id: executionId,
    studyId,
    status: "checking",
  });

  participantA = randomUUID();
  participantB = randomUUID();
  for (const [id, label] of [
    [participantA, "A"],
    [participantB, "B"],
  ] as const) {
    await db.insert(schema.evaluationParticipants).values({
      id,
      studyId,
      sourceType: "observed",
      label,
    });
  }
}, 180_000);

afterAll(async () => {
  await testDatabase?.stop();
});

describe("runObjectiveChecks", () => {
  it("writes honest check-run + metric rows and reports gating", async () => {
    const checks: ObjectiveCheckSpec[] = [
      { id: "gates", provider: "gate_result@1", policy: "gate" },
      { id: "diff", provider: "diff_stats@1", policy: "metric" },
      {
        id: "host",
        provider: "trusted_host_check@1",
        policy: "gate",
        hostCheckProfile: "build",
      },
    ];

    const summary = await runObjectiveChecks(
      {
        executionId,
        checks,
        participants: [
          {
            participantId: participantA,
            facts: {
              gateResults: [{ gateId: "lint", status: "passed" }],
              diffStats: { files: 2, additions: 10, deletions: 1 },
              registeredHostProfiles: new Set(),
            },
          },
          {
            participantId: participantB,
            facts: {
              gateResults: [{ gateId: "lint", status: "failed" }],
              diffStats: null,
              registeredHostProfiles: new Set(),
            },
          },
        ],
      },
      db,
    );

    // 3 checks x 2 participants = 6 check runs; diff (metric) writes 2 metric rows.
    expect(summary.checkRuns).toBe(6);
    expect(summary.metricResults).toBe(2);
    // participant B's gate failed → gating failed.
    expect(summary.gatingFailed).toBe(true);
    // trusted_host_check is unavailable for both (unregistered) → unresolved gate.
    expect(summary.gatingUnresolved).toBe(2);

    const checkRows = await db
      .select()
      .from(schema.evaluationObjectiveCheckRuns)
      .where(eq(schema.evaluationObjectiveCheckRuns.executionId, executionId));

    expect(checkRows).toHaveLength(6);

    const hostRows = checkRows.filter(
      (r: any) => r.checkId === "trusted_host_check",
    );

    expect(hostRows.every((r: any) => r.status === "unavailable")).toBe(true);
    expect(hostRows.every((r: any) => r.reason)).toBe(true);

    // diff metric: A measured, B unavailable (never 0).
    const metricRows = await db
      .select()
      .from(schema.evaluationMetricResults)
      .where(eq(schema.evaluationMetricResults.executionId, executionId));
    const byParticipant = new Map(
      metricRows.map((r: any) => [r.participantId, r]),
    );

    expect((byParticipant.get(participantA) as any).status).toBe("measured");
    expect((byParticipant.get(participantB) as any).status).toBe("unavailable");
    expect((byParticipant.get(participantB) as any).value).toBeNull();
  });
});
