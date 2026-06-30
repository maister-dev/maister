// ADR-121 (G6 read half / T16): the Observatory surfaces low advisory confidence
// read-only. Low-confidence non-terminal tasks surface least-confident first; null
// confidence and terminal tasks are excluded; the query mutates nothing (INV-5
// holds — this is the advisory surface, not an admission input).

import { randomUUID } from "node:crypto";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as fullSchema from "@/lib/db/schema";
import { getLowConfidenceSignal } from "@/lib/queries/observatory-confidence";

const schema = fullSchema as unknown as Record<string, any>;

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;
let projectId: string;
let seq = 0;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("maister_obs_confidence_test")
    .withUsername("test")
    .withPassword("test")
    .start();

  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);
  await migrate(db, { migrationsFolder: "./lib/db/migrations" });

  projectId = randomUUID();
  await db.insert(schema.projects).values({
    id: projectId,
    slug: `obs-${projectId.slice(0, 8)}`,
    name: "Obs",
    repoPath: `/tmp/obs-${projectId.slice(0, 8)}`,
    taskKey: `O${projectId.slice(0, 8)}`.toUpperCase(),
  });
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

async function seedTask(opts: {
  confidence: number | null;
  status?: "Backlog" | "InFlight" | "Done";
}): Promise<string> {
  const id = randomUUID();

  seq += 1;
  await db.insert(schema.tasks).values({
    id,
    projectId,
    number: seq,
    title: `t${seq}`,
    prompt: "p",
    status: opts.status ?? "Backlog",
    triageConfidence: opts.confidence == null ? null : String(opts.confidence),
  });

  return id;
}

describe("getLowConfidenceSignal (ADR-121 T16)", () => {
  it("surfaces non-terminal low-confidence tasks least-confident first", async () => {
    const low = await seedTask({ confidence: 0.2 });
    const mid = await seedTask({ confidence: 0.45 });

    await seedTask({ confidence: 0.9 }); // above threshold → excluded
    await seedTask({ confidence: null }); // no confidence → excluded
    await seedTask({ confidence: 0.1, status: "Done" }); // terminal → excluded

    const signal = await getLowConfidenceSignal({
      projectIds: [projectId],
      db,
    });

    expect(signal.threshold).toBe(0.5);
    expect(signal.count).toBe(2);
    expect(signal.tasks.map((t) => t.taskId)).toEqual([low, mid]);
    expect(signal.tasks[0].confidence).toBe(0.2);
  });
});
