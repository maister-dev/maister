// ADR-121 (T13 slot-free C2 mint + T14 cap-safe C3 resume): the unified
// priority-ordered admission gate (`promoteNextPending` = `admitOnFreeSlot`).
// Real-PG: a freed slot admits the single most-critical eligible unit across
// C1 (Pending runs), C3 (answered-idle resumables), and C2 (fresh Backlog tasks),
// strictly by (weight DESC, classRank, FIFO), honoring the reserve/share guards,
// the two-phase C2 claim, and the cap.

import { randomUUID } from "node:crypto";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import * as fullSchema from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import { promoteNextPending } from "@/lib/scheduler";

const schema = fullSchema as unknown as Record<string, any>;
const { runs, tasks } = schema;

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;
let seq = 0;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("maister_admission_gate_test")
    .withUsername("test")
    .withPassword("test")
    .start();

  pool = new Pool({ connectionString: container.getConnectionUri(), max: 8 });
  db = drizzle(pool);
  await migrate(db, { migrationsFolder: "./lib/db/migrations" });
  // The scheduler advisory lock (pg_advisory_xact_lock) only engages when DB_URL
  // is a postgres URL — point it at the container so the gate's count-then-claim is
  // serialized exactly as in prod (the INV-1 burst test depends on it).
  process.env.DB_URL = container.getConnectionUri();
}, 180_000);

afterAll(async () => {
  delete process.env.DB_URL;
  await pool?.end();
  await container?.stop();
});

afterEach(async () => {
  delete process.env.MAISTER_MAX_CONCURRENT_RUNS;
  delete process.env.MAISTER_TASK_QUEUE_AUTO_RESERVE;
  await pool.query(`DELETE FROM "runs"`);
  await pool.query(`DELETE FROM "task_relations"`);
  await pool.query(`DELETE FROM "tasks"`);
  await pool.query(`DELETE FROM "flows"`);
  await pool.query(`DELETE FROM "flow_revisions"`);
  await pool.query(`DELETE FROM "projects"`);
});

async function seedProject(settings: object | null = null): Promise<string> {
  const projectId = randomUUID();
  const slug = `ag-${projectId.slice(0, 8)}`;

  await db.insert(schema.projects).values({
    id: projectId,
    slug,
    name: `AG ${slug}`,
    repoPath: `/tmp/${slug}`,
    taskKey: `P${projectId.slice(0, 8)}`.toUpperCase(),
    taskQueueSettings: settings,
  });

  return projectId;
}

// A real flow row (tasks.flow_id is a FK). The gate never validates the flow's
// content — only that flow_id is set — so a minimal Installed/Enabled row suffices.
async function seedFlow(projectId: string): Promise<string> {
  const revisionId = randomUUID();
  const flowId = randomUUID();
  const refId = `pkg-${flowId.slice(0, 8)}`;

  await pool.query(
    `INSERT INTO "flow_revisions"
       ("id", "flow_ref_id", "source", "version_label", "resolved_revision",
        "manifest_digest", "manifest", "schema_version", "installed_path", "package_status")
     VALUES ($1, $2, 'github.com/acme/x', 'v1.0.0', 'rev-1', 'd', '{}'::jsonb, 1, '/tmp/x', 'Installed')`,
    [revisionId, refId],
  );
  await pool.query(
    `INSERT INTO "flows"
       ("id", "project_id", "flow_ref_id", "source", "version", "installed_path",
        "manifest", "schema_version", "enabled_revision_id", "enablement_state",
        "trust_status", "version_binding")
     VALUES ($1, $2, $3, 'github.com/acme/x', 'v1.0.0', '/tmp/x', '{}'::jsonb, 1, $4,
             'Enabled', 'trusted', 'pinned')`,
    [flowId, projectId, refId, revisionId],
  );

  return flowId;
}

// A triaged + auto + flow Backlog task (a C2 candidate).
async function seedBacklogTask(
  projectId: string,
  priority: string,
): Promise<string> {
  const taskId = randomUUID();
  const flowId = await seedFlow(projectId);

  seq += 1;
  await db.insert(schema.tasks).values({
    id: taskId,
    projectId,
    number: seq,
    title: "t",
    prompt: "p",
    priority,
    status: "Backlog",
    triageStatus: "triaged",
    launchMode: "auto",
    flowId,
  });

  return taskId;
}

