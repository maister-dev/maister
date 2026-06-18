import { randomUUID } from "node:crypto";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

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

async function seedProject(): Promise<string> {
  const projectId = randomUUID();

  await pool.query(
    `INSERT INTO "projects" ("id", "slug", "name", "repo_path", "main_branch", "branch_prefix", "maister_yaml_path", "task_key")
     VALUES ($1, $2, $3, $4, 'main', 'maister/', '/tmp/maister.yaml', $5)`,
    [
      projectId,
      `p-${projectId.slice(0, 8)}`,
      "P",
      `/repos/${projectId}`,
      `K${projectId
        .replace(/[^0-9A-Za-z]/g, "")
        .slice(0, 8)
        .toUpperCase()}`,
    ],
  );

  return projectId;
}

describe("migration 0055 — execution-control policy", () => {
  it("adds the three execution-policy columns with correct nullability", async () => {
    const cols = await pool.query<{
      table_name: string;
      column_name: string;
      is_nullable: string;
      data_type: string;
    }>(
      `SELECT table_name, column_name, is_nullable, data_type
       FROM information_schema.columns
       WHERE (table_name = 'runs' AND column_name = 'execution_policy')
          OR (table_name = 'projects' AND column_name = 'execution_policy_default')
          OR (table_name = 'tasks' AND column_name = 'execution_policy')`,
    );
    const byKey = new Map(
      cols.rows.map((r) => [`${r.table_name}.${r.column_name}`, r]),
    );

    expect(byKey.get("runs.execution_policy")).toMatchObject({
      is_nullable: "NO",
      data_type: "jsonb",
    });
    expect(byKey.get("projects.execution_policy_default")).toMatchObject({
      is_nullable: "YES",
      data_type: "jsonb",
    });
    expect(byKey.get("tasks.execution_policy")).toMatchObject({
      is_nullable: "YES",
      data_type: "jsonb",
    });
  });

  it("runs.execution_policy defaults to the supervised preset", async () => {
    const projectId = await seedProject();
    const runId = randomUUID();

    await pool.query(
      `INSERT INTO "runs" ("id", "project_id", "flow_version") VALUES ($1, $2, 'v1')`,
      [runId, projectId],
    );

    const row = await pool.query<{ execution_policy: unknown }>(
      `SELECT "execution_policy" FROM "runs" WHERE "id" = $1`,
      [runId],
    );

    expect(row.rows[0].execution_policy).toEqual({ preset: "supervised" });
  });

  it("projects/tasks execution-policy default to null and round-trip a stored policy", async () => {
    const projectId = await seedProject();

    const proj = await pool.query<{ execution_policy_default: unknown }>(
      `SELECT "execution_policy_default" FROM "projects" WHERE "id" = $1`,
      [projectId],
    );

    expect(proj.rows[0].execution_policy_default).toBeNull();

    await pool.query(
      `INSERT INTO "tasks" ("id", "project_id", "number", "title", "prompt", "execution_policy")
       VALUES ($1, $2, 1, 't', 'p', '{"preset":"unattended","overrides":{"checks":"strict"}}'::jsonb)`,
      [randomUUID(), projectId],
    );

    const task = await pool.query<{ execution_policy: unknown }>(
      `SELECT "execution_policy" FROM "tasks" WHERE "project_id" = $1`,
      [projectId],
    );

    expect(task.rows[0].execution_policy).toEqual({
      preset: "unattended",
      overrides: { checks: "strict" },
    });
  });
});
