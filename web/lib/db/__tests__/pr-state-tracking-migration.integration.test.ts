// ADR-139 migration 0103_pr_state_tracking coverage (Task 3).
//
// The shared harness applies every migration ALL-AT-ONCE in beforeAll, so a
// fresh DB carries 0103 and NO row here predates it. That bounds what this file
// can honestly claim: "no backfill" is proven from the column SHAPE (nullable +
// no default ⇒ any pre-existing row necessarily reads NULL after ADD COLUMN),
// never from inserting a row and finding NULL. We assert: the five workspaces PR
// columns exist nullable with no default, the workspaces_pr_state CHECK accepts
// open/merged/closed/NULL and rejects an illegal value, BOTH event_kind CHECKs
// (task_activity + inbox_items) accept the new run_pr_merged kind, a new row
// starts NULL, the scan index is genuinely PARTIAL (predicate asserted, not just
// its name), and the newest journal entry (0103) has a matching snapshot file.

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
  // `column_default` is asserted, not just nullability, because it is what makes
  // "no backfill" PROVABLE from a fresh DB. The harness applies every migration
  // at once, so no row here predates 0103 — a test that inserts a row and finds
  // NULL only shows the column is nullable. Nullable + no default means a
  // pre-existing row necessarily reads NULL after `ADD COLUMN`, which is the
  // real invariant: `pr_state` is owned exclusively by `pr_state_scan`, so a
  // DEFAULT (or a backfill UPDATE) added later would silently manufacture PR
  // state for every workspace that never had a PR.
  it("adds the four workspaces PR columns, all nullable with NO default (no backfill)", async () => {
    const cols = await pool.query(
      `select column_name, is_nullable, column_default from information_schema.columns
       where table_name = 'workspaces'
       and column_name in ('pr_state','pr_has_conflicts','pr_merged_at','pr_merge_commit_sha')
       order by column_name`,
    );

    expect(cols.rows).toEqual([
      {
        column_name: "pr_has_conflicts",
        is_nullable: "YES",
        column_default: null,
      },
      {
        column_name: "pr_merge_commit_sha",
        is_nullable: "YES",
        column_default: null,
      },
      { column_name: "pr_merged_at", is_nullable: "YES", column_default: null },
      { column_name: "pr_state", is_nullable: "YES", column_default: null },
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

  // Companion to the column_default assertion above: that one proves the SHAPE
  // cannot manufacture PR state, this one proves the INSERT path does not either
  // (no trigger, no ORM default). It deliberately does NOT claim to prove "no
  // backfill" — this row is created after every migration has run, so a backfill
  // UPDATE could never have touched it.
  it("leaves a freshly inserted workspace with NULL PR state", async () => {
    const { workspaceId } = await seedRunWorkspace("nullstate");
    const row = await pool.query(
      `select pr_state, pr_has_conflicts from workspaces where id = $1`,
      [workspaceId],
    );

    expect(row.rows[0]).toEqual({
      pr_state: null,
      pr_has_conflicts: null,
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

// Identified by NAME, never by number: matching on a `0103` prefix would, once
// this branch rebases onto a main that already owns 0103, silently resolve to
// MAIN's migration — the snapshot exists, every assertion passes, and this
// migration goes unverified. The name is what belongs to this change; the
// number is the thing the merge renegotiates.
const MIGRATION_NAME = "_pr_state_tracking";

type JournalEntry = { idx: number; tag: string; when: number };

function readJournal(): { entries: JournalEntry[] } {
  return JSON.parse(
    readFileSync(path.join(MIGRATIONS_DIR, "meta", "_journal.json"), "utf8"),
  ) as { entries: JournalEntry[] };
}

function readSnapshot(tag: string): { id: string; prevId: string } {
  // Snapshot files use the zero-padded 4-digit tag prefix, not the raw idx.
  return JSON.parse(
    readFileSync(
      path.join(MIGRATIONS_DIR, "meta", `${tag.slice(0, 4)}_snapshot.json`),
      "utf8",
    ),
  ) as { id: string; prevId: string };
}

describe("pr_state_tracking journal + snapshot", () => {
  it("has a journal entry with a matching snapshot file", () => {
    const entry = readJournal().entries.find((e) =>
      e.tag.endsWith(MIGRATION_NAME),
    );

    expect(entry).toBeDefined();
    const snapshotName = `${entry!.tag.slice(0, 4)}_snapshot.json`;

    expect(existsSync(path.join(MIGRATIONS_DIR, "meta", snapshotName))).toBe(
      true,
    );
  });

  it("numbers the tag to match its journal idx", () => {
    const entry = readJournal().entries.find((e) =>
      e.tag.endsWith(MIGRATION_NAME),
    )!;

    expect(entry.tag.slice(0, 4)).toBe(String(entry.idx).padStart(4, "0"));
  });

  // The guard that makes a renumber safe. A migration is a TRIPLE (SQL +
  // journal entry + snapshot), and its snapshot's `prevId` must name the TRUE
  // predecessor's snapshot `id`. Renaming snapshot files to renumber (rather
  // than regenerating them) leaves `prevId` rooted at the OLD predecessor —
  // encoding a schema lineage that never existed — and nothing else notices.
  it("chains its snapshot prevId to the preceding migration's snapshot id", () => {
    const entries = readJournal().entries;
    const index = entries.findIndex((e) => e.tag.endsWith(MIGRATION_NAME));

    expect(index).toBeGreaterThan(0);

    const snapshot = readSnapshot(entries[index].tag);
    const predecessor = readSnapshot(entries[index - 1].tag);

    expect(snapshot.prevId).toBe(predecessor.id);
  });
});