async function seedPendingRun(
  projectId: string,
  priority: string,
): Promise<string> {
  const taskId = randomUUID();
  const runId = randomUUID();

  seq += 1;
  await db.insert(schema.tasks).values({
    id: taskId,
    projectId,
    number: seq,
    title: "t",
    prompt: "p",
    priority,
    status: "InFlight",
  });
  await db.insert(schema.runs).values({
    id: runId,
    projectId,
    taskId,
    runKind: "flow",
    status: "Pending",
    flowVersion: "v1",
    flowRevision: "manual",
    startedAt: new Date(),
  });

  return runId;
}

async function seedIdleRun(
  projectId: string,
  priority: string,
  resumeRequestedAt: Date,
  runKind: "flow" | "agent" = "flow",
): Promise<string> {
  const taskId = randomUUID();
  const runId = randomUUID();

  seq += 1;
  await db.insert(schema.tasks).values({
    id: taskId,
    projectId,
    number: seq,
    title: "t",
    prompt: "p",
    priority,
    status: "InFlight",
  });
  await db.insert(schema.runs).values({
    id: runId,
    projectId,
    taskId,
    runKind,
    status: "NeedsInputIdle",
    flowVersion: "v1",
    flowRevision: "manual",
    startedAt: new Date(),
    resumeRequestedAt,
  });

  return runId;
}

// A background live (Running) flow run that holds a slot. `auto` stamps
// queue_admitted_at so it counts toward the per-project share (INV-9).
async function seedLiveRun(
  projectId: string,
  opts: { auto?: boolean } = {},
): Promise<string> {
  const runId = randomUUID();

  await db.insert(schema.runs).values({
    id: runId,
    projectId,
    runKind: "flow",
    status: "Running",
    flowVersion: "v1",
    flowRevision: "manual",
    startedAt: new Date(),
    queueAdmittedAt: opts.auto ? new Date() : null,
  });

  return runId;
}

async function statusOf(runId: string): Promise<string> {
  const rows = await db
    .select({ status: runs.status })
    .from(runs)
    .where(eq(runs.id, runId));

  return rows[0].status;
}

async function claimOf(taskId: string): Promise<Date | null> {
  const rows = await db
    .select({ c: tasks.queueClaimedAt })
    .from(tasks)
    .where(eq(tasks.id, taskId));

  return rows[0].c;
}

// An injected launchRun that records calls and creates a real Pending run for the
// task (mirroring the worktree-first prod launch so hasLiveFlowRun serializes a
// concurrent admission). Configurable to throw a terminal/transient refusal.
function recordingLaunch(opts: { throwErr?: MaisterError } = {}) {
  const calls: string[] = [];
  const fn = async (taskId: string) => {
    calls.push(taskId);
    if (opts.throwErr) throw opts.throwErr;
    const runId = randomUUID();

    await db.insert(schema.runs).values({
      id: runId,
      projectId: (
        await db
          .select({ p: tasks.projectId })
          .from(tasks)
          .where(eq(tasks.id, taskId))
      )[0].p,
      taskId,
      runKind: "flow",
      status: "Running",
      flowVersion: "v1",
      flowRevision: "manual",
      startedAt: new Date(),
      queueAdmittedAt: new Date(),
    });

    return { runId, status: "Running" };
  };

  return { fn, calls };
}

