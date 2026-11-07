import type { StartedPostgresTestDb } from "@/test-support/pg-container";
import type { PeekHint } from "@/lib/runs/peek-wake";

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { Client } from "pg";

import { startMainPostgresTestDb } from "@/test-support/pg-container";
import { declareWriterCapability } from "@/lib/db/writer-capability";

let database: StartedPostgresTestDb;

vi.mock("@/lib/db/client", async (original) => ({
  ...(await original<typeof import("@/lib/db/client")>()),
  getDb: () => database.db,
  createDbNotificationClient: async () => {
    const { Client } = await import("pg");

    return new Client({
      connectionString: database.databaseUrl,
      application_name: "maister-run-peek",
    });
  },
}));
beforeAll(async () => {
  database = await startMainPostgresTestDb({
    databaseName: "peek_notifications",
    poolMax: 1,
  });
}, 180000);
afterAll(async () => {
  await database?.stop();
});

it("IT-PKD-08 IT-PKD-09: committed cross-connection hints wake shared listeners without occupying the only query connection", async () => {
  const { subscribePeekChanges } = await import("@/lib/runs/peek-wake");
  const hints: PeekHint[] = [];
  const release = await subscribePeekChanges(
    (hint) => hints.push(hint),
    () => {},
  );
  const second: PeekHint[] = [];
  const releaseSecond = await subscribePeekChanges(
    (hint) => second.push(hint),
    () => {},
  );

  try {
    const runId = randomUUID();

    await database.pool.query(
      "INSERT INTO runs(id,run_kind,status,flow_version,flow_revision) VALUES($1,'agent','Running','v1','r')",
      [runId],
    );
    await vi.waitFor(() =>
      expect(hints.some((hint) => hint.runId === runId)).toBe(true),
    );
    expect(second.length).toBe(hints.length);
    const initial = hints.length;

    await database.pool.query("BEGIN");
    await database.pool.query("UPDATE runs SET status='Done' WHERE id=$1", [
      runId,
    ]);
    await database.pool.query("ROLLBACK");
    await database.pool.query("UPDATE runs SET status=status WHERE id=$1", [
      runId,
    ]);
    await database.pool.query(
      "UPDATE runs SET keepalive_until=now() WHERE id=$1",
      [runId],
    );
    // A subsequent committed semantic hint is the barrier, not a timed absence check.
    await database.pool.query("UPDATE runs SET status='Review' WHERE id=$1", [
      runId,
    ]);
    await vi.waitFor(() => expect(hints.length).toBe(initial + 1));
    expect(JSON.stringify(hints)).not.toContain("Review");
    expect(
      (
        await database.pool.query("SELECT status FROM runs WHERE id=$1", [
          runId,
        ])
      ).rows[0].status,
    ).toBe("Review");
    await releaseSecond();
    const before = hints.length;

    await database.pool.query(
      "INSERT INTO run_messages(id,run_id,sequence,role,content) VALUES($1,$2,1,'assistant','secret content')",
      [randomUUID(), runId],
    );
    await vi.waitFor(() => expect(hints.length).toBe(before + 1));
    expect(hints.at(-1)?.topic).toBe("transcript");
    expect(second.length).toBe(initial + 1);
    expect(JSON.stringify(hints)).not.toContain("secret content");
  } finally {
    await releaseSecond();
    await release();
  }
});

