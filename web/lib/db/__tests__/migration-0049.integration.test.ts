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

  // Full journal replay: 0027 creates the dead M24 agent_schedules shape,
  // 0049 reworks it in place — the rework must apply on top of the old shape.
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

async function seedAgent(): Promise<string> {
  const agentId = `test-pkg:agent-${randomUUID().slice(0, 8)}`;

  await pool.query(
    `INSERT INTO "agents" ("id", "package_name", "version_label", "origin", "name", "description", "workspace", "mode", "triggers", "risk_tier", "source_path")
     VALUES ($1, 'test-pkg', 'v1.0.0', 'git', 'A', 'desc', 'none', 'session', '["manual"]'::jsonb, 'read_only', '/tmp/agent.md')`,
    [agentId],
  );

  return agentId;
}

describe("migration 0049 — platform agents", () => {
  it("reworked agent_schedules has the new shape and the old columns are gone", async () => {
    const cols = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'agent_schedules'`,
    );
    const names = cols.rows.map((r) => r.column_name);

    expect(names).toEqual(
      expect.arrayContaining([
        "agent_id",
        "cron_expr",
        "timezone",
        "next_fire_at",
        "last_fired_at",
        "event_match",
      ]),
    );
    expect(names).not.toContain("agent_ref");
    expect(names).not.toContain("scheduler_job_id");
    expect(names).not.toContain("desired_state");
  });

  it("0051 reshapes agents to package provenance (scope/project gone, NOT NULLs enforced)", async () => {
    const cols = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'agents'`,
    );
    const names = cols.rows.map((r) => r.column_name);

    // ADR-106 (migration 0062) re-keyed the provenance column flow_ref_id →
    // package_name and added flow_ref / branch_base.
    expect(names).toEqual(
      expect.arrayContaining([
        "package_name",
        "version_label",
        "origin",
        "recommended",
        "workspace_ref",
      ]),
    );
    expect(names).not.toContain("scope");
    expect(names).not.toContain("project_id");
    expect(names).not.toContain("flow_ref_id");

    await expect(
      pool.query(
        `INSERT INTO "agents" ("id", "name", "description", "workspace", "mode", "triggers", "risk_tier", "source_path")
         VALUES ('no-provenance', 'A', 'd', 'none', 'session', '["manual"]'::jsonb, 'read_only', '/tmp/a.md')`,
      ),
    ).rejects.toThrow(/package_name|not-null/);
  });

  it("agent_schedules shape CHECKs enforce cron and event row fields", async () => {
    const projectId = await seedProject();
    const agentId = await seedAgent();

    await expect(
      pool.query(
        `INSERT INTO "agent_schedules" ("id", "agent_id", "project_id", "trigger_type")
         VALUES ($1, $2, $3, 'cron')`,
        [randomUUID(), agentId, projectId],
      ),
    ).rejects.toThrow(/agent_schedules_cron_shape_check/);

    await expect(
      pool.query(
        `INSERT INTO "agent_schedules" ("id", "agent_id", "project_id", "trigger_type")
         VALUES ($1, $2, $3, 'event')`,
        [randomUUID(), agentId, projectId],
      ),
    ).rejects.toThrow(/agent_schedules_event_shape_check/);

    await pool.query(
      `INSERT INTO "agent_schedules" ("id", "agent_id", "project_id", "trigger_type", "cron_expr", "timezone", "next_fire_at")
       VALUES ($1, $2, $3, 'cron', '0 * * * *', 'UTC', now())`,
      [randomUUID(), agentId, projectId],
    );
    await pool.query(
      `INSERT INTO "agent_schedules" ("id", "agent_id", "project_id", "trigger_type", "event_match")
       VALUES ($1, $2, $3, 'event', '{"kinds":["task.created"]}'::jsonb)`,
      [randomUUID(), agentId, projectId],
    );
  });

  it("partial unique (agent_id, trigger_event_id) makes redelivery converge to one run", async () => {
    const projectId = await seedProject();
    const agentId = await seedAgent();

    const insertRun = (id: string, eventId: number | null) =>
      pool.query(
        `INSERT INTO "runs" ("id", "run_kind", "agent_id", "trigger_source", "trigger_event_id", "project_id", "flow_version", "flow_revision", "status")
         VALUES ($1, 'agent', $2, $3, $4, $5, 'agent', 'manual', 'Pending')`,
        [
          id,
          agentId,
          eventId === null ? "manual" : "domain_event",
          eventId,
          projectId,
        ],
      );

    await insertRun(randomUUID(), 12345);
    await expect(insertRun(randomUUID(), 12345)).rejects.toThrow(
      /runs_agent_trigger_event_uq/,
    );
    // NULL trigger_event_id rows are outside the partial index.
    await insertRun(randomUUID(), null);
    await insertRun(randomUUID(), null);
  });

  it("project_tokens pairs token_kind=agent with agent_id", async () => {
    const projectId = await seedProject();
    const agentId = await seedAgent();

    await expect(
      pool.query(
        `INSERT INTO "project_tokens" ("id", "project_id", "name", "token_kind", "prefix", "token_hash")
         VALUES ($1, $2, 'bad agent token', 'agent', 'mai_badagent', 'hash')`,
        [randomUUID(), projectId],
      ),
    ).rejects.toThrow(/project_tokens_agent_kind_check/);

    await expect(
      pool.query(
        `INSERT INTO "project_tokens" ("id", "project_id", "name", "token_kind", "agent_id", "prefix", "token_hash")
         VALUES ($1, $2, 'bad project token', 'project', $3, 'mai_badproj1', 'hash')`,
        [randomUUID(), projectId, agentId],
      ),
    ).rejects.toThrow(/project_tokens_agent_kind_check/);

    await pool.query(
      `INSERT INTO "project_tokens" ("id", "project_id", "name", "token_kind", "agent_id", "prefix", "token_hash")
       VALUES ($1, $2, 'agent token', 'agent', $3, 'mai_agentok1', 'hash')`,
      [randomUUID(), projectId, agentId],
    );
  });

  it("tasks accept flowless simple-intent rows and the verdict columns", async () => {
    const projectId = await seedProject();

    await pool.query(
      `INSERT INTO "tasks" ("id", "project_id", "number", "title", "prompt", "triage_status", "target_branch", "promotion_mode")
       VALUES ($1, $2, 1, 'simple intent', 'do the thing', 'triaged', 'main', 'local_merge')`,
      [randomUUID(), projectId],
    );

    const row = await pool.query(
      `SELECT "flow_id", "triage_status" FROM "tasks" WHERE "project_id" = $1`,
      [projectId],
    );

    expect(row.rows[0]).toMatchObject({
      flow_id: null,
      triage_status: "triaged",
    });
  });

  it("deleting an agent cascades links/schedules/tokens and detaches runs", async () => {
    const projectId = await seedProject();
    const agentId = await seedAgent();

    await pool.query(
      `INSERT INTO "agent_project_links" ("id", "agent_id", "project_id") VALUES ($1, $2, $3)`,
      [randomUUID(), agentId, projectId],
    );
    await pool.query(
      `INSERT INTO "agent_schedules" ("id", "agent_id", "project_id", "trigger_type", "event_match")
       VALUES ($1, $2, $3, 'event', '{"kinds":["task.created"]}'::jsonb)`,
      [randomUUID(), agentId, projectId],
    );
    await pool.query(
      `INSERT INTO "project_tokens" ("id", "project_id", "name", "token_kind", "agent_id", "prefix", "token_hash")
       VALUES ($1, $2, 't', 'agent', $3, 'mai_cascade1', 'hash')`,
      [randomUUID(), projectId, agentId],
    );
    const runId = randomUUID();

    await pool.query(
      `INSERT INTO "runs" ("id", "run_kind", "agent_id", "trigger_source", "project_id", "flow_version", "flow_revision", "status", "ended_at")
       VALUES ($1, 'agent', $2, 'manual', $3, 'agent', 'manual', 'Done', now())`,
      [runId, agentId, projectId],
    );

    await pool.query(`DELETE FROM "agents" WHERE "id" = $1`, [agentId]);

    const counts = await pool.query<{
      links: string;
      schedules: string;
      tokens: string;
    }>(
      `SELECT
        (SELECT count(*) FROM "agent_project_links" WHERE "agent_id" = $1) AS links,
        (SELECT count(*) FROM "agent_schedules" WHERE "agent_id" = $1) AS schedules,
        (SELECT count(*) FROM "project_tokens" WHERE "agent_id" = $1) AS tokens`,
      [agentId],
    );

    expect(counts.rows[0]).toMatchObject({
      links: "0",
      schedules: "0",
      tokens: "0",
    });

    const run = await pool.query(
      `SELECT "agent_id" FROM "runs" WHERE "id" = $1`,
      [runId],
    );

    expect(run.rows[0].agent_id).toBeNull();
  });
});