describe("ADR-121 unified admission gate — C2 slot-free mint (T13)", () => {
  it("AC-G3a: a freed slot pulls the next eligible Backlog task (not just a Pending run)", async () => {
    const projectId = await seedProject();
    const taskId = await seedBacklogTask(projectId, "normal");
    const launch = recordingLaunch();
    const runFlow: string[] = [];

    const res = await promoteNextPending({
      db,
      launchRun: launch.fn,
      runFlow: (id) => runFlow.push(id),
    });

    expect(launch.calls).toEqual([taskId]);
    expect(runFlow).toEqual([]);
    expect(res.promotedRunId).not.toBeNull();
    // Claim was set under the lock then cleared once the run row existed (F1).
    expect(await claimOf(taskId)).toBeNull();
  });

  it("AC-G3b: a higher-criticality fresh task (C2) beats a lower-criticality Pending run (C1)", async () => {
    const projectId = await seedProject();
    const pending = await seedPendingRun(projectId, "normal");
    const urgent = await seedBacklogTask(projectId, "urgent");
    const launch = recordingLaunch();
    const runFlow: string[] = [];

    await promoteNextPending({
      db,
      launchRun: launch.fn,
      runFlow: (id) => runFlow.push(id),
    });

    // Strict criticality: urgent C2 (400) preempts the normal C1 (200).
    expect(launch.calls).toEqual([urgent]);
    expect(runFlow).toEqual([]);
    expect(await statusOf(pending)).toBe("Pending");
  });

  it("AC-G3b-inverse: a higher-criticality Pending run (C1) beats a lower-criticality fresh task (C2)", async () => {
    const projectId = await seedProject();
    const pending = await seedPendingRun(projectId, "urgent");
    const lowTask = await seedBacklogTask(projectId, "low");
    const launch = recordingLaunch();
    const runFlow: string[] = [];

    await promoteNextPending({
      db,
      launchRun: launch.fn,
      runFlow: (id) => runFlow.push(id),
    });

    expect(runFlow).toEqual([pending]);
    expect(launch.calls).toEqual([]);
    expect(await statusOf(pending)).toBe("Running");
    expect(await claimOf(lowTask)).toBeNull();
  });

  it("AC-INV8: with reserve=2 and 4 live flow runs, no C2 admission though slots are free; freeing one admits", async () => {
    process.env.MAISTER_MAX_CONCURRENT_RUNS = "6";
    process.env.MAISTER_TASK_QUEUE_AUTO_RESERVE = "2";
    const projectId = await seedProject();

    await seedBacklogTask(projectId, "urgent");
    const live = [
      await seedLiveRun(projectId),
      await seedLiveRun(projectId),
      await seedLiveRun(projectId),
      await seedLiveRun(projectId),
    ];
    const held = recordingLaunch();

    await promoteNextPending({ db, launchRun: held.fn });
    expect(held.calls).toEqual([]); // 4 live = cap−reserve → reserve held (INV-8)

    await db.delete(runs).where(eq(runs.id, live[0]));
    const ok = recordingLaunch();

    await promoteNextPending({ db, launchRun: ok.fn });
    expect(ok.calls).toHaveLength(1);
  });

  it("AC-INV9: holds at per-project maxInFlightAuto (counted off queue_admitted_at)", async () => {
    const projectId = await seedProject({ maxInFlightAuto: 1 });

    await seedBacklogTask(projectId, "high");
    await seedLiveRun(projectId, { auto: true }); // liveAuto = 1 = max → held
    const held = recordingLaunch();

    await promoteNextPending({ db, launchRun: held.fn });
    expect(held.calls).toEqual([]);

    // Replace the auto run with a MANUAL one (queue_admitted_at NULL) → liveAuto 0.
    await db.delete(runs).where(isNotNull(runs.queueAdmittedAt));
    await seedLiveRun(projectId, { auto: false });
    const ok = recordingLaunch();

    await promoteNextPending({ db, launchRun: ok.fn });
    expect(ok.calls).toHaveLength(1);
  });

  it("AC-INV7: edgeDrain off for the project → no C2 pull (C1 still flows)", async () => {
    const projectId = await seedProject({ edgeDrain: false });
    const pending = await seedPendingRun(projectId, "normal");

    await seedBacklogTask(projectId, "urgent");
    const launch = recordingLaunch();
    const runFlow: string[] = [];

    await promoteNextPending({
      db,
      launchRun: launch.fn,
      runFlow: (id) => runFlow.push(id),
    });

    // edgeDrain off → urgent C2 is NOT pulled; the normal C1 still promotes.
    expect(launch.calls).toEqual([]);
    expect(runFlow).toEqual([pending]);
  });

  it("AC-F1-claim: two concurrent admissions of one task → exactly one launch (CAS queue_claimed_at)", async () => {
    const projectId = await seedProject();
    const taskId = await seedBacklogTask(projectId, "normal");
    const a = recordingLaunch();
    const b = recordingLaunch();

    await Promise.all([
      promoteNextPending({ db, launchRun: a.fn }),
      promoteNextPending({ db, launchRun: b.fn }),
    ]);

    expect(a.calls.length + b.calls.length).toBe(1);
    expect(await claimOf(taskId)).toBeNull();
  });

  it("Codex-2: an outstanding C2 claim counts toward the reserve, so a concurrent admission cannot over-mint the single free slot", async () => {
    // The burst root cause: a C2 claim reserves a flow slot BEFORE its run row
    // exists, so a lock-serialized concurrent gate call must SEE that claim as
    // consumed capacity. This asserts the accounting deterministically: with one
    // free slot already claimed, the gate admits no further C2.
    process.env.MAISTER_MAX_CONCURRENT_RUNS = "1";
    process.env.MAISTER_TASK_QUEUE_AUTO_RESERVE = "0";
    const projectId = await seedProject();
    const eligible = await seedBacklogTask(projectId, "normal");
    // Simulate the run a prior concurrent admission is mid-launching: a task whose
    // queue_claimed_at is set but whose run row does not exist yet.
    const claimedTask = await seedBacklogTask(projectId, "normal");

    await db
      .update(tasks)
      .set({ queueClaimedAt: new Date() })
      .where(eq(tasks.id, claimedTask));

    const held = recordingLaunch();

    await promoteNextPending({ db, launchRun: held.fn });
    // The one free slot is already spoken for by the outstanding claim → no mint.
    expect(held.calls).toEqual([]);

    // Clear the claim (the prior admission failed / completed) → now admittable.
    await db
      .update(tasks)
      .set({ queueClaimedAt: null })
      .where(eq(tasks.id, claimedTask));

    const ok = recordingLaunch();

    await promoteNextPending({ db, launchRun: ok.fn });
    expect(ok.calls).toHaveLength(1);
    expect(ok.calls[0]).toBe(eligible); // FIFO: the never-claimed task drains first
  });

  it("AC-F4: a transient launch failure clears the claim and the task is re-eligible next tick", async () => {
    const projectId = await seedProject();
    const taskId = await seedBacklogTask(projectId, "normal");
    const failing = recordingLaunch({
      throwErr: new MaisterError("EXECUTOR_UNAVAILABLE", "supervisor down"),
    });

    await promoteNextPending({ db, launchRun: failing.fn });
    expect(failing.calls).toEqual([taskId]);
    // Claim cleared, task still triaged+auto (not flagged) → re-eligible.
    expect(await claimOf(taskId)).toBeNull();
    const trows = await db
      .select({ ts: tasks.triageStatus, lm: tasks.launchMode })
      .from(tasks)
      .where(eq(tasks.id, taskId));

    expect(trows[0].ts).toBe("triaged");
    expect(trows[0].lm).toBe("auto");

    const retry = recordingLaunch();

    await promoteNextPending({ db, launchRun: retry.fn });
    expect(retry.calls).toEqual([taskId]);
  });

  it("a terminal launch failure (PRECONDITION) clears the claim AND gives up (flagged)", async () => {
    const projectId = await seedProject();
    const taskId = await seedBacklogTask(projectId, "normal");
    const failing = recordingLaunch({
      throwErr: new MaisterError("PRECONDITION", "flow disabled"),
    });

    await promoteNextPending({ db, launchRun: failing.fn });
    expect(await claimOf(taskId)).toBeNull();
    const trows = await db
      .select({ ts: tasks.triageStatus, lm: tasks.launchMode })
      .from(tasks)
      .where(eq(tasks.id, taskId));

    expect(trows[0].ts).toBe("flagged");
    expect(trows[0].lm).toBeNull();
  });
});