it("IT-PKD-09: independent transactions committing in reverse creation order both invalidate without a replay cursor", async () => {
  const { subscribePeekChanges } = await import("@/lib/runs/peek-wake");
  const hints: PeekHint[] = [];
  const release = await subscribePeekChanges(
    (hint) => hints.push(hint),
    () => {},
  );
  const first = new Client({ connectionString: database.databaseUrl });
  const second = new Client({ connectionString: database.databaseUrl });
  const one = randomUUID(),
    two = randomUUID();

  try {
    await first.connect();
    await second.connect();
    await declareWriterCapability(first);
    await declareWriterCapability(second);
    await first.query("BEGIN");
    await second.query("BEGIN");
    await first.query(
      "INSERT INTO runs(id,run_kind,status,flow_version,flow_revision) VALUES($1,'agent','Done','v1','r')",
      [one],
    );
    await second.query(
      "INSERT INTO runs(id,run_kind,status,flow_version,flow_revision) VALUES($1,'agent','Done','v1','r')",
      [two],
    );
    await second.query("COMMIT");
    await vi.waitFor(() =>
      expect(hints.map((hint) => hint.runId)).toEqual([two]),
    );
    await first.query("COMMIT");
    await vi.waitFor(() =>
      expect(hints.map((hint) => hint.runId)).toEqual([two, one]),
    );
  } finally {
    await Promise.all([first.end(), second.end()]);
    await release();
  }
});

it("IT-PKD-08 IT-PKD-09: external writer acceptance, autonomous projection and reconnect survive listener loss", async () => {
  const { subscribePeekChanges } = await import("@/lib/runs/peek-wake");
  const runId = randomUUID();

  await database.pool.query(
    "INSERT INTO runs(id,run_kind,status,flow_version,flow_revision) VALUES($1,'agent','Done','v1','r')",
    [runId],
  );
  const hints: PeekHint[] = [];
  let lost = 0;
  const release = await subscribePeekChanges(
    (hint) => hints.push(hint),
    () => {
      lost++;
    },
  );

  try {
    expect(
      (
        await database.pool.query(
          "SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name='maister-run-peek'",
        )
      ).rows[0].n,
    ).toBe(1);
    await promisify(execFile)(
      process.execPath,
      [
        "-e",
        `const {Client}=require('pg'); (async()=>{const c=new Client({connectionString:process.env.PEEK_TEST_DB_URL});await c.connect();await c.query("UPDATE runs SET status='Review' WHERE id=$1",[process.env.PEEK_TEST_RUN]);await c.end();})().catch(()=>process.exit(1));`,
      ],
      {
        env: {
          ...process.env,
          PEEK_TEST_DB_URL: database.databaseUrl,
          PEEK_TEST_RUN: runId,
        },
      },
    );
    await vi.waitFor(() => expect(hints).toHaveLength(1));
    const event = randomUUID();

    await database.pool.query(
      "INSERT INTO execution_events(id,source,source_key,run_id,event_type,payload_schema,payload,occurred_at,received_at,ingest_disposition) VALUES($1,'manager',$1,$2,'session.update','maister.session.update.v1','{}',now(),now(),'pending_gap')",
      [event, runId],
    );
    await database.pool.query(
      "UPDATE execution_events SET run_sequence=1,ingest_disposition='accepted' WHERE id=$1",
      [event],
    );
    await vi.waitFor(() => expect(hints).toHaveLength(2));
    expect(hints.at(-1)?.topic).toBe("execution");
    const message = randomUUID();

    await database.pool.query(
      "INSERT INTO run_messages(id,run_id,sequence,role,content) VALUES($1,$2,1,'assistant','last projected message')",
      [message, runId],
    );
    await vi.waitFor(() => expect(hints).toHaveLength(3));
    await database.pool.query(
      "UPDATE run_messages SET content='updated projected message' WHERE id=$1",
      [message],
    );
    await vi.waitFor(() => expect(hints).toHaveLength(4));
    await database.pool.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name='maister-run-peek'",
    );
    await vi.waitFor(() => expect(lost).toBe(1));
  } finally {
    await release();
  }
  const recovered: PeekHint[] = [];
  const releaseRecovered = await subscribePeekChanges(
    (hint) => recovered.push(hint),
    () => {},
  );

  try {
    await database.pool.query("UPDATE runs SET status='Done' WHERE id=$1", [
      runId,
    ]);
    await vi.waitFor(() => expect(recovered).toHaveLength(1));
  } finally {
    await releaseRecovered();
  }
  await vi.waitFor(async () =>
    expect(
      (
        await database.pool.query(
          "SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name='maister-run-peek'",
        )
      ).rows[0].n,
    ).toBe(0),
  );
});

