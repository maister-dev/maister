import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { getGraphOnlyCutoverFailure } from "@/lib/queries/run-cutover";
import {
  startBarePostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

const ACTIONABLE = [
  "Pending",
  "Running",
  "NeedsInput",
  "NeedsInputIdle",
  "HumanWorking",
  "WaitingOnChildren",
  "Review",
  "Crashed",
] as const;

let testDatabase: StartedPostgresTestDb;
let adminPool: Pool;
let migrationRoot: string;
let migration0094: string;
let migration0095: string;
let migration0096: string;

beforeAll(async () => {
  testDatabase = await startBarePostgresTestDb({
    databaseName: "maister_cutover_admin",
  });
  adminPool = testDatabase.pool;
  migrationRoot = await buildPreCutoverMigrationRoot();
  migration0094 = await readFile(
    resolve(__dirname, "../migrations/0094_postgres_graph_only_cutover.sql"),
    "utf8",
  );
  migration0095 = await readFile(
    resolve(__dirname, "../migrations/0095_close_m43_cutover_task_claims.sql"),
    "utf8",
  );
  migration0096 = await readFile(
    resolve(__dirname, "../migrations/0096_index_m43_cutover_events.sql"),
    "utf8",
  );
}, 180_000);

afterAll(async () => {
  if (migrationRoot) {
    await rm(migrationRoot, { recursive: true, force: true });
  }
  await testDatabase?.stop();
});

async function buildPreCutoverMigrationRoot(): Promise<string> {
  const source = resolve(__dirname, "../migrations");
  const target = await mkdtemp(join(tmpdir(), "maister-migrations-0093-"));

  await mkdir(join(target, "meta"), { recursive: true });

  for (const name of await readdir(source)) {
    if (
      !/^\d{4}_.+\.sql$/.test(name) ||
      name.startsWith("0094_") ||
      name.startsWith("0095_") ||
      name.startsWith("0096_")
    ) {
      continue;
    }
    await writeFile(
      join(target, name),
      await readFile(join(source, name), "utf8"),
    );
  }

  const journal = JSON.parse(
    await readFile(join(source, "meta", "_journal.json"), "utf8"),
  ) as { entries: Array<{ idx: number }> };

  await writeFile(
    join(target, "meta", "_journal.json"),
    JSON.stringify(
      {
        ...journal,
        entries: journal.entries.filter((entry) => entry.idx <= 93),
      },
      null,
      2,
    ),
  );

  return target;
}

async function preparedDatabase(label: string): Promise<Pool> {
  const database = `m93_${label}_${randomUUID().slice(0, 8)}`;

  await adminPool.query(`CREATE DATABASE "${database}"`);

  const url = new URL(testDatabase.databaseUrl);

  url.pathname = `/${database}`;

  const pool = new Pool({ connectionString: url.toString() });

  await migrate(drizzle(pool), { migrationsFolder: migrationRoot });

  return pool;
}

async function applyCutover(pool: Pool): Promise<void> {
  await applyMigrationSql(pool, migration0094);
}

async function applyM43TaskClaimClosure(pool: Pool): Promise<void> {
  await applyMigrationSql(pool, migration0095);
}

async function applyM43EventIndexes(pool: Pool): Promise<void> {
  await applyMigrationSql(pool, migration0096);
}

async function applyMigrationSql(pool: Pool, migration: string): Promise<void> {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    await client.query(migration);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function seedProject(
  client: PoolClient,
  projectId: string,
): Promise<void> {
  await client.query(
    `INSERT INTO projects (id, slug, name, repo_path, task_key)
     VALUES ($1, $2, 'Cut-over', $3, $4)`,
    [projectId, `cutover-${projectId}`, `/tmp/${projectId}`, `C${projectId}`],
  );
}

async function seedFlow(args: {
  client: PoolClient;
  projectId: string;
  flowId: string;
  revisionId: string;
  legacy?: boolean;
  revisionLegacy?: boolean;
  cacheLegacy?: boolean;
}): Promise<void> {
  const manifestFor = (legacy: boolean) =>
    legacy
      ? { schemaVersion: 1, name: args.flowId, steps: [] }
      : {
          schemaVersion: 1,
          name: args.flowId,
          nodes: [
            {
              id: "run",
              type: "cli",
              action: { command: "true" },
              transitions: { success: "done" },
            },
          ],
        };
  const revisionManifest = manifestFor(
    args.revisionLegacy ?? args.legacy ?? false,
  );
  const cacheManifest = manifestFor(args.cacheLegacy ?? args.legacy ?? false);

  await args.client.query(
    `INSERT INTO flow_revisions
       (id, flow_ref_id, source, version_label, resolved_revision,
        manifest_digest, manifest, schema_version, installed_path,
        package_status, setup_status)
     VALUES ($1, $2, 'test', 'v1', $3, $4, $5::jsonb, 1, $6,
             'Installed', 'not_required')`,
    [
      args.revisionId,
      args.flowId,
      `sha-${args.flowId}`,
      `digest-${args.flowId}`,
      JSON.stringify(revisionManifest),
      `/tmp/${args.flowId}`,
    ],
  );
  await args.client.query(
    `INSERT INTO flows
       (id, project_id, flow_ref_id, source, version, revision,
        installed_path, manifest, schema_version, enabled_revision_id)
     VALUES ($1, $2, $3, 'test', 'v1', $4, $5, $6::jsonb, 1, $7)`,
    [
      args.flowId,
      args.projectId,
      args.flowId,
      `sha-${args.flowId}`,
      `/tmp/${args.flowId}`,
      JSON.stringify(cacheManifest),
      args.revisionId,
    ],
  );
}

async function seedRun(args: {
  client: PoolClient;
  runId: string;
  taskId?: string | null;
  projectId: string;
  flowId: string | null;
  revisionId: string | null;
  status: string;
  runKind?: "flow" | "scratch" | "agent";
  endedAt?: string | null;
}): Promise<void> {
  await args.client.query(
    `INSERT INTO runs
       (id, run_kind, task_id, project_id, flow_id, flow_revision_id, status,
        flow_version, flow_revision, ended_at, current_step_id,
        resume_started_at, resume_requested_at, resume_target_step_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'v1', 'sha', $8, 'legacy-node',
             now(), now(), 'legacy-node')`,
    [
      args.runId,
      args.runKind ?? "flow",
      args.taskId ?? null,
      args.projectId,
      args.flowId,
      args.revisionId,
      args.status,
      args.endedAt ?? null,
    ],
  );
}

async function seedTask(args: {
  client: PoolClient;
  taskId: string;
  projectId: string;
  flowId: string;
  number: number;
  queueClaimedAt: string | null;
}): Promise<void> {
  await args.client.query(
    `INSERT INTO tasks
       (id, project_id, number, title, prompt, flow_id, status, stage,
        triage_status, launch_mode, queue_claimed_at)
     VALUES ($1, $2, $3, 'D2 task', 'Close stale C2 claim', $4, 'InFlight',
             'Backlog', 'triaged', 'auto', $5)`,
    [
      args.taskId,
      args.projectId,
      args.number,
      args.flowId,
      args.queueClaimedAt,
    ],
  );
}

describe("migrations 0094/0095/0096 — D2 before irreversible D1", () => {
  it("terminalizes exactly the eight legacy actionable statuses and preserves history", async () => {
    const pool = await preparedDatabase("matrix");
    const client = await pool.connect();
    const projectId = "p-matrix";
    const legacyFlowId = "legacy-flow";
    const legacyRevisionId = "legacy-revision";
    const graphFlowId = "graph-flow";
    const graphRevisionId = "graph-revision";
    const pinnedGraphId = "pinned-graph-cache-legacy";
    const pinnedLegacyId = "pinned-legacy-cache-graph";
    const terminalAt = "2026-01-02T03:04:05.000Z";

    try {
      await seedProject(client, projectId);
      await seedFlow({
        client,
        projectId,
        flowId: legacyFlowId,
        revisionId: legacyRevisionId,
        legacy: true,
      });
      await seedFlow({
        client,
        projectId,
        flowId: graphFlowId,
        revisionId: graphRevisionId,
        legacy: false,
      });
      await seedFlow({
        client,
        projectId,
        flowId: pinnedGraphId,
        revisionId: `${pinnedGraphId}-revision`,
        revisionLegacy: false,
        cacheLegacy: true,
      });
      await seedFlow({
        client,
        projectId,
        flowId: pinnedLegacyId,
        revisionId: `${pinnedLegacyId}-revision`,
        revisionLegacy: true,
        cacheLegacy: false,
      });

      for (const [index, status] of ACTIONABLE.entries()) {
        await seedRun({
          client,
          runId: `legacy-${status}`,
          projectId,
          flowId: legacyFlowId,
          revisionId: index === 0 ? null : legacyRevisionId,
          status,
        });
      }

      for (const status of ["Done", "Failed", "Abandoned"]) {
        await seedRun({
          client,
          runId: `terminal-${status}`,
          projectId,
          flowId: legacyFlowId,
          revisionId: legacyRevisionId,
          status,
          endedAt: terminalAt,
        });
      }
      await seedRun({
        client,
        runId: "graph-running",
        projectId,
        flowId: graphFlowId,
        revisionId: graphRevisionId,
        status: "Running",
      });
      await seedRun({
        client,
        runId: "pinned-graph-running",
        projectId,
        flowId: pinnedGraphId,
        revisionId: `${pinnedGraphId}-revision`,
        status: "Running",
      });
      await seedRun({
        client,
        runId: "pinned-legacy-running",
        projectId,
        flowId: pinnedLegacyId,
        revisionId: `${pinnedLegacyId}-revision`,
        status: "Running",
      });
      await seedRun({
        client,
        runId: "scratch-legacy-reference",
        projectId,
        flowId: legacyFlowId,
        revisionId: legacyRevisionId,
        status: "Running",
        runKind: "scratch",
      });
      await seedRun({
        client,
        runId: "agent-legacy-reference",
        projectId,
        flowId: legacyFlowId,
        revisionId: legacyRevisionId,
        status: "Running",
        runKind: "agent",
      });

      await client.query(
        `INSERT INTO step_runs (id, run_id, step_id, step_type)
         VALUES ('step-old', 'terminal-Done', 'old', 'cli')`,
      );
      await client.query(
        `INSERT INTO run_sessions
           (id, run_id, session_name, acp_session_id)
         VALUES ('session-old', 'legacy-Running', 'default', 'acp-live')`,
      );
      await client.query(
        `INSERT INTO node_attempts
           (id, run_id, node_id, node_type, status, acp_session_id)
         VALUES ('attempt-old', 'legacy-Running', 'old', 'cli', 'Running', 'acp-live')`,
      );
      await client.query(
        `INSERT INTO hitl_requests
           (id, run_id, step_id, kind, prompt)
         VALUES ('hitl-old', 'legacy-NeedsInput', 'old', 'human', 'Review?')`,
      );
      await client.query(
        `INSERT INTO assignments
           (id, project_id, run_id, action_kind, status, title)
         VALUES ('assignment-old', $1, 'legacy-HumanWorking',
                 'human_review', 'claimed', 'Review')`,
        [projectId],
      );
      await client.query(
        `INSERT INTO workspaces
           (id, run_id, project_id, branch, worktree_path, parent_repo_path)
         VALUES ('workspace-old', 'legacy-Running', $1, 'maister/old',
                 '/tmp/m93-worktree', '/tmp/m93-repo')`,
        [projectId],
      );
    } finally {
      client.release();
    }

    await applyCutover(pool);

    const actionable = await pool.query(
      `SELECT id, status, ended_at, current_step_id, resume_started_at,
              resume_requested_at, resume_target_step_id
       FROM runs WHERE id LIKE 'legacy-%' ORDER BY id`,
    );

    expect(actionable.rows).toHaveLength(8);
    expect(actionable.rows).toEqual(
      expect.arrayContaining(
        ACTIONABLE.map((status) =>
          expect.objectContaining({
            id: `legacy-${status}`,
            status: "Failed",
            ended_at: expect.any(Date),
            current_step_id: null,
            resume_started_at: null,
            resume_requested_at: null,
            resume_target_step_id: null,
          }),
        ),
      ),
    );

    const terminal = await pool.query(
      `SELECT id, status, ended_at FROM runs
       WHERE id LIKE 'terminal-%' ORDER BY id`,
    );

    expect(terminal.rows.map((row) => row.status).sort()).toEqual([
      "Abandoned",
      "Done",
      "Failed",
    ]);
    expect(
      terminal.rows.every((row) => row.ended_at.toISOString() === terminalAt),
    ).toBe(true);

    expect(
      (await pool.query(`SELECT status FROM runs WHERE id = 'graph-running'`))
        .rows[0]?.status,
    ).toBe("Running");
    expect(
      (
        await pool.query(
          `SELECT id, status FROM runs
           WHERE id IN ('pinned-graph-running', 'pinned-legacy-running',
                        'scratch-legacy-reference', 'agent-legacy-reference')
           ORDER BY id`,
        )
      ).rows,
    ).toEqual([
      { id: "agent-legacy-reference", status: "Running" },
      { id: "pinned-graph-running", status: "Running" },
      { id: "pinned-legacy-running", status: "Failed" },
      { id: "scratch-legacy-reference", status: "Running" },
    ]);
    expect(
      (await pool.query(`SELECT count(*)::int AS n FROM domain_events`)).rows[0]
        ?.n,
    ).toBe(9);
    await expect(
      getGraphOnlyCutoverFailure(drizzle(pool), "legacy-Pending"),
    ).resolves.toEqual({
      occurredAt: expect.any(Date),
      reason: "legacy_steps_engine_3_cutover",
    });
    await expect(
      getGraphOnlyCutoverFailure(drizzle(pool), "graph-running"),
    ).resolves.toBeNull();
    expect(
      (
        await pool.query(
          `SELECT payload FROM domain_events
           WHERE run_id = 'legacy-Pending'`,
        )
      ).rows[0]?.payload,
    ).toMatchObject({
      reason: "legacy_steps_engine_3_cutover",
      source: "upgrade_cutover",
      priorStatus: "Pending",
    });
    expect(
      (await pool.query(`SELECT count(*)::int AS n FROM webhook_events`))
        .rows[0]?.n,
    ).toBe(9);
    expect(
      (
        await pool.query(
          `SELECT data FROM webhook_events
           WHERE run_id = 'legacy-Pending'`,
        )
      ).rows[0]?.data,
    ).toEqual({ errorCode: "CONFIG" });
    expect(
      (
        await pool.query(
          `SELECT status, error_code, acp_session_id, ended_at
           FROM node_attempts WHERE id = 'attempt-old'`,
        )
      ).rows[0],
    ).toMatchObject({
      status: "Failed",
      error_code: "CONFIG",
      acp_session_id: null,
      ended_at: expect.any(Date),
    });
    expect(
      (
        await pool.query(
          `SELECT response, responded_at FROM hitl_requests WHERE id = 'hitl-old'`,
        )
      ).rows[0],
    ).toMatchObject({
      response: {
        cancelled: true,
        reason: "legacy_steps_engine_3_cutover",
        source: "upgrade_cutover",
      },
      responded_at: expect.any(Date),
    });
    expect(
      (
        await pool.query(
          `SELECT status FROM assignments WHERE id = 'assignment-old'`,
        )
      ).rows[0]?.status,
    ).toBe("cancelled");
    expect(
      (
        await pool.query(
          `SELECT event_kind, from_status, to_status, payload
           FROM assignment_events WHERE assignment_id = 'assignment-old'`,
        )
      ).rows[0],
    ).toMatchObject({
      event_kind: "system_closed",
      from_status: "claimed",
      to_status: "cancelled",
      payload: {
        reason: "legacy_steps_engine_3_cutover",
        source: "upgrade_cutover",
      },
    });
    expect(
      (
        await pool.query(
          `SELECT acp_session_id FROM run_sessions WHERE id = 'session-old'`,
        )
      ).rows[0]?.acp_session_id,
    ).toBeNull();
    expect(
      (await pool.query(`SELECT count(*)::int AS n FROM workspaces`)).rows[0]
        ?.n,
    ).toBe(1);
    expect(
      (await pool.query(`SELECT to_regclass('public.step_runs') AS table_name`))
        .rows[0]?.table_name,
    ).toBeNull();

    const postD2Client = await pool.connect();

    try {
      await expect(
        seedRun({
          client: postD2Client,
          runId: "post-d2-legacy-run",
          projectId,
          flowId: legacyFlowId,
          revisionId: legacyRevisionId,
          status: "Pending",
        }),
      ).rejects.toMatchObject({ code: "23514" });
      await seedRun({
        client: postD2Client,
        runId: "post-d2-unpinned-graph-run",
        projectId,
        flowId: graphFlowId,
        revisionId: null,
        status: "Running",
      });
    } finally {
      postD2Client.release();
    }
    expect(
      (
        await pool.query(
          `SELECT status FROM runs WHERE id = 'post-d2-unpinned-graph-run'`,
        )
      ).rows[0]?.status,
    ).toBe("Running");

    await applyCutover(pool);
    expect(
      (await pool.query(`SELECT count(*)::int AS n FROM domain_events`)).rows[0]
        ?.n,
    ).toBe(9);
    expect(
      (await pool.query(`SELECT count(*)::int AS n FROM webhook_events`))
        .rows[0]?.n,
    ).toBe(9);
    expect(
      (await pool.query(`SELECT count(*)::int AS n FROM assignment_events`))
        .rows[0]?.n,
    ).toBe(1);

    await applyM43EventIndexes(pool);
    await applyM43EventIndexes(pool);
    const indexDefinitions = await pool.query<{
      indexname: string;
      indexdef: string;
    }>(
      `SELECT indexname, indexdef
       FROM pg_indexes
       WHERE schemaname = 'public'
         AND indexname IN (
           'domain_events_m43_cutover_run_occurred_idx',
           'domain_events_m43_cutover_task_occurred_idx'
         )
       ORDER BY indexname`,
    );

    expect(indexDefinitions.rows).toHaveLength(2);
    expect(indexDefinitions.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          indexname: "domain_events_m43_cutover_run_occurred_idx",
          indexdef: expect.stringContaining("occurred_at"),
        }),
        expect.objectContaining({
          indexname: "domain_events_m43_cutover_task_occurred_idx",
          indexdef: expect.stringContaining("task_id"),
        }),
      ]),
    );

    await pool.end();
  }, 180_000);

  it("clears only C2 claims that predate the D2 transition", async () => {
    const pool = await preparedDatabase("task-claims");
    const client = await pool.connect();
    const projectId = "p-task-claims";
    const flowId = "legacy-task-claims-flow";
    const revisionId = "legacy-task-claims-revision";
    const staleTaskId = "task-stale-claim";
    const laterTaskId = "task-later-claim";
    const staleClaimAt = "2020-01-01T00:00:00.000Z";
    const laterClaimAt = "2099-01-01T00:00:00.000Z";

    try {
      await seedProject(client, projectId);
      await seedFlow({
        client,
        projectId,
        flowId,
        revisionId,
        legacy: true,
      });
      await seedTask({
        client,
        taskId: staleTaskId,
        projectId,
        flowId,
        number: 1,
        queueClaimedAt: staleClaimAt,
      });
      await seedTask({
        client,
        taskId: laterTaskId,
        projectId,
        flowId,
        number: 2,
        queueClaimedAt: null,
      });
      await seedRun({
        client,
        runId: "legacy-stale-claim",
        taskId: staleTaskId,
        projectId,
        flowId,
        revisionId,
        status: "Pending",
      });
      await seedRun({
        client,
        runId: "legacy-later-claim",
        taskId: laterTaskId,
        projectId,
        flowId,
        revisionId,
        status: "Running",
      });
    } finally {
      client.release();
    }

    await applyCutover(pool);

    const claimsAfterD2 = await pool.query<{
      id: string;
      queue_claimed_at: Date | null;
    }>(
      `SELECT id, queue_claimed_at
       FROM tasks
       WHERE id IN ($1, $2)
       ORDER BY id`,
      [laterTaskId, staleTaskId],
    );

    expect(claimsAfterD2.rows).toEqual([
      { id: laterTaskId, queue_claimed_at: null },
      { id: staleTaskId, queue_claimed_at: new Date(staleClaimAt) },
    ]);

    // A newer C2 claim can exist when 0094 was applied before the follow-up
    // migration. It is not stale and must survive 0095.
    await pool.query(`UPDATE tasks SET queue_claimed_at = $2 WHERE id = $1`, [
      laterTaskId,
      laterClaimAt,
    ]);

    await applyM43TaskClaimClosure(pool);

    const claimsAfter0095 = await pool.query<{
      id: string;
      queue_claimed_at: Date | null;
    }>(
      `SELECT id, queue_claimed_at
       FROM tasks
       WHERE id IN ($1, $2)
       ORDER BY id`,
      [laterTaskId, staleTaskId],
    );

    expect(claimsAfter0095.rows).toEqual([
      { id: laterTaskId, queue_claimed_at: new Date(laterClaimAt) },
      { id: staleTaskId, queue_claimed_at: null },
    ]);

    await applyM43TaskClaimClosure(pool);
    expect(
      (
        await pool.query<{
          queue_claimed_at: Date | null;
        }>(`SELECT queue_claimed_at FROM tasks WHERE id = $1`, [laterTaskId])
      ).rows[0]?.queue_claimed_at,
    ).toEqual(new Date(laterClaimAt));

    await pool.end();
  }, 180_000);

  it("moves a settled D2-affected multi-variant experiment to comparable", async () => {
    const pool = await preparedDatabase("experiment-status");
    const client = await pool.connect();
    const projectId = "p-experiment-status";
    const flowId = "legacy-experiment-flow";
    const revisionId = "legacy-experiment-revision";

    try {
      await seedProject(client, projectId);
      await seedFlow({
        client,
        projectId,
        flowId,
        revisionId,
        legacy: true,
      });
      await seedTask({
        client,
        taskId: "experiment-task",
        projectId,
        flowId,
        number: 1,
        queueClaimedAt: null,
      });
      await seedRun({
        client,
        runId: "experiment-run-a",
        taskId: "experiment-task",
        projectId,
        flowId,
        revisionId,
        status: "Running",
      });
      await seedRun({
        client,
        runId: "experiment-run-b",
        taskId: "experiment-task",
        projectId,
        flowId,
        revisionId,
        status: "NeedsInput",
      });
      await client.query(
        `INSERT INTO experiments (
           id, project_id, task_id, title, status, base_branch, base_commit,
           variants, rubric
         ) VALUES (
           'experiment-cutover', $1, 'experiment-task', 'Cut-over comparison',
           'running', 'main', 'abc123',
           '[{"key":"a","title":"A","prompt":"A","config":{}},
             {"key":"b","title":"B","prompt":"B","config":{}}]'::jsonb,
           '{"criteria":[{"id":"correctness","label":"Correctness","weight":1}]}'::jsonb
         )`,
        [projectId],
      );
      await client.query(
        `INSERT INTO experiment_runs (
           id, experiment_id, run_id, variant_key, replicate_ordinal,
           launch_reason, base_commit
         ) VALUES
           ('experiment-member-a', 'experiment-cutover', 'experiment-run-a', 'a', 1,
            'initial', 'abc123'),
           ('experiment-member-b', 'experiment-cutover', 'experiment-run-b', 'b', 1,
            'initial', 'abc123')`,
      );
    } finally {
      client.release();
    }

    await applyCutover(pool);

    expect(
      (
        await pool.query(
          `SELECT status, comparable_at FROM experiments WHERE id = 'experiment-cutover'`,
        )
      ).rows[0],
    ).toMatchObject({ status: "comparable", comparable_at: expect.any(Date) });

    await pool.end();
  }, 180_000);

  it("aborts atomically when an actionable Flow manifest identity is unresolved", async () => {
    const pool = await preparedDatabase("ambiguous");
    const client = await pool.connect();

    try {
      await seedProject(client, "p-ambiguous");
      await seedRun({
        client,
        runId: "ambiguous-run",
        projectId: "p-ambiguous",
        flowId: null,
        revisionId: null,
        status: "Running",
      });
    } finally {
      client.release();
    }

    await expect(applyCutover(pool)).rejects.toThrow(
      /unresolved or ambiguous manifest\/project identity/,
    );
    expect(
      (await pool.query(`SELECT status FROM runs WHERE id = 'ambiguous-run'`))
        .rows[0]?.status,
    ).toBe("Running");
    expect(
      (await pool.query(`SELECT to_regclass('public.step_runs') AS table_name`))
        .rows[0]?.table_name,
    ).toBe("step_runs");

    await pool.end();
  }, 180_000);
});
