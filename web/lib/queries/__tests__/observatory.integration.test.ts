import { randomUUID } from "node:crypto";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import * as schema from "@/lib/db/schema";
import {
  getNodeObservatoryDetail,
  getPortfolioObservatory,
  getProjectObservatory,
} from "@/lib/queries/observatory";

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase<typeof schema>;
let memberUserId: string;
let visibleProjectId: string;
let hiddenProjectId: string;
let visibleFlowId: string;
let hiddenFlowId: string;

const NOW = new Date("2026-06-05T12:00:00.000Z");

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("observatory_test")
    .withUsername("test")
    .withPassword("test")
    .start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool, { schema });

  await migrate(db, { migrationsFolder: "./lib/db/migrations" });
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

beforeEach(async () => {
  await db.delete(schema.artifactInstances);
  await db.delete(schema.gateResults);
  await db.delete(schema.hitlRequests);
  await db.delete(schema.nodeAttempts);
  await db.delete(schema.runs);
  await db.delete(schema.tasks);
  await db.delete(schema.projectMembers);
  await db.delete(schema.flows);
  await db.delete(schema.projects);
  await db.delete(schema.users);

  memberUserId = randomUUID();
  visibleProjectId = randomUUID();
  hiddenProjectId = randomUUID();
  visibleFlowId = randomUUID();
  hiddenFlowId = randomUUID();

  await db.insert(schema.users).values({
    id: memberUserId,
    email: `observatory-${memberUserId}@maister.local`,
    role: "member",
    accountStatus: "active",
  });

  await db.insert(schema.projects).values([
    {
      id: visibleProjectId,
      slug: "observatory-visible",
      name: "Visible",
      repoPath: `/repos/observatory-visible-${visibleProjectId}`,
      maisterYamlPath: "/repos/visible/maister.yaml",
    },
    {
      id: hiddenProjectId,
      slug: "observatory-hidden",
      name: "Hidden",
      repoPath: `/repos/observatory-hidden-${hiddenProjectId}`,
      maisterYamlPath: "/repos/hidden/maister.yaml",
    },
  ]);

  await db.insert(schema.projectMembers).values({
    projectId: visibleProjectId,
    userId: memberUserId,
    role: "member",
  });

  await db.insert(schema.flows).values([
    {
      id: visibleFlowId,
      projectId: visibleProjectId,
      flowRefId: "aif",
      source: "github.com/acme/aif",
      version: "v1.0.0",
      installedPath: "/tmp/flows/aif",
      manifest: { schemaVersion: 1, name: "aif", steps: [] },
      schemaVersion: 1,
      enablementState: "Enabled",
      trustStatus: "trusted",
    },
    {
      id: hiddenFlowId,
      projectId: hiddenProjectId,
      flowRefId: "aif-hidden",
      source: "github.com/acme/aif-hidden",
      version: "v1.0.0",
      installedPath: "/tmp/flows/aif-hidden",
      manifest: { schemaVersion: 1, name: "aif-hidden", steps: [] },
      schemaVersion: 1,
      enablementState: "Enabled",
      trustStatus: "trusted",
    },
  ]);
});

