import { randomUUID } from "node:crypto";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import * as fullSchema from "@/lib/db/schema";
import {
  testPlatformRunnerRow,
  testRunnerSnapshot,
} from "@/lib/__tests__/runner-fixtures";
import { buildAutoPromotionReaders } from "@/lib/auto-promotion/readers";

// ADR-126 F3: externalCheck must return `not_declared` (→ external_check_missing)
// when the lane's requireExternalCheckId is absent from the run's COMPILED flow
// graph, distinct from `declared_not_passed` (declared but no passing gate row).

const schema = fullSchema as unknown as Record<string, any>;

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;

// A graph manifest whose review node declares an external_check gate id "ci".
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
            external: { staleOnNewCommit: true },
          },
        ],
      },
      finish: { human: { role: "maintainer", decisions: ["approve"] } },
      transitions: { approve: "done" },
    },
  ],
};

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("readers_external_test")
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

beforeEach(async () => {
  for (const t of [
    "gate_results",
    "node_attempts",
    "workspaces",
    "runs",
    "tasks",
    "flows",
    "platform_acp_runners",
    "projects",
  ]) {
    await pool.query(`DELETE FROM "${t}"`);
  }
});

async function seedRun(manifest: unknown): Promise<string> {
  const projectId = randomUUID();
  const slug = `p-${projectId.slice(0, 8)}`;
  const runnerId = randomUUID();
  const flowId = randomUUID();
  const taskId = randomUUID();
  const runId = randomUUID();

  await db.insert(schema.projects).values({
    id: projectId,
    slug,
    name: "P",
    repoPath: `/tmp/${slug}`,
    maisterYamlPath: "/tmp/m.yaml",
    taskKey: `T${projectId
      .replace(/[^0-9A-Za-z]/g, "")
      .slice(0, 7)
      .toUpperCase()}`,
  });
  await db
    .insert(schema.platformAcpRunners)
    .values(testPlatformRunnerRow(runnerId, "claude"));
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
    id: taskId,
    projectId,
    number: 1,
    title: "t",
    prompt: "p",
    flowId,
  });
  await db.insert(schema.runs).values({
    id: runId,
    taskId,
    projectId,
    flowId,
    runnerId,
    capabilityAgent: "claude",
    runnerSnapshot: testRunnerSnapshot(runnerId, "claude"),
    flowVersion: "v1.0.0",
    status: "Review",
    runKind: "flow",
  });
  await db.insert(schema.workspaces).values({
    id: randomUUID(),
    runId,
    projectId,
    branch: "feature/test",
    worktreePath: `/tmp/wt-${runId}`,
    parentRepoPath: `/tmp/${slug}`,
  });

  return runId;
}

async function seedGate(runId: string, status: string): Promise<void> {
  const nodeAttemptId = randomUUID();

  await db.insert(schema.nodeAttempts).values({
    id: nodeAttemptId,
    runId,
    nodeId: "review",
    nodeType: "check",
    attempt: 1,
    status: "Succeeded",
    startedAt: new Date("2026-07-03T10:00:00.000Z"),
  });
  await db.insert(schema.gateResults).values({
    id: randomUUID(),
    runId,
    nodeAttemptId,
    gateId: "ci",
    kind: "external_check",
    mode: "blocking",
    status,
  });
}

function readers(runId: string) {
  return buildAutoPromotionReaders({
    db,
    runId,
    worktreePath: "/tmp/x",
    baseRef: "abc",
    branch: "feature/test",
  });
}

describe("externalCheck reader — graph declaration lookup (ADR-126 F3)", () => {
  it("a declared gate with no passing row ⇒ declared_not_passed", async () => {
    const runId = await seedRun(MANIFEST);

    expect(await readers(runId).externalCheck("ci")).toBe(
      "declared_not_passed",
    );
  });

  it("a declared gate with a passed row ⇒ passed", async () => {
    const runId = await seedRun(MANIFEST);

    await seedGate(runId, "passed");

    expect(await readers(runId).externalCheck("ci")).toBe("passed");
  });

  it("a gateId absent from the compiled flow graph ⇒ not_declared", async () => {
    const runId = await seedRun(MANIFEST);

    expect(await readers(runId).externalCheck("typo-not-in-flow")).toBe(
      "not_declared",
    );
  });

  it("a malformed manifest fails closed to not_declared (no throw)", async () => {
    const runId = await seedRun({ totally: "not a flow" });

    expect(await readers(runId).externalCheck("ci")).toBe("not_declared");
  });
});
