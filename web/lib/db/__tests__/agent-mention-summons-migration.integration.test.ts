// ADR-151 migration 0121_agent_mention_summons coverage.
//
// Asserts the widened task_activity_event_kind_check accepts
// `agent_summon_suppressed` (and still refuses an unknown kind), that the
// partial unique task_activity_agent_summon_uq makes the suppression note
// idempotent under event redelivery, that it does NOT constrain other kinds,
// and that inbox_items_event_kind_check was deliberately left alone.

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

async function seedTask(label: string): Promise<{
  projectId: string;
  taskId: string;
}> {
  const projectId = newId();
  const flowId = newId();
  const taskId = newId();
  const short = projectId.replace(/-/g, "").slice(0, 8);

  await pool.query(
    `insert into projects (id, slug, name, repo_path, maister_yaml_path, task_key)
     values ($1, $2, $3, $4, '/tmp/m.yaml', $5)`,
    [
      projectId,
      `summon-${label}-${short}`,
      `Summon ${label}`,
      `/tmp/summon-${label}-${short}`,
      `S${short.toUpperCase()}`,
    ],
  );
  await pool.query(
    `insert into flows (id, project_id, flow_ref_id, source, version, installed_path, manifest, schema_version)
     values ($1, $2, 'bugfix', 'github.com/x/y', 'v1.0.0', '/tmp/flows/bugfix', '{"schemaVersion":1,"name":"Bugfix","nodes":[]}', 1)`,
    [flowId, projectId],
  );
  await pool.query(
    `insert into tasks (id, project_id, number, title, prompt, flow_id)
     values ($1, $2, 1, 'Summon task', 'do the thing', $3)`,
    [taskId, projectId, flowId],
  );

  return { projectId, taskId };
}

async function insertSuppression(input: {
  projectId: string;
  taskId: string;
  agentId: string;
  triggerEventId: string;
}): Promise<number> {
  const result = await pool.query(
    `insert into task_activity (id, task_id, project_id, actor_type, actor_id, event_kind, payload)
     values ($1, $2, $3, 'system', null, 'agent_summon_suppressed', $4)
     on conflict do nothing
     returning id`,
    [
      newId(),
      input.taskId,
      input.projectId,
      JSON.stringify({
        agentId: input.agentId,
        triggerEventId: input.triggerEventId,
      }),
    ],
  );

  return result.rowCount ?? 0;
}

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "agent_mention_summons_test",
  });
  pool = testDatabase.pool;
}, 180_000);

afterAll(async () => {
  await testDatabase?.stop();
});

