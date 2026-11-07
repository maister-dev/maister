import { randomUUID } from "node:crypto";

import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, expect, it } from "vitest";

import { seedProjectRow } from "@/test-support/execution-host-seed";
import { upgradeMainTestDb } from "@/test-support/migration-upgrade";
import {
  startMainPostgresTestDbUpTo,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

let database: StartedPostgresTestDb;
const taskId = randomUUID();
let projectId: string;
let before: unknown;

beforeAll(async () => {
  database = await startMainPostgresTestDbUpTo(
    { databaseName: "triage_origin_upgrade" },
    "0222_task_launch_preparation",
  );
  projectId = (await seedProjectRow(database.db)).id;
  await database.pool.query(
    "INSERT INTO tasks(id,project_id,number,title,prompt,triage_status) VALUES($1,$2,1,'Historical hold','Retain original input','flagged')",
    [taskId, projectId],
  );
  before = (
    await database.pool.query(
      "SELECT to_jsonb(t) AS value FROM tasks t WHERE id=$1",
      [taskId],
    )
  ).rows[0].value;
  await upgradeMainTestDb(database, "0222_task_launch_preparation");
}, 180_000);

afterAll(async () => {
  await database?.stop();
});

it("populated upgrade classifies historical flags unknown without rewriting task evidence; journal replay is inert", async () => {
  await migrate(database.db, { migrationsFolder: "./lib/db/migrations" });
  const row = (
    await database.pool.query(
      "SELECT to_jsonb(t)-'triage_flag_origin' AS value,triage_flag_origin FROM tasks t WHERE id=$1",
      [taskId],
    )
  ).rows[0];

  expect(row.value).toEqual(before);
  expect(row.triage_flag_origin).toBe("unknown");
});

it("future flags require a bounded origin, and unflagging must clear it", async () => {
  await expect(
    database.pool.query(
      "INSERT INTO tasks(id,project_id,number,title,prompt,triage_status) VALUES($1,$2,2,'New hold','Input','flagged')",
      [randomUUID(), projectId],
    ),
  ).rejects.toMatchObject({ constraint: "tasks_triage_flag_origin_check" });
  await expect(
    database.pool.query(
      "UPDATE tasks SET triage_flag_origin='invented' WHERE id=$1",
      [taskId],
    ),
  ).rejects.toMatchObject({ constraint: "tasks_triage_flag_origin_check" });
  await database.pool.query("UPDATE tasks SET triage_status=NULL WHERE id=$1", [
    taskId,
  ]);
  expect(
    (
      await database.pool.query(
        "SELECT triage_status,triage_flag_origin FROM tasks WHERE id=$1",
        [taskId],
      )
    ).rows[0],
  ).toEqual({ triage_status: null, triage_flag_origin: null });
});
