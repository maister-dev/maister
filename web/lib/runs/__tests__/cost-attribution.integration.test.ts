import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
import { reconcileRunCostRollups } from "@/lib/runs/cost-rollups";

const schema = fullSchema as unknown as Record<string, any>;

type Db = NodePgDatabase<typeof fullSchema>;

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: Db;
let runtimeRoot: string;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("maister_cost_attribution_test")
    .withUsername("test")
    .withPassword("test")
    .start();

  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool, { schema: fullSchema }) as unknown as Db;

  await migrate(db, { migrationsFolder: "./lib/db/migrations" });
  runtimeRoot = await mkdtemp(join(tmpdir(), "cost-attribution-"));
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
  if (runtimeRoot) await rm(runtimeRoot, { recursive: true, force: true });
});

describe("per-node cost attribution chain (T-D3)", () => {
  it("attributes cost.jsonl to each node attempt and run-total = sum of nodes", async () => {
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

    // cost.jsonl in the canonical (snake_case) shape the fixed extractCost now
    // writes for EVERY node session — one record per node, attributed by
    // nodeAttemptId (the second node previously wrote nothing).
    const dir = join(runtimeRoot, ".maister", slug, "runs", runId);

    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "cost.jsonl"),
      [
        JSON.stringify({
          model: "claude-sonnet-4-6",
          nodeAttemptId: implAttempt,
          input_tokens: 1000,
          output_tokens: 200,
          cache_read_input_tokens: 50,
          cache_creation_input_tokens: 30,
        }),
        JSON.stringify({
          model: "claude-sonnet-4-6",
          nodeAttemptId: reviewAttempt,
          input_tokens: 400,
          output_tokens: 80,
        }),
      ].join("\n") + "\n",
    );

    await reconcileRunCostRollups(runId, { client: db, runtimeRoot });

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