it("IT-PKD-11 IT-PKD-09: incomplete migration catalogs refuse acquisition and release the owned connection", async () => {
  const { subscribePeekChanges } = await import("@/lib/runs/peek-wake");

  await database.pool.query(
    "ALTER TABLE run_messages DISABLE TRIGGER run_messages_peek_hint",
  );
  try {
    await expect(
      subscribePeekChanges(
        () => {},
        () => {},
      ),
    ).rejects.toMatchObject({ code: "EXECUTOR_UNAVAILABLE" });
  } finally {
    await database.pool.query(
      "ALTER TABLE run_messages ENABLE TRIGGER run_messages_peek_hint",
    );
  }
  await vi.waitFor(async () =>
    expect(
      (
        await database.pool.query(
          "SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name='maister-run-peek'",
        )
      ).rows[0].n,
    ).toBe(0),
  );
});

it("IT-PKD-08: result validity, Flow facts and shared workspace removal produce content-free semantic hints", async () => {
  const { subscribePeekChanges } = await import("@/lib/runs/peek-wake");
  const project = randomUUID(),
    root = randomUUID(),
    child = randomUUID(),
    workspace = randomUUID(),
    attempt = randomUUID(),
    result = randomUUID();

  await database.pool.query(
    "INSERT INTO projects(id,slug,name,repo_path,maister_yaml_path,task_key) VALUES($1,$1,'Peek',$2,'/tmp/p.yaml',$3)",
    [
      project,
      `/tmp/${project}`,
      `P${project.replaceAll("-", "").slice(0, 7).toUpperCase()}`,
    ],
  );
  await database.pool.query(
    "INSERT INTO runs(id,project_id,run_kind,status,flow_version,flow_revision,root_run_id,parent_run_id) VALUES($1,$3,'flow','Running','v1','r',NULL,NULL),($2,$3,'agent','Running','v1','r',$1,$1)",
    [root, child, project],
  );
  const hints: PeekHint[] = [];
  const release = await subscribePeekChanges(
    (hint) => hints.push(hint),
    () => {},
  );

  try {
    await database.pool.query(
      "INSERT INTO workspaces(id,run_id,project_id,branch,worktree_path,parent_repo_path) VALUES($1,$2,$3,'test',$4,$4)",
      [workspace, root, project, `/private/${workspace}`],
    );
    await vi.waitFor(() => expect(hints).toHaveLength(1));
    expect(hints[0]).toMatchObject({
      source: "workspaces",
      runId: root,
      rootRunId: root,
    });
    await database.pool.query(
      "UPDATE workspaces SET removed_at=now(),removal_kind='retention_gc' WHERE id=$1",
      [workspace],
    );
    await vi.waitFor(() => expect(hints).toHaveLength(2));
    await database.pool.query(
      "INSERT INTO node_attempts(id,run_id,node_id,node_type,status) VALUES($1,$2,'work','ai_coding','Running')",
      [attempt, root],
    );
    await vi.waitFor(() => expect(hints).toHaveLength(3));
    await database.pool.query(
      "UPDATE node_attempts SET status='Failed',error_code='safe_code' WHERE id=$1",
      [attempt],
    );
    await vi.waitFor(() => expect(hints).toHaveLength(4));
    await database.pool.query(
      "INSERT INTO run_results(id,run_id,revision,validity,schema_ref,schema_version,schema_sha256,value,value_bytes,producer_kind,producer_ref,engine_version) VALUES($1,$2,1,'valid','result',1,$3,'{\"private\":\"payload\"}',21,'flow_node','work','3.10.0')",
      [result, child, "a".repeat(64)],
    );
    await vi.waitFor(() => expect(hints).toHaveLength(5));
    await database.pool.query(
      "UPDATE run_results SET validity='stale' WHERE id=$1",
      [result],
    );
    await vi.waitFor(() => expect(hints).toHaveLength(6));
    expect(JSON.stringify(hints)).not.toContain("payload");
    expect(JSON.stringify(hints)).not.toContain("/private/");
  } finally {
    await release();
  }
});