describe("observatory read models", () => {
  it("aggregates portfolio metrics for visible projects without leaking hidden rows", async () => {
    const { runId, implementAttemptId } = await seedRun({
      projectId: visibleProjectId,
      flowId: visibleFlowId,
      suffix: "visible",
    });

    await seedRun({
      projectId: hiddenProjectId,
      flowId: hiddenFlowId,
      suffix: "hidden",
      reworked: true,
    });

    await db.insert(schema.nodeAttempts).values([
      attempt(runId, "implement", "ai_coding", 1, "Succeeded", "visible-impl-1"),
      attempt(runId, "implement", "ai_coding", 2, "Succeeded", "visible-impl-2"),
      attempt(runId, "review", "human", 1, "Reworked", "visible-review-1"),
    ]);
    await db.insert(schema.hitlRequests).values({
      id: "visible-hitl-1",
      runId,
      stepId: "review",
      kind: "human",
      prompt: "Review",
      decision: "rework",
      reworkTarget: "implement",
      workspacePolicy: "keep",
      createdAt: new Date("2026-06-05T11:30:00.000Z"),
      respondedAt: null,
    });
    await db.insert(schema.artifactInstances).values({
      id: "visible-artifact-1",
      runId,
      nodeAttemptId: implementAttemptId,
      nodeId: "implement",
      attempt: 1,
      artifactDefId: null,
      kind: "log",
      producer: "runner",
      locator: { kind: "inline", text: "redacted" },
      validity: "current",
    });

    const result = await getPortfolioObservatory(
      memberUserId,
      "member",
      { now: NOW },
      db,
    );

    expect(result.projects.map((project) => project.projectId)).toEqual([
      visibleProjectId,
    ]);
    expect(result.totals.correction.runCount).toBe(1);
    expect(result.totals.correction.retryCount).toBe(1);
    expect(result.totals.correction.reworkCount).toBe(1);
    expect(result.totals.correction.correctionRate).toBe(2);
    expect(result.totals.autonomy.openWaitCount).toBe(1);
    expect(result.artifacts.map((artifact) => artifact.artifactKey)).toEqual([
      "kind:log",
    ]);
  });

  it("returns project and node detail aggregates with bounded query count", async () => {
    const { runId } = await seedRun({
      projectId: visibleProjectId,
      flowId: visibleFlowId,
      suffix: "node-detail",
    });

    await db.insert(schema.nodeAttempts).values([
      attempt(runId, "checks", "check", 1, "Failed", "checks-1", {
        errorCode: "TEST_FAIL",
        exitCode: 1,
      }),
      attempt(runId, "checks", "check", 2, "Succeeded", "checks-2"),
    ]);
    await db.insert(schema.gateResults).values({
      id: "gate-checks-1",
      runId,
      nodeAttemptId: "checks-1",
      gateId: "unit",
      kind: "command_check",
      mode: "blocking",
      status: "failed",
      verdict: {
        verdict: "fail",
        reasons: ["unit failed"],
        recommendedAction: "rerun",
      },
    });

    const counted = withQueryCount(db);
    const project = await getProjectObservatory(
      visibleProjectId,
      { now: NOW },
      counted.db,
    );
    const detail = await getNodeObservatoryDetail(
      visibleProjectId,
      "checks",
      { now: NOW },
      counted.db,
    );

    expect(project.totals.correction.runCount).toBe(1);
    expect(project.nodes.find((node) => node.nodeId === "checks")?.retryCount).toBe(1);
    expect(detail.nodeId).toBe("checks");
    expect(detail.runs.map((run) => run.runId)).toEqual([runId]);
    expect(detail.attempts.map((row) => row.attempt)).toEqual([1, 2]);
    expect(counted.count()).toBeLessThanOrEqual(14);
  });
});

async function seedRun(input: {
  projectId: string;
  flowId: string;
  suffix: string;
  reworked?: boolean;
}): Promise<{ runId: string; implementAttemptId: string }> {
  const taskId = `${input.suffix}-task`;
  const runId = `${input.suffix}-run`;
  const implementAttemptId = `${input.suffix}-impl-1`;

  await db.insert(schema.tasks).values({
    id: taskId,
    projectId: input.projectId,
    title: input.suffix,
    prompt: input.suffix,
    flowId: input.flowId,
    status: "InFlight",
  });
  await db.insert(schema.runs).values({
    id: runId,
    taskId,
    projectId: input.projectId,
    flowId: input.flowId,
    status: input.reworked ? "Review" : "Running",
    flowVersion: "v1.0.0",
    startedAt: new Date("2026-06-05T11:00:00.000Z"),
    endedAt: input.reworked ? new Date("2026-06-05T11:45:00.000Z") : null,
  });

  return { runId, implementAttemptId };
}

function attempt(
  runId: string,
  nodeId: string,
  nodeType: "ai_coding" | "check" | "human",
  attemptNumber: number,
  status: "Succeeded" | "Failed" | "Reworked",
  id: string,
  opts: { errorCode?: string; exitCode?: number } = {},
): typeof schema.nodeAttempts.$inferInsert {
  return {
    id,
    runId,
    nodeId,
    nodeType,
    attempt: attemptNumber,
    status,
    errorCode: opts.errorCode,
    exitCode: opts.exitCode,
  };
}

function withQueryCount(
  database: NodePgDatabase<typeof schema>,
): { db: NodePgDatabase<typeof schema>; count: () => number } {
  let statements = 0;

  return {
    db: new Proxy(database, {
      get(target, prop, receiver) {
        if (prop === "select") {
          const select = Reflect.get(target, prop, receiver) as unknown as (
            ...args: unknown[]
          ) => unknown;

          return (...args: unknown[]) => {
            statements += 1;
            return select.apply(target, args);
          };
        }

        return Reflect.get(target, prop, receiver);
      },
    }) as NodePgDatabase<typeof schema>,
    count: () => statements,
  };
}
