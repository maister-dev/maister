import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as fullSchema from "@/lib/db/schema";
import { reconcileRunCostRollups } from "@/lib/runs/cost-rollups";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

const schema = fullSchema as unknown as Record<string, any>;

type Db = NodePgDatabase<typeof fullSchema>;

let testDatabase: StartedPostgresTestDb;
let db: Db;

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "maister_cost_attribution_test",
  });
  db = testDatabase.db as unknown as Db;
}, 180_000);

afterAll(async () => {
  await testDatabase?.stop();
});

describe("per-node cost attribution chain (T-D3)", () => {
  it("attributes canonical usage events to each node attempt and run-total = sum of nodes", async () => {
    const projectId = randomUUID();
    const runId = randomUUID();
    const slug = `proj-${projectId.slice(0, 8)}`;
    const implAttempt = randomUUID();
    const reviewAttempt = randomUUID();

    await db.insert(schema.projects).values({
      id: projectId,
      taskKey: `T${projectId.slice(0, 8)}`.toUpperCase(),
      slug,
      name: `Project ${slug}`,
      repoPath: `/tmp/${slug}`,
      maisterYamlPath: `/tmp/${slug}/maister.yaml`,
    });
    await db.insert(schema.runs).values({
      id: runId,
      projectId,
      runKind: "flow",
      status: "Running",
      flowVersion: "v1",
      flowRevision: "manual",
    });
    await db.insert(schema.nodeAttempts).values([
      {
        id: implAttempt,
        runId,
        nodeId: "implement",
        nodeType: "ai_coding",
        attempt: 1,
        status: "Succeeded",
      },
      {
        id: reviewAttempt,
        runId,
        nodeId: "review",
        nodeType: "ai_coding",
        attempt: 1,
        status: "Running",
      },
    ]);

    await db.insert(schema.executionEvents).values([
      {
        id: randomUUID(),
        source: "manager",
        sourceKey: `cost-attribution:${runId}:0`,
        runId,
        eventType: "usage.recorded",
        payloadSchema: "maister.usage.recorded.v1",
        payload: {
          model: "claude-sonnet-4-6",
          nodeAttemptId: implAttempt,
          inputTokens: 1000,
          outputTokens: 200,
          cacheReadInputTokens: 50,
          cacheCreationInputTokens: 30,
        },
        occurredAt: new Date(),
        receivedAt: new Date(),
        runSequence: BigInt(0),
        ingestDisposition: "accepted",
      },
      {
        id: randomUUID(),
        source: "manager",
        sourceKey: `cost-attribution:${runId}:1`,
        runId,
        eventType: "usage.recorded",
        payloadSchema: "maister.usage.recorded.v1",
        payload: {
          model: "claude-sonnet-4-6",
          nodeAttemptId: reviewAttempt,
          inputTokens: 400,
          outputTokens: 80,
        },
        occurredAt: new Date(),
        receivedAt: new Date(),
        runSequence: BigInt(1),
        ingestDisposition: "accepted",
      },
    ]);

    await reconcileRunCostRollups(runId, { client: db });

    const nodeRollups = await db
      .select()
      .from(schema.nodeAttemptCostRollups)
      .where(eq(schema.nodeAttemptCostRollups.runId, runId));

    expect(nodeRollups).toHaveLength(2);

    const byNode = new Map(
      nodeRollups.map((r: any) => [r.nodeId as string, r]),
    );

    // Every node has non-zero tokens — the regression was the second node
    // recording zero.
    expect(byNode.get("implement")?.inputTokens).toBe(1000);
    expect(byNode.get("implement")?.outputTokens).toBe(200);
    expect(byNode.get("review")?.inputTokens).toBe(400);
    expect(byNode.get("review")?.outputTokens).toBe(80);

    const [runRollup] = await db
      .select()
      .from(schema.runCostRollups)
      .where(eq(schema.runCostRollups.runId, runId));

    // Run total = sum of per-node tokens.
    expect(runRollup.inputTokens).toBe(1400);
    expect(runRollup.outputTokens).toBe(280);
    expect(runRollup.inputTokens).toBe(
      (byNode.get("implement")?.inputTokens ?? 0) +
        (byNode.get("review")?.inputTokens ?? 0),
    );
  });
});