describe("ADR-121 unified admission gate — C3 cap-safe resume ordering (T14)", () => {
  it("AC-G3c: an answered-idle resume beats an equal-criticality fresh task (classRank resume-first)", async () => {
    const projectId = await seedProject();
    const idle = await seedIdleRun(projectId, "normal", new Date());
    const task = await seedBacklogTask(projectId, "normal");
    const launch = recordingLaunch();
    const resumed: string[] = [];

    await promoteNextPending({
      db,
      launchRun: launch.fn,
      resumeRun: (id) => resumed.push(id),
    });

    // Same weight → classRank C3 (0) < C2 (2): the resume wins the slot.
    expect(resumed).toEqual([idle]);
    expect(launch.calls).toEqual([]);
    // Codex-1: a FLOW resume lands in NeedsInput (the state the resume driver's
    // completion is guarded on), NOT Running — it still holds a slot.
    expect(await statusOf(idle)).toBe("NeedsInput");
    expect(await claimOf(task)).toBeNull();
  });

  it("a higher-criticality fresh task still beats a lower-criticality answered-idle resume", async () => {
    const projectId = await seedProject();
    const idle = await seedIdleRun(projectId, "low", new Date());
    const urgent = await seedBacklogTask(projectId, "urgent");
    const launch = recordingLaunch();
    const resumed: string[] = [];

    await promoteNextPending({
      db,
      launchRun: launch.fn,
      resumeRun: (id) => resumed.push(id),
    });

    expect(launch.calls).toEqual([urgent]);
    expect(resumed).toEqual([]);
    expect(await statusOf(idle)).toBe("NeedsInputIdle");
  });

  it("a paused task's answered-idle resume (C3) is NOT admitted (INV-10)", async () => {
    const projectId = await seedProject();
    const idle = await seedIdleRun(projectId, "high", new Date());

    // Pause the idle run's backing task.
    await db
      .update(tasks)
      .set({ queuePaused: true })
      .where(
        eq(
          tasks.id,
          (
            await db
              .select({ t: runs.taskId })
              .from(runs)
              .where(eq(runs.id, idle))
          )[0].t,
        ),
      );

    const resumed: string[] = [];

    const res = await promoteNextPending({
      db,
      resumeRun: (id) => resumed.push(id),
    });

    expect(resumed).toEqual([]);
    expect(res.promotedRunId).toBeNull();
    expect(await statusOf(idle)).toBe("NeedsInputIdle");
  });

  it("the C3 flow admission claims the slot as NeedsInput and clears resume_requested_at", async () => {
    const projectId = await seedProject();
    const idle = await seedIdleRun(projectId, "normal", new Date());
    const resumed: string[] = [];

    await promoteNextPending({ db, resumeRun: (id) => resumed.push(id) });

    expect(resumed).toEqual([idle]);
    const rows = await db
      .select({ s: runs.status, rra: runs.resumeRequestedAt })
      .from(runs)
      .where(eq(runs.id, idle));

    // Codex-1: markResumed-style claim (NeedsInput + fresh keepalive), NOT Running.
    expect(rows[0].s).toBe("NeedsInput");
    expect(rows[0].rra).toBeNull();
  });

  it("F2/INV-7: resume (C3) flows cap-safely even when edgeDrain is OFF (only C2 is gated)", async () => {
    const projectId = await seedProject({ edgeDrain: false });
    const idle = await seedIdleRun(projectId, "normal", new Date());
    const resumed: string[] = [];

    await promoteNextPending({ db, resumeRun: (id) => resumed.push(id) });

    expect(resumed).toEqual([idle]);
    expect(await statusOf(idle)).toBe("NeedsInput");
  });

  it("the agent pool admits its own C3 resume via startAgentRun (both pools cap-safe)", async () => {
    const projectId = await seedProject();
    const idle = await seedIdleRun(projectId, "high", new Date(), "agent");
    const started: string[] = [];
    const resumed: string[] = [];

    await promoteNextPending({
      db,
      pool: "agent",
      startAgentRun: (id) => started.push(id),
      resumeRun: (id) => resumed.push(id),
    });

    expect(started).toEqual([idle]);
    expect(resumed).toEqual([]); // agent C3 dispatches startAgentSession, not driveResume
    expect(await statusOf(idle)).toBe("Running");
  });

  it("INV-1: under a resume burst the gate admits at most `free` slots (one per call)", async () => {
    process.env.MAISTER_MAX_CONCURRENT_RUNS = "2";
    const projectId = await seedProject();

    await seedLiveRun(projectId); // 1 live, cap 2 → 1 free slot
    const idleRuns = [
      await seedIdleRun(projectId, "normal", new Date(Date.now() - 3000)),
      await seedIdleRun(projectId, "normal", new Date(Date.now() - 2000)),
      await seedIdleRun(projectId, "normal", new Date(Date.now() - 1000)),
    ];
    const resumed: string[] = [];

    // A burst of slot-free events all firing the gate concurrently.
    await Promise.all(
      idleRuns.map(() =>
        promoteNextPending({ db, resumeRun: (id) => resumed.push(id) }),
      ),
    );

    // Only the single free slot is filled — the cap is never exceeded. A flow
    // resume claims the slot as NeedsInput (Codex-1), so count BOTH live statuses.
    const liveCount = (
      await db
        .select({ s: runs.status })
        .from(runs)
        .where(
          and(
            eq(runs.projectId, projectId),
            inArray(runs.status, ["Running", "NeedsInput"]),
          ),
        )
    ).length;

    expect(liveCount).toBe(2); // 1 pre-existing Running + exactly 1 resumed NeedsInput
    expect(resumed).toHaveLength(1);
    // The oldest resume_requested_at won the FIFO tiebreak.
    expect(resumed[0]).toBe(idleRuns[0]);
  });

  it("INV-1 (T14 AC-G4a): flow resume burst is cap-safe with edgeDrain OFF (F2 — cap-safety is unconditional)", async () => {
    process.env.MAISTER_MAX_CONCURRENT_RUNS = "2";
    // edgeDrain off only gates the C2 fresh-task source — resume (C3) cap-safety
    // MUST still hold (gating it behind edgeDrain would reintroduce the D2 bug).
    const projectId = await seedProject({ edgeDrain: false });

    await seedLiveRun(projectId); // 1 live, cap 2 → 1 free slot
    const idleRuns = [
      await seedIdleRun(projectId, "normal", new Date(Date.now() - 3000)),
      await seedIdleRun(projectId, "normal", new Date(Date.now() - 2000)),
      await seedIdleRun(projectId, "normal", new Date(Date.now() - 1000)),
    ];
    const resumed: string[] = [];

    await Promise.all(
      idleRuns.map(() =>
        promoteNextPending({ db, resumeRun: (id) => resumed.push(id) }),
      ),
    );

    const liveCount = (
      await db
        .select({ s: runs.status })
        .from(runs)
        .where(
          and(
            eq(runs.projectId, projectId),
            inArray(runs.status, ["Running", "NeedsInput"]),
          ),
        )
    ).length;

    expect(liveCount).toBe(2); // cap never exceeded even with edgeDrain off
    expect(resumed).toHaveLength(1);
    // The two deferred resumes keep resume_requested_at set (deferred, not dropped).
    const stillQueued = await db
      .select({ id: runs.id })
      .from(runs)
      .where(
        and(
          eq(runs.projectId, projectId),
          eq(runs.status, "NeedsInputIdle"),
          isNotNull(runs.resumeRequestedAt),
        ),
      );

    expect(stillQueued).toHaveLength(2);
  });

  it("INV-1 (T14 AC-G4a): agent resume burst never exceeds the agent pool cap", async () => {
    process.env.MAISTER_MAX_CONCURRENT_AGENTS = "2";
    try {
      const projectId = await seedProject();

      // 1 live agent run holds a slot; agent cap 2 → 1 free slot.
      await db.insert(schema.runs).values({
        id: randomUUID(),
        projectId,
        runKind: "agent",
        status: "Running",
        flowVersion: "v1",
        flowRevision: "manual",
        startedAt: new Date(),
      });
      const idleRuns = [
        await seedIdleRun(
          projectId,
          "normal",
          new Date(Date.now() - 3000),
          "agent",
        ),
        await seedIdleRun(
          projectId,
          "normal",
          new Date(Date.now() - 2000),
          "agent",
        ),
        await seedIdleRun(
          projectId,
          "normal",
          new Date(Date.now() - 1000),
          "agent",
        ),
      ];
      const started: string[] = [];

      await Promise.all(
        idleRuns.map(() =>
          promoteNextPending({
            db,
            pool: "agent",
            startAgentRun: (id) => started.push(id),
          }),
        ),
      );

      const liveCount = (
        await db
          .select({ s: runs.status })
          .from(runs)
          .where(
            and(
              eq(runs.projectId, projectId),
              inArray(runs.status, ["Running", "NeedsInput", "HumanWorking"]),
            ),
          )
      ).length;

      expect(liveCount).toBe(2); // 1 pre-existing + exactly 1 admitted agent resume
      expect(started).toHaveLength(1);
      expect(started[0]).toBe(idleRuns[0]); // oldest resume_requested_at wins FIFO
    } finally {
      delete process.env.MAISTER_MAX_CONCURRENT_AGENTS;
    }
  });

  it("INV-3: two concurrent promote calls on ONE Pending run → exactly one flips to Running (C1 double-fire)", async () => {
    const projectId = await seedProject();
    const pending = await seedPendingRun(projectId, "normal");
    const dispatched: string[] = [];

    await Promise.all([
      promoteNextPending({ db, runFlow: (id) => dispatched.push(id) }),
      promoteNextPending({ db, runFlow: (id) => dispatched.push(id) }),
    ]);

    // The status-guarded Pending→Running CAS admits the run once; the loser sees it
    // already Running and dispatches nothing.
    expect(dispatched).toEqual([pending]);
    expect(await statusOf(pending)).toBe("Running");
  });

  it("INV-3: two concurrent promote calls on ONE answered-idle run → resumed exactly once (C3 double-fire)", async () => {
    const projectId = await seedProject();
    const idle = await seedIdleRun(projectId, "normal", new Date());
    const resumed: string[] = [];

    await Promise.all([
      promoteNextPending({ db, resumeRun: (id) => resumed.push(id) }),
      promoteNextPending({ db, resumeRun: (id) => resumed.push(id) }),
    ]);

    expect(resumed).toEqual([idle]);
    // The markResumed CAS cleared resume_requested_at exactly once (idempotent).
    const [row] = await db
      .select({ s: runs.status, rra: runs.resumeRequestedAt })
      .from(runs)
      .where(eq(runs.id, idle));

    expect(row.s).toBe("NeedsInput");
    expect(row.rra).toBeNull();
  });

  it("INV-3: C2 claim-then-crash — a task with a live flow run already minted is NOT double-launched", async () => {
    // Simulates the crash window (F1): a C2 claim was set, launchRun DID mint a run,
    // but the claimer crashed before clearing queue_claimed_at. A lingering stale
    // claim must never cause a second launch — the per-task live-flow-run guard
    // (hasLiveFlowRun) keeps admission exactly-once even before reconcile sweeps it.
    const projectId = await seedProject();
    const taskId = await seedBacklogTask(projectId, "high");

    // The already-minted (live) flow run for this task + a lingering claim.
    await db.insert(schema.runs).values({
      id: randomUUID(),
      projectId,
      taskId,
      runKind: "flow",
      status: "Running",
      flowVersion: "v1",
      flowRevision: "manual",
      startedAt: new Date(),
      queueAdmittedAt: new Date(),
    });
    await db
      .update(tasks)
      .set({ queueClaimedAt: new Date() })
      .where(eq(tasks.id, taskId));

    const launch = recordingLaunch();

    await promoteNextPending({ db, launchRun: launch.fn });

    expect(launch.calls).toEqual([]); // hasLiveFlowRun skipped it — no second mint
  });

  it("INV-5: triage_confidence NEVER changes an admission outcome (advisory only)", async () => {
    // Two equal-priority C2 tasks; the OLDER wins the FIFO tiebreak. Confidence is
    // advisory — swapping the confidence values must NOT change which task admits.
    async function pickWithConfidence(
      olderConf: number,
      newerConf: number,
    ): Promise<string> {
      const projectId = await seedProject();
      const older = await seedBacklogTask(projectId, "normal");
      const newer = await seedBacklogTask(projectId, "normal");

      // Pin created_at so the FIFO tiebreak is deterministic (equal-priority).
      await db
        .update(tasks)
        .set({
          triageConfidence: String(olderConf),
          createdAt: new Date(Date.now() - 2000),
        })
        .where(eq(tasks.id, older));
      await db
        .update(tasks)
        .set({
          triageConfidence: String(newerConf),
          createdAt: new Date(Date.now() - 1000),
        })
        .where(eq(tasks.id, newer));

      const launch = recordingLaunch();

      await promoteNextPending({ db, launchRun: launch.fn });
      expect(launch.calls).toHaveLength(1);

      return launch.calls[0] === older ? "older" : "newer";
    }

    // Low-confidence older vs high-confidence newer → still the older (FIFO).
    expect(await pickWithConfidence(0.01, 0.99)).toBe("older");
    // Swap the confidences → the SAME (older) task admits: confidence is inert.
    expect(await pickWithConfidence(0.99, 0.01)).toBe("older");
  });
});
