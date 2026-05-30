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
  await db.insert(schema.executors).values({
    id: executorId,
    projectId,
    executorRefId: "claude-sonnet",
    agent: "claude",
    model: "claude-sonnet-4-6",
  });
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
    executorId,
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

  it("deferred kinds are recorded (artifact_required → skipped, external_check → pending), not silently passed", async () => {
    const seeded = await seedGraphRun(
      oneNode([
        { id: "art", kind: "artifact_required", mode: "blocking" },
        { id: "ext", kind: "external_check", mode: "blocking" },
      ]),
    );

    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });

    // Neither stub is a blocking *failure*, so the node finishes.
    expect((await getRun(seeded.runId)).status).toBe("Review");
    const gates = await getGates(seeded.runId);

    expect(gates.find((g) => g.gateId === "art")?.status).toBe("skipped");
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
