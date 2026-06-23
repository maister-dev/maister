// M37 Phase 4 (T4.3, ADR-098): the auto_launch_run_plan consumer. A child
// terminal event releases the orchestrator's as-plan siblings whose
// success-gated `requires` blockers have all cleared. Exactly-once is the
// live-run check + the (agent_id, trigger_event_id) unique index inside
// launchAgentRun. tryStartRun is stubbed off so a launched run stays a stable
// (non-terminal) Pending — which is exactly what the live-run guard reads.

import type { DomainEventRow } from "@/lib/db/schema";

import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
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

const schema = schemaModule as unknown as Record<string, any>;

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;
let agentsRoot: string;

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));
vi.mock("@/lib/scheduler", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/scheduler")>();

  return {
    ...actual,
    tryStartRun: vi.fn(async () => ({ started: false, queuePosition: 1 })),
  };
});

let buildAutoLaunchRunPlanConsumer: typeof import("@/lib/domain-events/auto-launch").buildAutoLaunchRunPlanConsumer;
let emitDomainEvent: typeof import("@/lib/domain-events/outbox").emitDomainEvent;

beforeAll(async () => {
  agentsRoot = await mkdtemp(path.join(os.tmpdir(), "maister-autolaunch-"));

  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("autolaunch_test")
    .withUsername("test")
    .withPassword("test")
    .start();

  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);
  await migrate(db, { migrationsFolder: "./lib/db/migrations" });

  ({ buildAutoLaunchRunPlanConsumer } = await import(
    "@/lib/domain-events/auto-launch"
  ));
  ({ emitDomainEvent } = await import("@/lib/domain-events/outbox"));
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

let projectId: string;
let executorId: string;
let orchestratorAgentId: string;
let workerAgentId: string;

beforeEach(async () => {
  await pool.query(`DELETE FROM "domain_events"`);
  await pool.query(`DELETE FROM "runs"`);
  await pool.query(`DELETE FROM "task_relations"`);
  await pool.query(`DELETE FROM "tasks"`);
  await pool.query(`DELETE FROM "agent_project_links"`);
  await pool.query(`DELETE FROM "agents"`);
  await pool.query(`DELETE FROM "flows"`);
  await pool.query(`DELETE FROM "flow_revisions"`);
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
  await pool.query(
    `INSERT INTO "flows"
       ("id", "project_id", "flow_ref_id", "source", "version", "installed_path",
        "manifest", "schema_version", "enabled_revision_id", "enablement_state",
        "trust_status", "version_binding")
     VALUES ($1, $2, 'test-pkg', 'github.com/acme/test-pkg', 'v1.0.0', $3,
             '{}'::jsonb, 1, $4, 'Enabled', 'trusted', 'pinned')`,
    [randomUUID(), projectId, agentsRoot, revisionId],
  );

  orchestratorAgentId = await seedAgent("orchestrator");
  workerAgentId = await seedAgent("worker");
});

async function seedAgent(stem: string): Promise<string> {
  const qualifiedId = `test-pkg:${stem}`;

  await mkdir(path.join(agentsRoot, "maister-agents"), { recursive: true });
  await writeFile(
    path.join(agentsRoot, "maister-agents", `${stem}.md`),
    `---
name: ${stem}
description: d
workspace: none
mode: session
triggers:
  - manual
  - domain_event
risk_tier: read_only
---
Do the thing.
`,
    "utf8",
  );

  await pool.query(
    `INSERT INTO "agents" ("id", "flow_ref_id", "version_label", "origin", "name", "description", "workspace", "mode", "triggers", "risk_tier", "source_path", "enabled")
     VALUES ($1, 'test-pkg', 'v1.0.0', 'git', $2, 'd', 'none', 'session', '["manual","domain_event"]'::jsonb, 'read_only', $3, true)
     ON CONFLICT (id) DO NOTHING`,
    [qualifiedId, stem, path.join(agentsRoot, "maister-agents", `${stem}.md`)],
  );
  await pool.query(
    `INSERT INTO "agent_project_links" ("id", "agent_id", "project_id") VALUES ($1, $2, $3)
     ON CONFLICT DO NOTHING`,
    [randomUUID(), qualifiedId, projectId],
  );

  return qualifiedId;
}

// An orchestrator parent run + its task.
async function seedOrchestrator(): Promise<{
  parentRunId: string;
  orchTaskId: string;
}> {
  const orchTaskId = randomUUID();
  const number = Math.trunc(Math.random() * 1e9) + 1;

  await pool.query(
    `INSERT INTO "tasks" ("id", "project_id", "number", "title", "prompt", "status", "stage", "attempt_number")
     VALUES ($1, $2, $3, 'Orchestrator', 'coordinate', 'InFlight', 'InFlight', 1)`,
    [orchTaskId, projectId, number],
  );

  const parentRunId = randomUUID();

  await pool.query(
    `INSERT INTO "runs" ("id", "run_kind", "agent_id", "project_id", "task_id",
       "status", "flow_version", "flow_revision", "runner_id")
     VALUES ($1, 'agent', $2, $3, $4, 'Running', 'agent', 'manual', $5)`,
    [parentRunId, orchestratorAgentId, projectId, orchTaskId, executorId],
  );

  return { parentRunId, orchTaskId };
}

// An as-plan task: launch_mode='auto', delegation_spec → the worker, parent_of
// under the orchestrator's task.
async function seedAsPlanTask(args: {
  orchTaskId: string;
  title: string;
}): Promise<string> {
  const taskId = randomUUID();
  const number = Math.trunc(Math.random() * 1e9) + 1;

  await pool.query(
    `INSERT INTO "tasks" ("id", "project_id", "number", "title", "prompt", "status", "stage", "attempt_number", "launch_mode", "delegation_spec")
     VALUES ($1, $2, $3, $4, 'p', 'Backlog', 'Backlog', 1, 'auto', $5::jsonb)`,
    [
      taskId,
      projectId,
      number,
      args.title,
      JSON.stringify({ agentId: workerAgentId }),
    ],
  );
  // actor_type='system' (null actor_id) satisfies the actor_pair CHECK.
  await pool.query(
    `INSERT INTO "task_relations" ("id", "project_id", "from_task_id", "kind", "to_task_id", "actor_type")
     VALUES ($1, $2, $3, 'parent_of', $4, 'system')`,
    [randomUUID(), projectId, args.orchTaskId, taskId],
  );

  return taskId;
}

// B requires A (success-gated).
async function addRequires(
  fromTaskId: string,
  toTaskId: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO "task_relations" ("id", "project_id", "from_task_id", "kind", "to_task_id", "actor_type")
     VALUES ($1, $2, $3, 'requires', $4, 'system')`,
    [randomUUID(), projectId, fromTaskId, toTaskId],
  );
}

// A terminal child run under the orchestrator + its emitted domain event.
// Mirrors the REALISTIC task state when the terminal fires: a SUCCESSFUL child
// is still InFlight (the auto-launcher's flip is what advances its task to Done,
// proving the end-to-end gate release), while a failure is non-Done (Abandoned),
// which the `requires` success-gate keeps blocking.
async function emitChildTerminal(args: {
  parentRunId: string;
  childTaskId: string;
  outcome: "Done" | "Failed" | "Abandoned";
}): Promise<DomainEventRow> {
  const runStatus = args.outcome;
  const taskStatus = args.outcome === "Done" ? "InFlight" : "Abandoned";

  // Idempotent: if the child task already has a run (e.g. a source sibling the
  // consumer auto-launched on a PRIOR event in this same test), COMPLETE that
  // existing run rather than inserting a duplicate — one auto run per task is the
  // runs_auto_task_uq invariant (ADR-100), and a real terminal completes the
  // run that exists, it does not spawn a new one.
  const existing = await pool.query(
    `SELECT "id" FROM "runs" WHERE "task_id" = $1 LIMIT 1`,
    [args.childTaskId],
  );
  let childRunId: string;

  if (existing.rows.length > 0) {
    childRunId = existing.rows[0].id as string;
    await pool.query(`UPDATE "runs" SET "status" = $1 WHERE "id" = $2`, [
      runStatus,
      childRunId,
    ]);
  } else {
    childRunId = randomUUID();
    await pool.query(
      `INSERT INTO "runs" ("id", "run_kind", "agent_id", "project_id", "task_id",
         "status", "flow_version", "flow_revision", "parent_run_id", "root_run_id", "runner_id", "launch_mode")
       VALUES ($1, 'agent', $2, $3, $4, $5, 'agent', 'manual', $6, $6, $7, 'auto')`,
      [
        childRunId,
        workerAgentId,
        projectId,
        args.childTaskId,
        runStatus,
        args.parentRunId,
        executorId,
      ],
    );
  }
  await pool.query(`UPDATE "tasks" SET "status" = $1 WHERE "id" = $2`, [
    taskStatus,
    args.childTaskId,
  ]);

  const kind =
    args.outcome === "Done"
      ? "run.done"
      : args.outcome === "Failed"
        ? "run.failed"
        : "run.abandoned";

  await emitDomainEvent({
    db,
    kind: kind as "run.done",
    projectId,
    taskId: args.childTaskId,
    runId: childRunId,
    actor: { type: "agent", id: workerAgentId },
    parentRunId: args.parentRunId,
    payload: { runKind: "agent", agentId: workerAgentId, status: runStatus },
  });

  const rows = (await db
    .select()
    .from(schema.domainEvents)
    .where(eq(schema.domainEvents.runId, childRunId))) as DomainEventRow[];

  return rows[0];
}

async function runCount(taskId: string): Promise<number> {
  const r = await pool.query(
    `SELECT count(*)::int AS n FROM "runs" WHERE "task_id" = $1`,
    [taskId],
  );

  return r.rows[0].n;
}

// M37 (ADR-100): a child reaching Review under the orchestrator + its run.review
// event. The RUN's launch_mode selects as-plan ('auto', auto-promoted by this
// consumer) vs as-run ('manual', coordinator-driven — not auto-promoted).
async function emitChildReview(args: {
  parentRunId: string;
  childTaskId: string;
  launchMode: "auto" | "manual";
}): Promise<DomainEventRow> {
  const childRunId = randomUUID();

  await pool.query(
    `INSERT INTO "runs" ("id", "run_kind", "agent_id", "project_id", "task_id",
       "status", "flow_version", "flow_revision", "parent_run_id", "root_run_id", "runner_id", "launch_mode")
     VALUES ($1, 'agent', $2, $3, $4, 'Review', 'agent', 'manual', $5, $5, $6, $7)`,
    [
      childRunId,
      workerAgentId,
      projectId,
      args.childTaskId,
      args.parentRunId,
      executorId,
      args.launchMode,
    ],
  );

  await emitDomainEvent({
    db,
    kind: "run.review",
    projectId,
    taskId: args.childTaskId,
    runId: childRunId,
    actor: { type: "agent", id: workerAgentId },
    parentRunId: args.parentRunId,
    payload: { runKind: "agent", agentId: workerAgentId, status: "Review" },
  });

  const rows = (await db
    .select()
    .from(schema.domainEvents)
    .where(eq(schema.domainEvents.runId, childRunId))) as DomainEventRow[];

  return rows[0];
}

describe("auto_launch_run_plan consumer", () => {
  it("(5) launches a dependent once its blocker completes; redelivery is idempotent", async () => {
    const { parentRunId, orchTaskId } = await seedOrchestrator();
    const taskA = await seedAsPlanTask({ orchTaskId, title: "A" });
    const taskB = await seedAsPlanTask({ orchTaskId, title: "B" });

    // B requires A.
    await addRequires(taskB, taskA);

    // A launched + terminal Done.
    const event = await emitChildTerminal({
      parentRunId,
      childTaskId: taskA,
      outcome: "Done",
    });

    const consumer = buildAutoLaunchRunPlanConsumer({ db });

    await consumer.handle([event]);

    // B now has exactly one (Pending) run — launched with parent/root linkage.
    expect(await runCount(taskB)).toBe(1);
    const bRun = await pool.query(
      `SELECT "parent_run_id", "root_run_id", "trigger_source", "launch_mode"
       FROM "runs" WHERE "task_id" = $1`,
      [taskB],
    );

    expect(bRun.rows[0].parent_run_id).toBe(parentRunId);
    expect(bRun.rows[0].root_run_id).toBe(parentRunId);
    expect(bRun.rows[0].trigger_source).toBe("domain_event");
    expect(bRun.rows[0].launch_mode).toBe("auto");

    // Re-deliver the SAME event → still exactly one run (the has-any-run guard).
    await consumer.handle([event]);
    expect(await runCount(taskB)).toBe(1);
  });

  // C3 (real two-racer): two dispatcher workers handling the same terminal event
  // CONCURRENTLY must launch the released dependent exactly once — the hasAnyRun
  // guard + the (agent_id, trigger_event_id) unique index together, not in-loop
  // sequencing, are the exactly-once belt.
  it("(5c) concurrent handle() of the releasing event launches the dependent exactly once", async () => {
    const { parentRunId, orchTaskId } = await seedOrchestrator();
    const taskA = await seedAsPlanTask({ orchTaskId, title: "A" });
    const taskB = await seedAsPlanTask({ orchTaskId, title: "B" });

    await addRequires(taskB, taskA);
    const event = await emitChildTerminal({
      parentRunId,
      childTaskId: taskA,
      outcome: "Done",
    });

    const consumer = buildAutoLaunchRunPlanConsumer({ db });

    await Promise.all([consumer.handle([event]), consumer.handle([event])]);

    expect(await runCount(taskB)).toBe(1);
  }, 60_000);

  it("one event fanning out to TWO same-agent dependents launches BOTH (no index collapse)", async () => {
    const { parentRunId, orchTaskId } = await seedOrchestrator();
    const taskA = await seedAsPlanTask({ orchTaskId, title: "A" });
    const taskB = await seedAsPlanTask({ orchTaskId, title: "B" });
    const taskC = await seedAsPlanTask({ orchTaskId, title: "C" });

    // Diamond fan-out: B requires A AND C requires A. Both use the same worker
    // agent — keying dedup on the shared event id would starve one of them.
    await addRequires(taskB, taskA);
    await addRequires(taskC, taskA);

    const event = await emitChildTerminal({
      parentRunId,
      childTaskId: taskA,
      outcome: "Done",
    });

    await buildAutoLaunchRunPlanConsumer({ db }).handle([event]);

    // Both dependents launched (the source A is skipped — it already has a run).
    expect(await runCount(taskB)).toBe(1);
    expect(await runCount(taskC)).toBe(1);
  });

  it("(6) a FAILED/Abandoned blocker does NOT release the dependent (success-gate)", async () => {
    const { parentRunId, orchTaskId } = await seedOrchestrator();
    const taskA = await seedAsPlanTask({ orchTaskId, title: "A" });
    const taskB = await seedAsPlanTask({ orchTaskId, title: "B" });

    await addRequires(taskB, taskA);

    // A terminal FAILED → its task goes Abandoned. The requires gate keeps B blocked.
    const event = await emitChildTerminal({
      parentRunId,
      childTaskId: taskA,
      outcome: "Failed",
    });

    await buildAutoLaunchRunPlanConsumer({ db }).handle([event]);

    // B is NOT launched.
    expect(await runCount(taskB)).toBe(0);
  });

  // Sibling of (6): the OTHER non-Done terminal. The doc/ADR promise is
  // "Failed/Abandoned keeps dependents blocked" — an Abandoned blocker (e.g. a
  // cascade-abandoned or user-discarded child) is non-Done, so the `requires`
  // success-gate must keep B blocked exactly as a Failed one does.
  it("(6b) an ABANDONED blocker does NOT release the dependent (success-gate)", async () => {
    const { parentRunId, orchTaskId } = await seedOrchestrator();
    const taskA = await seedAsPlanTask({ orchTaskId, title: "A" });
    const taskB = await seedAsPlanTask({ orchTaskId, title: "B" });

    await addRequires(taskB, taskA);

    // A terminal ABANDONED → its task goes Abandoned. The requires gate keeps B blocked.
    const event = await emitChildTerminal({
      parentRunId,
      childTaskId: taskA,
      outcome: "Abandoned",
    });

    await buildAutoLaunchRunPlanConsumer({ db }).handle([event]);

    // B is NOT launched.
    expect(await runCount(taskB)).toBe(0);
  });

  it("(7) two blockers near-simultaneous: C requires A AND B → launched exactly once", async () => {
    const { parentRunId, orchTaskId } = await seedOrchestrator();
    const taskA = await seedAsPlanTask({ orchTaskId, title: "A" });
    const taskB = await seedAsPlanTask({ orchTaskId, title: "B" });
    const taskC = await seedAsPlanTask({ orchTaskId, title: "C" });

    // C requires A and C requires B.
    await addRequires(taskC, taskA);
    await addRequires(taskC, taskB);

    const consumer = buildAutoLaunchRunPlanConsumer({ db });

    // A done first → C still blocked by B → NOT launched.
    const eventA = await emitChildTerminal({
      parentRunId,
      childTaskId: taskA,
      outcome: "Done",
    });

    await consumer.handle([eventA]);
    expect(await runCount(taskC)).toBe(0);

    // B done next → both blockers clear → C launched exactly once.
    const eventB = await emitChildTerminal({
      parentRunId,
      childTaskId: taskB,
      outcome: "Done",
    });

    await consumer.handle([eventB]);
    expect(await runCount(taskC)).toBe(1);

    // A second event after C is already running must not double-launch (the
    // live-run guard): re-deliver B's event → still exactly one.
    await consumer.handle([eventB]);
    expect(await runCount(taskC)).toBe(1);
  });

  it("ignores a non-agent or parent-less terminal event", async () => {
    const { orchTaskId } = await seedOrchestrator();
    const taskA = await seedAsPlanTask({ orchTaskId, title: "A" });
    const taskB = await seedAsPlanTask({ orchTaskId, title: "B" });

    await addRequires(taskB, taskA);

    // Move A to Done so the gate would otherwise release B.
    await pool.query(`UPDATE "tasks" SET "status" = 'Done' WHERE "id" = $1`, [
      taskA,
    ]);

    // A run.done event with NO parentRunId (a top-level run) → consumer skips.
    const topRunId = randomUUID();

    await pool.query(
      `INSERT INTO "runs" ("id", "run_kind", "agent_id", "project_id", "task_id",
         "status", "flow_version", "flow_revision", "runner_id")
       VALUES ($1, 'agent', $2, $3, $4, 'Done', 'agent', 'manual', $5)`,
      [topRunId, workerAgentId, projectId, taskA, executorId],
    );
    await emitDomainEvent({
      db,
      kind: "run.done",
      projectId,
      taskId: taskA,
      runId: topRunId,
      actor: { type: "agent", id: workerAgentId },
      parentRunId: null,
      payload: { runKind: "agent", agentId: workerAgentId, status: "Done" },
    });

    const rows = (await db
      .select()
      .from(schema.domainEvents)
      .where(eq(schema.domainEvents.runId, topRunId))) as DomainEventRow[];

    await buildAutoLaunchRunPlanConsumer({ db }).handle([rows[0]]);

    // B not launched — the event carried no orchestrator parent.
    expect(await runCount(taskB)).toBe(0);
  });

  // M37 (ADR-100): an as-plan (launch_mode='auto') child reaching Review is
  // auto-promoted (system actor) so the auto-DAG flows without a live coordinator.
  it("(8) an as-plan child reaching Review is auto-promoted (ADR-100)", async () => {
    const { parentRunId, orchTaskId } = await seedOrchestrator();
    const taskA = await seedAsPlanTask({ orchTaskId, title: "A" });
    const event = await emitChildReview({
      parentRunId,
      childTaskId: taskA,
      launchMode: "auto",
    });

    const promoteCalls: Array<{ childRunId: string; actorKind: string }> = [];
    const consumer = buildAutoLaunchRunPlanConsumer({
      db,
      promote: async (childRunId, opts) => {
        promoteCalls.push({ childRunId, actorKind: opts.actor.kind });

        return {
          ok: true,
          mode: "local_merge",
          pullRequestUrl: null,
        } as never;
      },
    });

    await consumer.handle([event]);

    expect(promoteCalls).toHaveLength(1);
    expect(promoteCalls[0].childRunId).toBe(event.runId);
    expect(promoteCalls[0].actorKind).toBe("system");
  });

  // A MANUAL (as-run) child reaching Review is the live coordinator's to promote
  // via run_promote — the auto-launcher must NOT auto-promote it.
  it("a manual (as-run) child reaching Review is NOT auto-promoted", async () => {
    const { parentRunId, orchTaskId } = await seedOrchestrator();
    const taskA = await seedAsPlanTask({ orchTaskId, title: "A" });
    const event = await emitChildReview({
      parentRunId,
      childTaskId: taskA,
      launchMode: "manual",
    });

    const promoteCalls: string[] = [];
    const consumer = buildAutoLaunchRunPlanConsumer({
      db,
      promote: async (childRunId) => {
        promoteCalls.push(childRunId);

        return { ok: true } as never;
      },
    });

    await consumer.handle([event]);

    expect(promoteCalls).toEqual([]);
  });
});
