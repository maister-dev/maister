// ADR-138 migration 0101_branch_sync coverage (Task 4).
//
// Asserts the run_sync_attempts ledger shape + constraints (UNIQUE (run_id,
// attempt); the plain-text `phase` column has NO DB CHECK — node_attempts
// convention; auto_finalize/pushed default false), and the two projects
// columns (sync_strategy_default default 'rebase'; sync_runner_id FK SET NULL
// on runner delete), plus the 0101 journal/snapshot pair.

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

const MIGRATIONS_DIR = path.resolve("lib/db/migrations");

let testDatabase: StartedPostgresTestDb;
let pool: Pool;

function newId(): string {
  return randomUUID();
}

async function seedRunWorkspace(label: string): Promise<{
  projectId: string;
  runId: string;
  workspaceId: string;
}> {
  const projectId = newId();
  const flowId = newId();
  const taskId = newId();
  const runId = newId();
  const workspaceId = newId();
  const short = projectId.replace(/-/g, "").slice(0, 8);

  await pool.query(
    `insert into projects (id, slug, name, repo_path, maister_yaml_path, task_key)
     values ($1, $2, $3, $4, '/tmp/m.yaml', $5)`,
    [
      projectId,
      `sync-${label}-${short}`,
      `Sync ${label}`,
      `/tmp/sync-${label}-${short}`,
      `T${short.toUpperCase()}`,
    ],
  );
  await pool.query(
    `insert into flows (id, project_id, flow_ref_id, source, version, installed_path, manifest, schema_version)
     values ($1, $2, 'bugfix', 'github.com/x/y', 'v1.0.0', '/tmp/flows/bugfix', '{"schemaVersion":1,"name":"Bugfix","nodes":[]}', 1)`,
    [flowId, projectId],
  );
  await pool.query(
    `insert into tasks (id, project_id, number, title, prompt, flow_id)
     values ($1, $2, 1, 'Sync task', 'do the thing', $3)`,
    [taskId, projectId, flowId],
  );
  await pool.query(
    `insert into runs (id, project_id, task_id, run_kind, status, flow_version, flow_revision, started_at)
     values ($1, $2, $3, 'flow', 'Review', 'v1', 'manual', now())`,
    [runId, projectId, taskId],
  );
  await pool.query(
    `insert into workspaces (id, run_id, project_id, branch, worktree_path, parent_repo_path)
     values ($1, $2, $3, 'maister/sync', $4, '/tmp/repo')`,
    [workspaceId, runId, projectId, `/tmp/wt-${short}`],
  );

  return { projectId, runId, workspaceId };
}

async function insertAttempt(
  runId: string,
  workspaceId: string,
  attempt: number,
  phase = "starting",
): Promise<string> {
  const id = newId();

  await pool.query(
    `insert into run_sync_attempts (id, run_id, workspace_id, attempt, strategy, mode, phase)
     values ($1, $2, $3, $4, 'rebase', 'mechanical', $5)`,
    [id, runId, workspaceId, attempt, phase],
  );

  return id;
}

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "branch_sync_test",
  });
  pool = testDatabase.pool;
}, 180_000);

afterAll(async () => {
  await testDatabase?.stop();
});

describe("0101 run_sync_attempts ledger", () => {
  it("creates the table with the key ledger columns", async () => {
    const cols = await pool.query(
      `select column_name from information_schema.columns
       where table_name = 'run_sync_attempts'
       and column_name in
       ('phase','strategy','mode','remote_sha_before','conflicted_files',
        'agent_running_since','auto_finalize','runner_id','session_name','pushed')
       order by column_name`,
    );

    expect(cols.rows.map((r) => r.column_name)).toEqual([
      "agent_running_since",
      "auto_finalize",
      "conflicted_files",
      "mode",
      "phase",
      "pushed",
      "remote_sha_before",
      "runner_id",
      "session_name",
      "strategy",
    ]);
  });

  it("enforces UNIQUE (run_id, attempt) with 23505", async () => {
    const { runId, workspaceId } = await seedRunWorkspace("uniq");

    await insertAttempt(runId, workspaceId, 1);

    await expect(insertAttempt(runId, workspaceId, 1)).rejects.toMatchObject({
      code: "23505",
    });

    // a different attempt number is fine.
    await insertAttempt(runId, workspaceId, 2);
  });

  it("accepts an arbitrary phase string (no DB CHECK — node_attempts convention)", async () => {
    const { runId, workspaceId } = await seedRunWorkspace("phase");

    // A value outside the TS enum is accepted by the DB (plain text, no CHECK).
    const id = await insertAttempt(
      runId,
      workspaceId,
      1,
      "totally_bogus_phase",
    );
    const row = await pool.query(
      `select phase from run_sync_attempts where id = $1`,
      [id],
    );

    expect(row.rows[0].phase).toBe("totally_bogus_phase");
  });

  it("defaults auto_finalize and pushed to false", async () => {
    const { runId, workspaceId } = await seedRunWorkspace("defaults");
    const id = await insertAttempt(runId, workspaceId, 1);
    const row = await pool.query(
      `select auto_finalize, pushed, phase from run_sync_attempts where id = $1`,
      [id],
    );

    expect(row.rows[0]).toEqual({
      auto_finalize: false,
      pushed: false,
      phase: "starting",
    });
  });
});

describe("0101 projects sync columns", () => {
  it("defaults sync_strategy_default to 'rebase'", async () => {
    const { projectId } = await seedRunWorkspace("strat");
    const row = await pool.query(
      `select sync_strategy_default, sync_runner_id from projects where id = $1`,
      [projectId],
    );

    expect(row.rows[0]).toEqual({
      sync_strategy_default: "rebase",
      sync_runner_id: null,
    });
  });

  it("nulls sync_runner_id when the referenced runner is deleted (FK SET NULL)", async () => {
    const { projectId } = await seedRunWorkspace("runnerfk");
    const runnerId = newId();

    await pool.query(
      `insert into platform_acp_runners (id, adapter, capability_agent, model, provider)
       values ($1, 'claude', 'claude', 'claude-sonnet-4-6', '{"kind":"anthropic"}')`,
      [runnerId],
    );
    await pool.query(`update projects set sync_runner_id = $1 where id = $2`, [
      runnerId,
      projectId,
    ]);

    await pool.query(`delete from platform_acp_runners where id = $1`, [
      runnerId,
    ]);

    const row = await pool.query(
      `select sync_runner_id from projects where id = $1`,
      [projectId],
    );

    expect(row.rows[0].sync_runner_id).toBeNull();
  });
});

describe("0101 journal + snapshot", () => {
  it("has a 0101 journal entry with a matching snapshot file", () => {
    const journal = JSON.parse(
      readFileSync(path.join(MIGRATIONS_DIR, "meta", "_journal.json"), "utf8"),
    ) as { entries: Array<{ idx: number; tag: string }> };

    const entry = journal.entries.find((e) => e.tag.startsWith("0101"));

    expect(entry).toBeDefined();
    const snapshotName = `${entry!.tag.slice(0, 4)}_snapshot.json`;

    expect(existsSync(path.join(MIGRATIONS_DIR, "meta", snapshotName))).toBe(
      true,
    );
  });
});