describe("0121 task_activity_event_kind_check", () => {
  it("accepts agent_summon_suppressed", async () => {
    const { projectId, taskId } = await seedTask("kind");

    const inserted = await insertSuppression({
      projectId,
      taskId,
      agentId: "core:triager",
      triggerEventId: "42",
    });

    expect(inserted).toBe(1);
  });

  it("still refuses an unknown event kind", async () => {
    const { projectId, taskId } = await seedTask("badkind");

    await expect(
      pool.query(
        `insert into task_activity (id, task_id, project_id, actor_type, actor_id, event_kind, payload)
         values ($1, $2, $3, 'system', null, 'agent_summon_launched', '{}')`,
        [newId(), taskId, projectId],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });
});

describe("0121 task_activity_agent_summon_uq", () => {
  // At-least-once event delivery is the point: a redelivered
  // task.comment_added must not double the suppression note, and the backstop
  // must be the index rather than a read-then-write check.
  it("collapses a redelivered suppression to exactly one row", async () => {
    const { projectId, taskId } = await seedTask("redeliver");
    const args = {
      projectId,
      taskId,
      agentId: "core:triager",
      triggerEventId: "77",
    };

    expect(await insertSuppression(args)).toBe(1);
    expect(await insertSuppression(args)).toBe(0);

    const rows = await pool.query(
      `select count(*)::int as n from task_activity
       where task_id = $1 and event_kind = 'agent_summon_suppressed'`,
      [taskId],
    );

    expect(rows.rows[0].n).toBe(1);
  });

  it("keys on agent AND event — a different agent or event still records", async () => {
    const { projectId, taskId } = await seedTask("keys");

    expect(
      await insertSuppression({
        projectId,
        taskId,
        agentId: "core:triager",
        triggerEventId: "1",
      }),
    ).toBe(1);
    expect(
      await insertSuppression({
        projectId,
        taskId,
        agentId: "core:reviewer",
        triggerEventId: "1",
      }),
    ).toBe(1);
    expect(
      await insertSuppression({
        projectId,
        taskId,
        agentId: "core:triager",
        triggerEventId: "2",
      }),
    ).toBe(1);

    const rows = await pool.query(
      `select count(*)::int as n from task_activity
       where task_id = $1 and event_kind = 'agent_summon_suppressed'`,
      [taskId],
    );

    expect(rows.rows[0].n).toBe(3);
  });

  // The index is PARTIAL: an unrelated kind whose payload happens to carry the
  // same keys must stay unconstrained, or ordinary activity writes start
  // silently disappearing.
  it("leaves other event kinds unconstrained", async () => {
    const { projectId, taskId } = await seedTask("partial");
    const payload = JSON.stringify({
      agentId: "core:triager",
      triggerEventId: "9",
    });

    for (let i = 0; i < 2; i += 1) {
      await pool.query(
        `insert into task_activity (id, task_id, project_id, actor_type, actor_id, event_kind, payload)
         values ($1, $2, $3, 'system', null, 'triage_set', $4)`,
        [newId(), taskId, projectId, payload],
      );
    }

    const rows = await pool.query(
      `select count(*)::int as n from task_activity
       where task_id = $1 and event_kind = 'triage_set'`,
      [taskId],
    );

    expect(rows.rows[0].n).toBe(2);
  });
});

describe("0121 inbox_items_event_kind_check", () => {
  // Deliberately NOT widened (ADR-151): the kind never fans out. Pinning this
  // keeps a future "helpful" widening from passing unnoticed.
  it("does not accept agent_summon_suppressed", async () => {
    const { projectId, taskId } = await seedTask("inbox");

    await expect(
      pool.query(
        `insert into inbox_items (id, recipient_type, recipient_id, project_id, task_id, event_kind, source_ref)
         values ($1, 'user', $2, $3, $4, 'agent_summon_suppressed', '{}')`,
        [newId(), newId(), projectId, taskId],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });
});

// Identified by NAME, never by number — a rebase renegotiates the number.
const MIGRATION_NAME = "_agent_mention_summons";

type JournalEntry = { idx: number; tag: string; when: number };

function readJournal(): { entries: JournalEntry[] } {
  return JSON.parse(
    readFileSync(path.join(MIGRATIONS_DIR, "meta", "_journal.json"), "utf8"),
  ) as { entries: JournalEntry[] };
}

function readSnapshot(tag: string): { id: string; prevId: string } {
  return JSON.parse(
    readFileSync(
      path.join(MIGRATIONS_DIR, "meta", `${tag.slice(0, 4)}_snapshot.json`),
      "utf8",
    ),
  ) as { id: string; prevId: string };
}

describe("0121 migration triple", () => {
  it("ships SQL + journal entry + snapshot", () => {
    const entry = readJournal().entries.find((e) =>
      e.tag.endsWith(MIGRATION_NAME),
    );

    expect(entry).toBeDefined();
    expect(existsSync(path.join(MIGRATIONS_DIR, `${entry!.tag}.sql`))).toBe(
      true,
    );
    expect(
      existsSync(
        path.join(MIGRATIONS_DIR, "meta", `${entry!.tag.slice(0, 4)}_snapshot.json`),
      ),
    ).toBe(true);
  });

  it("numbers the tag to match its journal idx", () => {
    const entry = readJournal().entries.find((e) =>
      e.tag.endsWith(MIGRATION_NAME),
    )!;

    expect(entry.tag.slice(0, 4)).toBe(String(entry.idx).padStart(4, "0"));
  });

  // A non-monotonic `when` makes the high-water-marking migrator SILENTLY SKIP
  // this migration on any DB already past the watermark.
  it("keeps its journal `when` above every preceding entry", () => {
    const entries = readJournal().entries;
    const index = entries.findIndex((e) => e.tag.endsWith(MIGRATION_NAME));

    expect(index).toBeGreaterThan(0);
    expect(entries[index].when).toBeGreaterThan(entries[index - 1].when);
  });

  it("chains its snapshot prevId to the preceding migration's snapshot id", () => {
    const entries = readJournal().entries;
    const index = entries.findIndex((e) => e.tag.endsWith(MIGRATION_NAME));

    expect(index).toBeGreaterThan(0);

    const snapshot = readSnapshot(entries[index].tag);
    const predecessor = readSnapshot(entries[index - 1].tag);

    expect(snapshot.prevId).toBe(predecessor.id);
  });

  // ADR-151: agent_schedules needs NO migration — trigger_type is plain text
  // with no value CHECK and both shape CHECKs are `<>`-guarded. Recorded as a
  // test so a reviewer does not "helpfully" add one.
  it("adds no agent_schedules migration — a mention row inserts as-is", async () => {
    const { projectId } = await seedTask("sched");
    const agentId = `pkg-${newId().slice(0, 8)}:triager`;

    await pool.query(
      `insert into agents (id, package_name, version_label, origin, name, description, workspace, mode, triggers, risk_tier, source_path)
       values ($1, 'pkg', 'v1.0.0', 'git', 'Triager', 'triages', 'none', 'session', '["domain_event"]'::jsonb, 'read_only', '/tmp/a.md')`,
      [agentId],
    );
    await pool.query(
      `insert into agent_schedules (id, agent_id, project_id, trigger_type)
       values ($1, $2, $3, 'mention')`,
      [newId(), agentId, projectId],
    );

    const rows = await pool.query(
      `select trigger_type, cron_expr, timezone, next_fire_at, event_match
       from agent_schedules where project_id = $1`,
      [projectId],
    );

    expect(rows.rows[0]).toEqual({
      trigger_type: "mention",
      cron_expr: null,
      timezone: null,
      next_fire_at: null,
      event_match: null,
    });
  });
});
