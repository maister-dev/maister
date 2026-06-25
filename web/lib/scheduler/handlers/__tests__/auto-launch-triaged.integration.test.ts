import "server-only";

// Phase 4 (ADR-111): the auto_launch_triaged tick. A triaged + launch_mode=auto
// + flow task with no live flow run and all relation blockers cleared is
// launched by the tick (reusing launchRun). Candidate selection, the
// dependency-wait, the flagged hold, the orchestrator disjointness, the
// live-run idempotency guard, the cap→Pending transient, and the stale-flow
// give-up are exercised here against a real Postgres with an injected launch fn
// (no real git/supervisor).

import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { testPlatformRunnerRow } from "@/lib/__tests__/runner-fixtures";
import * as schemaModule from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";

const schema = schemaModule as unknown as Record<string, any>;

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;
let agentsRoot: string;

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));

let runAutoLaunchTriagedJob: typeof import("@/lib/scheduler/handlers/auto-launch-triaged").runAutoLaunchTriagedJob;

beforeAll(async () => {
  agentsRoot = await mkdtemp(path.join(os.tmpdir(), "maister-autotriage-"));

  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("autotriage_test")
    .withUsername("test")
    .withPassword("test")
    .start();

  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);
  await migrate(db, { migrationsFolder: "./lib/db/migrations" });

  ({ runAutoLaunchTriagedJob } = await import(
    "@/lib/scheduler/handlers/auto-launch-triaged"
  ));
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

let projectId: string;
let executorId: string;
let flowId: string;

beforeEach(async () => {
  await pool.query(`DELETE FROM "task_activity"`);
  await pool.query(`DELETE FROM "runs"`);
  await pool.query(`DELETE FROM "task_relations"`);
  await pool.query(`DELETE FROM "tasks"`);
  await pool.query(`DELETE FROM "flows"`);
  await pool.query(`DELETE FROM "flow_revisions"`);
  await pool.query(`DELETE FROM "platform_runtime_settings"`);
  await pool.query(`DELETE FROM "platform_acp_runners"`);
  await pool.query(`DELETE FROM "projects"`);

  projectId = randomUUID();
  executorId = randomUUID();

  await pool.query(
    `INSERT INTO "projects" ("id", "slug", "name", "repo_path", "main_branch", "branch_prefix", "maister_yaml_path", "task_key", "next_task_number")
     VALUES ($1, $2, 'P', $3, 'main', 'maister/', '/tmp/maister.yaml', $4, 1)`,
    [
      projectId,
      `p-${projectId.slice(0, 8)}`,
      `/repos/${projectId}`,
      `K${projectId
        .replace(/[^0-9A-Za-z]/g, "")
        .slice(0, 7)
        .toUpperCase()}`,
    ],
  );

  await (db as any)
    .insert(schema.platformAcpRunners)
    .values(testPlatformRunnerRow(executorId, "claude"));
  await pool.query(
    `INSERT INTO "platform_runtime_settings" ("id", "default_runner_id")
     VALUES ('singleton', $1)
     ON CONFLICT (id) DO UPDATE SET "default_runner_id" = $1`,
    [executorId],
  );

  const revisionId = randomUUID();

  await pool.query(
    `INSERT INTO "flow_revisions"
       ("id", "flow_ref_id", "source", "version_label", "resolved_revision",
        "manifest_digest", "manifest", "schema_version", "installed_path", "package_status")
     VALUES ($1, 'test-pkg', 'github.com/acme/test-pkg', 'v1.0.0', 'rev-1',
             'digest', '{}'::jsonb, 1, $2, 'Installed')`,
    [revisionId, agentsRoot],
  );

  flowId = randomUUID();
  await pool.query(
    `INSERT INTO "flows"
       ("id", "project_id", "flow_ref_id", "source", "version", "installed_path",
        "manifest", "schema_version", "enabled_revision_id", "enablement_state",
        "trust_status", "version_binding")
     VALUES ($1, $2, 'test-pkg', 'github.com/acme/test-pkg', 'v1.0.0', $3,
             '{}'::jsonb, 1, $4, 'Enabled', 'trusted', 'pinned')`,
    [flowId, projectId, agentsRoot, revisionId],
  );
});

// A triaged + auto-enqueued task. flowId defaults to the seeded launchable flow.
async function seedTriagedAutoTask(
  args: {
    flowId?: string | null;
    triageStatus?: "triaged" | "flagged" | null;
    launchMode?: "auto" | "manual" | null;
    delegationSpec?: Record<string, unknown> | null;
  } = {},
): Promise<string> {
  const taskId = randomUUID();
  const number = Math.trunc(Math.random() * 1e9) + 1;
  const resolvedFlowId = args.flowId === undefined ? flowId : args.flowId;

  await pool.query(
    `INSERT INTO "tasks"
       ("id", "project_id", "number", "title", "prompt", "status", "stage",
        "attempt_number", "flow_id", "triage_status", "launch_mode", "delegation_spec")
     VALUES ($1, $2, $3, 'T', 'do it', 'Backlog', 'Backlog', 1, $4, $5, $6, $7::jsonb)`,
    [
      taskId,
      projectId,
      number,
      resolvedFlowId,
      args.triageStatus === undefined ? "triaged" : args.triageStatus,
      args.launchMode === undefined ? "auto" : args.launchMode,
      args.delegationSpec ? JSON.stringify(args.delegationSpec) : null,
    ],
  );

  return taskId;
}

// A blocker task (depends_on / blocks) in the given board status.
async function seedBlocker(status: "Backlog" | "Done"): Promise<string> {
  const taskId = randomUUID();
  const number = Math.trunc(Math.random() * 1e9) + 1;

  await pool.query(
    `INSERT INTO "tasks" ("id", "project_id", "number", "title", "prompt", "status", "stage", "attempt_number")
     VALUES ($1, $2, $3, 'B', 'b', $4, 'Backlog', 1)`,
    [taskId, projectId, number, status],
  );

  return taskId;
}

// fromTask depends_on toTask (open while toTask is Backlog|InFlight).
async function addDependsOn(
  fromTaskId: string,
  toTaskId: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO "task_relations" ("id", "project_id", "from_task_id", "kind", "to_task_id", "actor_type")
     VALUES ($1, $2, $3, 'depends_on', $4, 'system')`,
    [randomUUID(), projectId, fromTaskId, toTaskId],
  );
}

// Seed a live (non-terminal) flow run for a task.
async function seedLiveFlowRun(
  taskId: string,
  status = "Running",
): Promise<string> {
  const runId = randomUUID();

  await pool.query(
    `INSERT INTO "runs" ("id", "run_kind", "project_id", "task_id", "status", "flow_version", "flow_revision", "runner_id")
     VALUES ($1, 'flow', $2, $3, $4, 'v1.0.0', 'rev-1', $5)`,
    [runId, projectId, taskId, status, executorId],
  );

  return runId;
}

async function flowRunCount(taskId: string): Promise<number> {
  const r = await pool.query(
    `SELECT count(*)::int AS n FROM "runs" WHERE "task_id" = $1 AND "run_kind" = 'flow'`,
    [taskId],
  );

  return r.rows[0].n;
}

async function launchModeOf(taskId: string): Promise<string | null> {
  const r = await pool.query(
    `SELECT "launch_mode" FROM "tasks" WHERE "id" = $1`,
    [taskId],
  );

  return r.rows[0].launch_mode;
}

async function activityKinds(taskId: string): Promise<string[]> {
  const r = await pool.query(
    `SELECT "event_kind" FROM "task_activity" WHERE "task_id" = $1`,
    [taskId],
  );

  return r.rows.map((row) => row.event_kind as string);
}

// A launch stub that records calls and returns a canned terminal. Mirrors the
// auto-launch consumer's injectable launch seam — keeps the test off real git.
function recordingLaunch(
  result: { runId: string; status: string; queuePosition?: number } = {
    runId: "stub-run",
    status: "Running",
  },
) {
  const calls: string[] = [];
  const fn = vi.fn(async (input: { taskId: string }) => {
    calls.push(input.taskId);

    return result;
  });

  return { fn, calls };
}

describe("auto_launch_triaged tick", () => {
  it("launches a triaged + auto + flow + launchable candidate", async () => {
    const taskId = await seedTriagedAutoTask();
    const { fn, calls } = recordingLaunch();

    const summary = await runAutoLaunchTriagedJob({ launch: fn });

    expect(calls).toEqual([taskId]);
    expect(summary.launched).toBe(1);
    expect(await launchModeOf(taskId)).toBe("auto");
  });

  it("does NOT launch while a depends_on blocker is open; launches once it is Done", async () => {
    const taskId = await seedTriagedAutoTask();
    const blocker = await seedBlocker("Backlog");

    await addDependsOn(taskId, blocker);

    const first = recordingLaunch();

    await runAutoLaunchTriagedJob({ launch: first.fn });
    expect(first.calls).toEqual([]);

    // Blocker clears.
    await pool.query(`UPDATE "tasks" SET "status" = 'Done' WHERE "id" = $1`, [
      blocker,
    ]);

    const second = recordingLaunch();

    await runAutoLaunchTriagedJob({ launch: second.fn });
    expect(second.calls).toEqual([taskId]);
  });

  it("does NOT launch a flagged task (flagged is held)", async () => {
    await seedTriagedAutoTask({ triageStatus: "flagged" });
    const { fn, calls } = recordingLaunch();

    await runAutoLaunchTriagedJob({ launch: fn });
    expect(calls).toEqual([]);
  });

  it("does NOT launch a task with no flow", async () => {
    await seedTriagedAutoTask({ flowId: null });
    const { fn, calls } = recordingLaunch();

    await runAutoLaunchTriagedJob({ launch: fn });
    expect(calls).toEqual([]);
  });

  it("is disjoint from auto_launch_run_plan: an orchestrator as-plan task is NOT picked", async () => {
    // An as-plan task: launch_mode='auto', delegation_spec.agentId set, no flow.
    await seedTriagedAutoTask({
      flowId: null,
      triageStatus: null,
      delegationSpec: { agentId: "test-pkg:worker" },
    });
    const { fn, calls } = recordingLaunch();

    await runAutoLaunchTriagedJob({ launch: fn });
    expect(calls).toEqual([]);
  });

  it("does NOT double-launch a task that already has a live flow run", async () => {
    const taskId = await seedTriagedAutoTask();

    await seedLiveFlowRun(taskId, "Running");

    const { fn, calls } = recordingLaunch();

    await runAutoLaunchTriagedJob({ launch: fn });
    expect(calls).toEqual([]);
  });

  it("cap-hit (launch returns Pending) is transient — launch_mode stays auto, retried next tick", async () => {
    const taskId = await seedTriagedAutoTask();
    const capped = recordingLaunch({
      runId: "queued-run",
      status: "Pending",
      queuePosition: 3,
    });

    const summary = await runAutoLaunchTriagedJob({ launch: capped.fn });

    expect(capped.calls).toEqual([taskId]);
    expect(summary.launched).toBe(1);
    // NOT a give-up: still auto, no give-up activity.
    expect(await launchModeOf(taskId)).toBe("auto");
    expect(await activityKinds(taskId)).not.toContain("triage_requeued");
  });

  it("gives up on a terminal PRECONDITION (stale flow): clears launch_mode + records activity, not re-attempted", async () => {
    const taskId = await seedTriagedAutoTask();
    const refusing = {
      fn: vi.fn(async () => {
        throw new MaisterError(
          "PRECONDITION",
          `flow "x" package is Disabled, not launchable`,
        );
      }),
    };

    const summary = await runAutoLaunchTriagedJob({ launch: refusing.fn });

    expect(refusing.fn).toHaveBeenCalledTimes(1);
    expect(summary.gaveUp).toBe(1);
    expect(await launchModeOf(taskId)).toBeNull();
    expect(await activityKinds(taskId)).toContain("triage_requeued");
    expect(await flowRunCount(taskId)).toBe(0);

    // Next tick: the candidate predicate no longer matches (launch_mode null) →
    // not re-attempted.
    const second = recordingLaunch();

    await runAutoLaunchTriagedJob({ launch: second.fn });
    expect(second.calls).toEqual([]);
  });

  it("does NOT give up on a transient EXECUTOR_UNAVAILABLE — stays auto", async () => {
    const taskId = await seedTriagedAutoTask();
    const refusing = {
      fn: vi.fn(async () => {
        throw new MaisterError(
          "EXECUTOR_UNAVAILABLE",
          "supervisor unavailable",
        );
      }),
    };

    const summary = await runAutoLaunchTriagedJob({ launch: refusing.fn });

    expect(refusing.fn).toHaveBeenCalledTimes(1);
    expect(summary.gaveUp).toBe(0);
    expect(await launchModeOf(taskId)).toBe("auto");
    expect(await activityKinds(taskId)).not.toContain("triage_requeued");
  });
});
