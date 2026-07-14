import type { PlanReviewV1 } from "@/lib/flows/plan-review-contract";

import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schemaModule from "@/lib/db/schema";
import { createPlanReviewDecisionRequests } from "@/lib/flows/graph/plan-review-decisions";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

const schema = schemaModule as unknown as Record<string, any>;

let testDatabase: StartedPostgresTestDb;
let db: NodePgDatabase;

const decisions: PlanReviewV1["decisions"] = [
  {
    id: "database",
    question: "Which database should store the plan-review answer?",
    options: [
      {
        id: "postgres",
        label: "Postgres",
        consequences: "Keeps the answer transactional.",
      },
      {
        id: "files",
        label: "Files",
        consequences: "Needs a separate consistency protocol.",
      },
    ],
    recommendation: "postgres",
    blocking: true,
  },
  {
    id: "resume",
    question: "How should the completed review resume?",
    options: [
      {
        id: "graph",
        label: "Graph continuation",
        consequences: "Preserves the run scheduler contract.",
      },
      {
        id: "direct",
        label: "Direct wake",
        consequences: "Bypasses the scheduler contract.",
      },
    ],
    recommendation: "graph",
    blocking: true,
  },
];

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "plan_review_decision_creation_test",
  });
  db = testDatabase.db;
}, 180_000);

afterAll(async () => {
  await testDatabase?.stop();
});

async function seedRun(): Promise<{
  projectId: string;
  runId: string;
  sourceArtifactId: string;
}> {
  const projectId = randomUUID();
  const runId = randomUUID();
  const sourceArtifactId = randomUUID();

  await (db as any).insert(schema.projects).values({
    id: projectId,
    slug: `plan-review-${projectId.slice(0, 8)}`,
    name: "Plan review decision creation",
    repoPath: `/tmp/plan-review-${projectId}`,
    maisterYamlPath: `/tmp/plan-review-${projectId}/maister.yaml`,
    taskKey: `PR${projectId.slice(0, 8)}`.toUpperCase(),
  });
  await (db as any).insert(schema.runs).values({
    id: runId,
    projectId,
    runKind: "flow",
    flowVersion: "test",
    status: "NeedsInput",
  });
  await (db as any).insert(schema.artifactInstances).values({
    id: sourceArtifactId,
    runId,
    artifactDefId: "implementation-plan",
    nodeId: "review_plan",
    attempt: 1,
    kind: "plan",
    producer: "runner",
    locator: { kind: "file", path: "artifacts/plan-review.json" },
    validity: "current",
  });

  return { projectId, runId, sourceArtifactId };
}

async function insertParent(args: {
  db: any;
  parentHitlRequestId: string;
  runId: string;
}): Promise<void> {
  await args.db.insert(schema.hitlRequests).values({
    id: args.parentHitlRequestId,
    runId: args.runId,
    stepId: "review_plan",
    kind: "human",
    schema: { review: true },
    prompt: "Review the implementation plan",
  });
}

describe("createPlanReviewDecisionRequests integration", () => {
  it("creates parent and children atomically, then reuses the same child cards on re-entry", async () => {
    const { projectId, runId, sourceArtifactId } = await seedRun();
    const rolledBackParentId = randomUUID();

    await expect(
      (db as any).transaction(async (tx: any) => {
        await insertParent({
          db: tx,
          parentHitlRequestId: rolledBackParentId,
          runId,
        });
        await createPlanReviewDecisionRequests({
          db: tx,
          projectId,
          runId,
          nodeId: "review_plan",
          parentHitlRequestId: rolledBackParentId,
          sourceArtifactId,
          decisions,
          roleRefs: [],
        });
        throw new Error("force plan-review creation rollback");
      }),
    ).rejects.toThrow("force plan-review creation rollback");

    const rolledBackRequests = await (db as any)
      .select()
      .from(schema.hitlRequests)
      .where(eq(schema.hitlRequests.runId, runId));

    expect(rolledBackRequests).toHaveLength(0);

    const parentHitlRequestId = randomUUID();
    const created = await (db as any).transaction(async (tx: any) => {
      await insertParent({ db: tx, parentHitlRequestId, runId });

      return createPlanReviewDecisionRequests({
        db: tx,
        projectId,
        runId,
        nodeId: "review_plan",
        parentHitlRequestId,
        sourceArtifactId,
        decisions,
        roleRefs: [],
      });
    });
    const replayed = await (db as any).transaction((tx: any) =>
      createPlanReviewDecisionRequests({
        db: tx,
        projectId,
        runId,
        nodeId: "review_plan",
        parentHitlRequestId,
        sourceArtifactId,
        decisions,
        roleRefs: [],
      }),
    );
    const children = await (db as any)
      .select()
      .from(schema.hitlRequests)
      .where(
        and(
          eq(schema.hitlRequests.runId, runId),
          eq(schema.hitlRequests.kind, "decision_request"),
        ),
      );
    const assignments = await (db as any)
      .select()
      .from(schema.assignments)
      .where(eq(schema.assignments.runId, runId));

    expect(created).toHaveLength(2);
    expect(replayed).toEqual(created);
    expect(children).toHaveLength(2);
    expect(
      children.every(
        (child: { parentHitlRequestId: string; sourceArtifactId: string }) =>
          child.parentHitlRequestId === parentHitlRequestId &&
          child.sourceArtifactId === sourceArtifactId,
      ),
    ).toBe(true);
    expect(assignments).toHaveLength(2);
    expect(
      assignments.every(
        (assignment: { hitlRequestId: string; actionKind: string }) =>
          created.some(
            (request: { id: string }) =>
              request.id === assignment.hitlRequestId,
          ) && assignment.actionKind === "decision_request",
      ),
    ).toBe(true);
  });
});
