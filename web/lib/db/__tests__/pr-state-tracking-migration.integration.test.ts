// ADR-139 migration 0103_pr_state_tracking coverage (Task 3).
//
// The shared harness applies every migration ALL-AT-ONCE in beforeAll, so a
// fresh DB carries 0103. We assert: the five workspaces PR columns exist, the
// workspaces_pr_state CHECK accepts open/merged/closed/NULL and rejects an
// illegal value, BOTH event_kind CHECKs (task_activity + inbox_items) accept
// the new run_pr_merged kind, pre-existing-shape rows keep NULL PR state, the
// partial scan index exists, and the newest journal entry (0103) has a
// matching snapshot file.

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
  taskId: string;
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
      `pr-${label}-${short}`,
      `PR ${label}`,
      `/tmp/pr-${label}-${short}`,
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
     values ($1, $2, 1, 'PR task', 'do the thing', $3)`,
    [taskId, projectId, flowId],
  );
  await pool.query(
    `insert into runs (id, project_id, task_id, run_kind, status, flow_version, flow_revision, started_at)
     values ($1, $2, $3, 'flow', 'Done', 'v1', 'manual', now())`,
    [runId, projectId, taskId],
  );
  await pool.query(
    `insert into workspaces (id, run_id, project_id, branch, worktree_path, parent_repo_path)
     values ($1, $2, $3, 'maister/pr', $4, '/tmp/repo')`,
    [workspaceId, runId, projectId, `/tmp/wt-${short}`],
  );

  return { projectId, taskId, runId, workspaceId };
}

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "pr_state_tracking_test",
  });
  pool = testDatabase.pool;
}, 180_000);

afterAll(async () => {
  await testDatabase?.stop();
});

describe("0103 pr_state_tracking schema shape", () => {
  it("adds the five workspaces PR columns, all nullable", async () => {
    const cols = await pool.query(
      `select column_name, is_nullable from information_schema.columns
       where table_name = 'workspaces'
       and column_name in ('pr_state','pr_has_conflicts','pr_merged_at','pr_merge_commit_sha','pr_state_checked_at')
       order by column_name`,
    );

    expect(cols.rows).toEqual([
      { column_name: "pr_has_conflicts", is_nullable: "YES" },
      { column_name: "pr_merge_commit_sha", is_nullable: "YES" },
      { column_name: "pr_merged_at", is_nullable: "YES" },
      { column_name: "pr_state", is_nullable: "YES" },
      { column_name: "pr_state_checked_at", is_nullable: "YES" },
    ]);
  });

  it("creates the partial pr_state_scan candidate index", async () => {
    const idx = await pool.query(
      `select indexdef from pg_indexes
       where tablename = 'workspaces' and indexname = 'workspaces_pr_state_scan_idx'`,
    );

    expect(idx.rows).toHaveLength(1);
    // Asserting the NAME alone let a non-partial index pass a test that claims
    // "partial". The predicate IS the point: it is what keeps the scan's
    // candidate query off a full scan of every workspace ever created, and it
    // must stay in lockstep with `loadCandidates`' own WHERE.
    const def = (idx.rows[0].indexdef as string).toLowerCase();

    expect(def).toContain("using btree (project_id)");
    expect(def).toContain(
      "where ((pr_url is not null) and ((pr_state is null) or (pr_state = 'open'::text)))",
    );
  });

  it("accepts open/merged/closed and NULL, rejects an illegal pr_state (23514)", async () => {
    const { workspaceId } = await seedRunWorkspace("state");

    for (const state of ["open", "merged", "closed"]) {
      await pool.query(`update workspaces set pr_state = $1 where id = $2`, [
        state,
        workspaceId,
      ]);
    }
    await pool.query(`update workspaces set pr_state = NULL where id = $1`, [
      workspaceId,
    ]);

    await expect(
      pool.query(`update workspaces set pr_state = 'bogus' where id = $1`, [
        workspaceId,
      ]),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("leaves a freshly inserted workspace with NULL PR state (no backfill)", async () => {
    const { workspaceId } = await seedRunWorkspace("nullstate");
    const row = await pool.query(
      `select pr_state, pr_has_conflicts, pr_state_checked_at from workspaces where id = $1`,
      [workspaceId],
    );

    expect(row.rows[0]).toEqual({
      pr_state: null,
      pr_has_conflicts: null,
      pr_state_checked_at: null,
    });
  });
});

describe("0103 run_pr_merged event kind", () => {
  it("both event_kind CHECKs accept run_pr_merged", async () => {
    const { projectId, taskId } = await seedRunWorkspace("evt");
    const activityId = newId();

    await pool.query(
      `insert into task_activity (id, task_id, project_id, actor_type, actor_id, event_kind)
       values ($1, $2, $3, 'system', NULL, 'run_pr_merged')`,
      [activityId, taskId, projectId],
    );
    await pool.query(
      `insert into inbox_items (id, recipient_type, recipient_id, project_id, task_id, event_kind, source_ref)
       values ($1, 'user', 'u1', $2, $3, 'run_pr_merged', '{}')`,
      [newId(), projectId, taskId],
    );

    const stored = await pool.query(
      `select event_kind from task_activity where id = $1`,
      [activityId],
    );

    expect(stored.rows[0].event_kind).toBe("run_pr_merged");
  });

  it("still rejects an unknown event_kind (23514)", async () => {
    const { projectId, taskId } = await seedRunWorkspace("evtbad");

    await expect(
      pool.query(
        `insert into task_activity (id, task_id, project_id, actor_type, actor_id, event_kind)
         values ($1, $2, $3, 'system', NULL, 'pr_exploded')`,
        [newId(), taskId, projectId],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });
});

describe("0103 journal + snapshot", () => {
  it("has a 0103 journal entry with a matching snapshot file", () => {
    const journal = JSON.parse(
      readFileSync(path.join(MIGRATIONS_DIR, "meta", "_journal.json"), "utf8"),
    ) as { entries: Array<{ idx: number; tag: string }> };

    const entry = journal.entries.find((e) => e.tag.startsWith("0103"));

    expect(entry).toBeDefined();
    // Snapshot files use the zero-padded 4-digit tag prefix, not the raw idx.
    const snapshotName = `${entry!.tag.slice(0, 4)}_snapshot.json`;

    expect(existsSync(path.join(MIGRATIONS_DIR, "meta", snapshotName))).toBe(
      true,
    );
  });
});
