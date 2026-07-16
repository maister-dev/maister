import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as fullSchema from "@/lib/db/schema";
import { computeAggregate } from "@/lib/evaluations/aggregation/algorithms";
import { classifyDisagreement } from "@/lib/evaluations/aggregation/disagreement";
import { persistAggregate } from "@/lib/evaluations/aggregation/persist";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

const schema = fullSchema as unknown as Record<string, any>;

let testDatabase: StartedPostgresTestDb;
let db: NodePgDatabase;
let executionId: string;

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "maister_eval_agg_test",
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
    status: "aggregating",
  });
}, 180_000);

afterAll(async () => {
  await testDatabase?.stop();
});

describe("persistAggregate (append-only)", () => {
  it("writes a digest-anchored aggregate and increments revision on re-persist", async () => {
    const criteria = [
      {
        id: "correctness",
        weight: 1,
        normalizedWeight: 1,
        scaleMin: 0,
        scaleMax: 5,
        optional: false,
      },
    ];
    const attempts = [
      {
        attemptId: "a",
        valid: true,
        criteria: { correctness: { state: "scored" as const, score: 4 } },
      },
      {
        attemptId: "b",
        valid: true,
        criteria: { correctness: { state: "scored" as const, score: 5 } },
      },
    ];

    const result = computeAggregate({
      algorithm: "weighted_mean@1",
      quorum: 2,
      criteria,
      attempts,
    });
    const disagreement = classifyDisagreement({
      perCriterion: result.perCriterion,
      attemptConfidences: [],
      validAttemptCount: 2,
      expectedAttemptCount: 2,
      objectiveGatingFailed: false,
      topCriterionValue: result.perCriterion[0].displayValue,
      criterionScaleMax: 5,
    });

    const first = await persistAggregate(
      {
        executionId,
        result,
        disagreement,
        methodDigests: { definitionDigest: "dd", schemaDigest: "sd" },
      },
      db,
    );

    expect(first.revision).toBe(1);
    expect(first.digest).toHaveLength(64);

    const second = await persistAggregate(
      {
        executionId,
        result,
        disagreement,
        methodDigests: { definitionDigest: "dd", schemaDigest: "sd" },
      },
      db,
    );

    expect(second.revision).toBe(2);

    const rows = await db
      .select()
      .from(schema.evaluationAggregateResults)
      .where(eq(schema.evaluationAggregateResults.executionId, executionId));

    expect(rows).toHaveLength(2);
    expect(rows[0].algorithmId).toBe("weighted_mean");
    expect(rows[0].algorithmVersion).toBe("1");
  });
});
