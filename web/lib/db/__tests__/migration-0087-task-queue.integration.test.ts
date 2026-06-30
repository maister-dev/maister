import { randomUUID } from "node:crypto";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

type Db = NodePgDatabase;
type NullableRow = { is_nullable: "YES" | "NO" };
type DefaultRow = { column_default: string | null };

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: Db;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("maister_migration_0087_test")
    .withUsername("test")
    .withPassword("test")
    .start();

  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);

  // Migrates clean on a FRESH DB (full chain 0000..0087).
  await migrate(db, { migrationsFolder: "./lib/db/migrations" });
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

async function seedProject(): Promise<string> {
  const projectId = randomUUID();
  const slug = `proj-${projectId.slice(0, 8)}`;

  await db.execute(sql`
    INSERT INTO projects (id, slug, name, repo_path, task_key)
    VALUES (${projectId}, ${slug}, ${`Project ${slug}`}, ${`/tmp/${slug}`}, ${`T${projectId.slice(0, 8)}`.toUpperCase()})
  `);

  return projectId;
}

async function insertTask(
  projectId: string,
  columns: string,
  values: string,
): Promise<void> {
  const id = randomUUID();

  await db.execute(
    sql.raw(
      `INSERT INTO tasks (id, project_id, number, title, prompt${columns}) VALUES ('${id}', '${projectId}', ${Math.floor(Math.random() * 1_000_000)}, 't', 'p'${values})`,
    ),
  );
}

describe("migration 0087 — priority-ordered task queue columns (ADR-121)", () => {
  it("adds all 7 columns with the documented nullability/defaults", async () => {
    const cols = await db.execute<
      NullableRow & DefaultRow & { column_name: string; table_name: string }
    >(
      sql`SELECT table_name, column_name, is_nullable, column_default
          FROM information_schema.columns
          WHERE (table_name = 'tasks' AND column_name IN ('priority','triage_confidence','queue_paused','queue_claimed_at'))
             OR (table_name = 'projects' AND column_name = 'task_queue_settings')
             OR (table_name = 'runs' AND column_name IN ('resume_requested_at','queue_admitted_at'))
          ORDER BY table_name, column_name`,
    );

    expect(cols.rows).toHaveLength(7);

    const byKey = new Map(
      cols.rows.map((r) => [`${r.table_name}.${r.column_name}`, r]),
    );

    expect(byKey.get("tasks.priority")?.is_nullable).toBe("NO");
    expect(byKey.get("tasks.priority")?.column_default).toContain("normal");
    expect(byKey.get("tasks.queue_paused")?.is_nullable).toBe("NO");
    expect(byKey.get("tasks.queue_paused")?.column_default).toContain("false");
    expect(byKey.get("tasks.triage_confidence")?.is_nullable).toBe("YES");
    expect(byKey.get("tasks.queue_claimed_at")?.is_nullable).toBe("YES");
    expect(byKey.get("projects.task_queue_settings")?.is_nullable).toBe("YES");
    expect(byKey.get("runs.resume_requested_at")?.is_nullable).toBe("YES");
    expect(byKey.get("runs.queue_admitted_at")?.is_nullable).toBe("YES");
  });

  it("defaults a new task to priority='normal', queue_paused=false", async () => {
    const projectId = await seedProject();

    await insertTask(projectId, "", "");

    const row = await db.execute<{ priority: string; queue_paused: boolean }>(
      sql`SELECT priority, queue_paused FROM tasks WHERE project_id = ${projectId} LIMIT 1`,
    );

    expect(row.rows[0].priority).toBe("normal");
    expect(row.rows[0].queue_paused).toBe(false);
  });

  it("priority CHECK accepts the closed set and rejects out-of-set", async () => {
    const projectId = await seedProject();

    for (const p of ["low", "normal", "high", "urgent"]) {
      await expect(
        insertTask(projectId, ", priority", `, '${p}'`),
      ).resolves.not.toThrow();
    }

    await expect(
      insertTask(projectId, ", priority", `, 'critical'`),
    ).rejects.toThrow(/tasks_priority_check/);
  });

  it("triage_confidence CHECK rejects -0.001 and 1.001; accepts 0, 1, NULL (F4)", async () => {
    const projectId = await seedProject();

    // Accepted boundary + NULL.
    await expect(
      insertTask(projectId, ", triage_confidence", `, 0`),
    ).resolves.not.toThrow();
    await expect(
      insertTask(projectId, ", triage_confidence", `, 1`),
    ).resolves.not.toThrow();
    await expect(
      insertTask(projectId, ", triage_confidence", `, NULL`),
    ).resolves.not.toThrow();
    await expect(
      insertTask(projectId, ", triage_confidence", `, 0.873`),
    ).resolves.not.toThrow();

    // Rejected — out of [0,1].
    await expect(
      insertTask(projectId, ", triage_confidence", `, -0.001`),
    ).rejects.toThrow(/tasks_triage_confidence_check/);
    await expect(
      insertTask(projectId, ", triage_confidence", `, 1.001`),
    ).rejects.toThrow(/tasks_triage_confidence_check/);
  });
});
