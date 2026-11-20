import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import { readMigrationFiles } from "drizzle-orm/migrator";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { expect, it } from "vitest";

import { seedProjectRow, seedRun } from "@/test-support/execution-host-seed";
import { declareCurrentTestDatabaseWriter, startMainPostgresTestDbUpTo } from "@/test-support/pg-container";

it("upgrades a populated predecessor while preserving old attempt and transcript evidence", async () => {
  const db = await startMainPostgresTestDbUpTo(
    { databaseName: "acp_context_upgrade" },
    "0342_domain_event_run_pr_merged",
  );

  try {
    await declareCurrentTestDatabaseWriter(db);
    const runId = randomUUID();
    const attemptId = randomUUID();
    const messageId = randomUUID();
    const projectId = (await seedProjectRow(db.db)).id;
    await seedRun(db.db, { id: runId, projectId, runKind: "flow" });
    await db.pool.query(
      "INSERT INTO node_attempts (id,run_id,node_id,node_type,status,error_code) VALUES($1,$2,'fixture','ai_coding','Failed','ACP_PROTOCOL')",
      [attemptId, runId],
    );
    const content = JSON.stringify({
      v: 1,
      kind: "usage",
      used: 80,
      size: 100,
    });
    await db.pool.query(
      "INSERT INTO run_messages (id,run_id,node_attempt_id,role,content,sequence,first_supervisor_event_id,supervisor_event_id) VALUES($1,$2,$3,'system',$4,1,'4','5')",
      [messageId, runId, attemptId, content],
    );
    const migrationsFolder = "./lib/db/migrations";
    const journal = JSON.parse(await readFile(`${migrationsFolder}/meta/_journal.json`, "utf8")) as {
      entries: { tag: string; when: number }[];
    };
    const cutoff = journal.entries.find(({ tag }) => tag === "0342_domain_event_run_pr_merged")?.when;

    if (!cutoff) throw new Error("missing context migration predecessor");
    const applied = readMigrationFiles({ migrationsFolder }).filter(({ folderMillis }) => folderMillis <= cutoff);
    await db.pool.query(
      "CREATE SCHEMA drizzle; CREATE TABLE drizzle.__drizzle_migrations (id serial PRIMARY KEY, hash text NOT NULL, created_at bigint)",
    );
    await db.pool.query(
      "INSERT INTO drizzle.__drizzle_migrations(hash,created_at) SELECT * FROM unnest($1::text[],$2::bigint[])",
      [
        applied.map((migration) => migration.hash),
        applied.map((migration) => migration.folderMillis),
      ],
    );
    await migrate(db.db, { migrationsFolder });
    await migrate(db.db, { migrationsFolder });

    expect(
      (
        await db.pool.query(
          "SELECT error_code,error_reason FROM node_attempts WHERE id=$1",
          [attemptId],
        )
      ).rows,
    ).toEqual([{ error_code: "ACP_PROTOCOL", error_reason: null }]);
    expect(
      (
        await db.pool.query(
          "SELECT content,first_supervisor_event_id,supervisor_event_id FROM run_messages WHERE id=$1",
          [messageId],
        )
      ).rows,
    ).toEqual([
      { content, first_supervisor_event_id: "4", supervisor_event_id: "5" },
    ]);
    await expect(
      db.pool.query(
        "INSERT INTO run_context_usage(run_id, execution_host_id, assignment_id, assignment_epoch, host_session_id, used_tokens, last_run_sequence) VALUES($1,'host','assignment',1,'session',0,1)",
        [runId],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  } finally {
    await db.stop();
  }
}, 180_000);
