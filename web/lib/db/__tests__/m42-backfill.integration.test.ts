// M42 (ADR-114) migration 0082 backfills `run_sessions` from the runs runner
// mirror BEFORE dropping the columns, so existing runs keep their resume handle
// (acp_session_id) + runner snapshot. This exercises the REAL backfill statement
// from 0082.sql: it re-adds the dropped columns to a migrated schema, seeds a run
// carrying resume state, runs the backfill, and asserts the default session row.
import { readFileSync } from "node:fs";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schemaModule from "@/lib/db/schema";

const schema = schemaModule as unknown as Record<string, any>;

const BACKFILL_SQL = readFileSync(
  "./lib/db/migrations/0082_m42_drop_runs_runner_mirror.sql",
  "utf8",
)
  .split("--> statement-breakpoint")[0]
  .trim();

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("m42_backfill_test")
    .withUsername("test")
    .withPassword("test")
    .start();

  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);

  await migrate(db, { migrationsFolder: "./lib/db/migrations" });

  // Re-create the pre-0082 shape so the backfill SELECT has its source columns.
  await pool.query(
    `ALTER TABLE "runs"
       ADD COLUMN "runner_id" text,
       ADD COLUMN "runner_resolution_tier" text,
       ADD COLUMN "capability_agent" text,
       ADD COLUMN "runner_snapshot" jsonb,
       ADD COLUMN "acp_session_id" text`,
  );
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

describe("M42 migration 0082 backfill", () => {
  it("copies a run's runner mirror + acp_session_id into a default run_session", async () => {
    const projectId = crypto.randomUUID();
    const slug = `proj-${projectId.slice(0, 8)}`;

    await db.insert(schema.projects).values({
      id: projectId,
      taskKey: `T${projectId.slice(0, 8)}`.toUpperCase(),
      slug,
      name: `Project ${slug}`,
      repoPath: `/repos/${slug}`,
      maisterYamlPath: `/repos/${slug}/maister.yaml`,
    });

    const runId = crypto.randomUUID();

    await db.insert(schema.runs).values({
      id: runId,
      projectId,
      runKind: "scratch",
      status: "Crashed",
      flowVersion: "scratch",
      flowRevision: "manual",
    });
    await pool.query(
      `UPDATE "runs"
         SET "runner_resolution_tier" = 'projectDefault',
             "capability_agent" = 'claude',
             "runner_snapshot" = '{"adapter":"claude","model":"claude-sonnet-4-6"}'::jsonb,
             "acp_session_id" = 'resume-handle-xyz'
       WHERE "id" = $1`,
      [runId],
    );

    await pool.query(BACKFILL_SQL);

    const { rows } = await pool.query(
      `SELECT session_name, runner_resolution_tier, capability_agent,
              runner_snapshot, acp_session_id
       FROM run_sessions WHERE run_id = $1`,
      [runId],
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].session_name).toBe("default");
    expect(rows[0].acp_session_id).toBe("resume-handle-xyz");
    expect(rows[0].capability_agent).toBe("claude");
    expect(rows[0].runner_resolution_tier).toBe("projectDefault");
    expect(rows[0].runner_snapshot).toMatchObject({
      model: "claude-sonnet-4-6",
    });
  });

  it("skips runs with no runner/resume state", async () => {
    const projectId = crypto.randomUUID();
    const slug = `proj-${projectId.slice(0, 8)}`;

    await db.insert(schema.projects).values({
      id: projectId,
      taskKey: `T${projectId.slice(0, 8)}`.toUpperCase(),
      slug,
      name: `Project ${slug}`,
      repoPath: `/repos/${slug}`,
      maisterYamlPath: `/repos/${slug}/maister.yaml`,
    });

    const runId = crypto.randomUUID();

    await db.insert(schema.runs).values({
      id: runId,
      projectId,
      runKind: "scratch",
      status: "Pending",
      flowVersion: "scratch",
      flowRevision: "manual",
    });

    await pool.query(BACKFILL_SQL);

    const { rows } = await pool.query(
      `SELECT 1 FROM run_sessions WHERE run_id = $1`,
      [runId],
    );

    expect(rows).toHaveLength(0);
  });
});
