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
import { getProjectAgentization } from "@/lib/queries/observatory-agentization";
import { getProjectObservatory } from "@/lib/queries/observatory";

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase<typeof schema>;
let projectId: string;

const NOW = new Date("2026-07-12T12:00:00.000Z");

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("observatory_kind_attribution")
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
  await db.delete(schema.domainEvents);
  await db.delete(schema.runCostRollups);
  await db.delete(schema.runs);
  await db.delete(schema.projects);

  projectId = randomUUID();
  await db.insert(schema.projects).values({
    id: projectId,
    taskKey: `K${randomUUID().slice(0, 8)}`.toUpperCase(),
    slug: `kind-${projectId.slice(0, 8)}`,
    name: "Kind attribution",
    repoPath: `/repos/${projectId}`,
    maisterYamlPath: `/repos/${projectId}/maister.yaml`,
  });
});

describe("project Observatory kind attribution", () => {
  it("reconciles all-kind cost/budget totals and excludes legacy budget in a concrete kind", async () => {
    const flowRunId = await seedRun("flow", 10);
    const scratchRunId = await seedRun("scratch", 5);

    await seedBudgetEvent(flowRunId, "run.escalated", "budget_exceeded");
    await seedBudgetEvent(scratchRunId, "run.failed", "budget_breach");
    await seedBudgetEvent(null, "run.escalated", "hook_trip");

    const all = await getProjectObservatory(projectId, { now: NOW }, db);
    const scratch = await getProjectObservatory(
      projectId,
      { now: NOW, runKind: "scratch" },
      db,
    );

    expect(all.cost.inputTokens).toBe(15);
    expect(all.cost.byKind.map((row) => [row.kind, row.totalTokens])).toEqual([
      ["flow", 10],
      ["scratch", 5],
      ["agent", 0],
    ]);
    expect(all.budget).toMatchObject({
      budgetEscalations: 1,
      budgetTerminations: 1,
      hookTripEscalations: 1,
    });
    expect(all.budget.byKind).toContainEqual(
      expect.objectContaining({
        kind: "unattributed_legacy",
        hookTripEscalations: 1,
      }),
    );
    expect(scratch.cost).toMatchObject({ inputTokens: 5 });
    expect(scratch.cost.byKind).toEqual([
      expect.objectContaining({ kind: "scratch", totalTokens: 5 }),
    ]);
    expect(scratch.budget.byKind).toEqual([
      expect.objectContaining({
        kind: "scratch",
        budgetTerminations: 1,
      }),
    ]);
  });

  it("keeps the agentization read query count fixed for empty and populated projects", async () => {
    const empty = withQueryCount(db);

    await getProjectAgentization(empty.db, {
      projectId,
      mainBranch: "main",
      filters: {},
      now: NOW,
    });
    await seedRun("flow", 1);
    const populated = withQueryCount(db);

    await getProjectAgentization(populated.db, {
      projectId,
      mainBranch: "main",
      filters: {},
      now: NOW,
    });

    expect(empty.count()).toBe(populated.count());
    expect(empty.count()).toBeLessThanOrEqual(6);
  });
});

async function seedRun(
  runKind: schema.RunKind,
  inputTokens: number,
): Promise<string> {
  const runId = randomUUID();

  await db.insert(schema.runs).values({
    id: runId,
    projectId,
    runKind,
    status: "Done",
    flowVersion: "v1.0.0",
    startedAt: NOW,
    endedAt: NOW,
  });
  await db.insert(schema.runCostRollups).values({
    runId,
    projectId,
    inputTokens,
    sourceEventCount: 1,
  });

  return runId;
}

async function seedBudgetEvent(
  runId: string | null,
  kind: "run.escalated" | "run.failed",
  reason: string,
): Promise<void> {
  await db.insert(schema.domainEvents).values({
    kind,
    projectId,
    runId,
    actorType: "system",
    payload: { reason },
    occurredAt: NOW,
  });
}

function withQueryCount(database: NodePgDatabase<typeof schema>): {
  db: NodePgDatabase<typeof schema>;
  count: () => number;
} {
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
