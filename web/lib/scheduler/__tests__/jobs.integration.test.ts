import { randomUUID } from "node:crypto";

import { eq, isNotNull } from "drizzle-orm";
import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import * as schema from "@/lib/db/schema";
import {
  claimDueJobs,
  disableArchivedPrStateScanJobs,
  DEFAULT_SYSTEM_SWEEP_JOB_ID,
  disableArchivedRepoDeliveryScanJobs,
  ensureDefaultSchedulerJobs,
  ensurePrStateScanJobs,
  ensureRepoDeliveryScanJobs,
  reapStuckSchedulerAttempts,
  recordJobAttemptResult,
  requestSchedulerJobNow,
  type ClaimDueJobsInput,
} from "@/lib/scheduler/jobs";
import {
  requestSystemSweep,
  runSchedulerTick,
} from "@/lib/scheduler/tick-service";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));

const runSystemSweepMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/scheduler/system-sweeps", () => ({
  runSystemSweep: runSystemSweepMock,
}));

type SchedulerTestDb = NonNullable<ClaimDueJobsInput["db"]>;

let testDatabase: StartedPostgresTestDb;
let db: NodePgDatabase<typeof schema>;
let schedulerDb: SchedulerTestDb;

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "scheduler_jobs_test",
  });
  db = testDatabase.db;
  schedulerDb = db as unknown as SchedulerTestDb;
}, 180_000);

afterEach(async () => {
  runSystemSweepMock.mockReset();
  await db.delete(schema.agentSchedules);
  await db.delete(schema.schedulerJobRuns);
  await db.delete(schema.schedulerJobs);
  await db.delete(schema.projects);
});

afterAll(async () => {
  await testDatabase?.stop();
});

describe("scheduler job SQL integration", () => {
  it("seeds an active project scan, claims its database project id, and re-enables it after unarchive", async () => {
    const now = new Date("2026-06-05T10:00:00.000Z");
    const projectId = randomUUID();

    await db.insert(schema.projects).values({
      id: projectId,
      slug: `scan-${projectId.slice(0, 8)}`,
      name: "Scan project",
      repoPath: `/repos/${projectId}`,
      taskKey: `SCAN${projectId.replaceAll("-", "").slice(0, 8).toUpperCase()}`,
    });
    await ensureRepoDeliveryScanJobs({ now, db: schedulerDb });

    const claimed = await claimDueJobs({
      now,
      jobKind: "repo_delivery_scan",
      db: schedulerDb,
    });

    expect(claimed).toHaveLength(1);
    expect(claimed[0]).toMatchObject({
      id: `repo_delivery_scan.${projectId}`,
      jobKind: "repo_delivery_scan",
      projectId,
      target: { projectId },
    });

    await db
      .update(schema.projects)
      .set({ archivedAt: now })
      .where(eq(schema.projects.id, projectId));
    await disableArchivedRepoDeliveryScanJobs({ now, db: schedulerDb });

    let job = (
      await db
        .select()
        .from(schema.schedulerJobs)
        .where(eq(schema.schedulerJobs.id, `repo_delivery_scan.${projectId}`))
    )[0];

    expect(job.disabledAt).toEqual(now);

    await db
      .update(schema.projects)
      .set({ archivedAt: null })
      .where(eq(schema.projects.id, projectId));
    await ensureRepoDeliveryScanJobs({ now, db: schedulerDb });

    job = (
      await db
        .select()
        .from(schema.schedulerJobs)
        .where(eq(schema.schedulerJobs.id, `repo_delivery_scan.${projectId}`))
    )[0];
    expect(job.disabledAt).toBeNull();
    expect(job.consecutiveFailures).toBe(0);
  });

  it("seeds an active project pr-state scan, claims its database project id, and re-enables it after unarchive", async () => {
    const now = new Date("2026-06-05T10:00:00.000Z");
    const projectId = randomUUID();

    await db.insert(schema.projects).values({
      id: projectId,
      slug: `scan-${projectId.slice(0, 8)}`,
      name: "PR-state scan project",
      repoPath: `/repos/${projectId}`,
      taskKey: `SCAN${projectId.replaceAll("-", "").slice(0, 8).toUpperCase()}`,
    });
    await ensurePrStateScanJobs({ now, db: schedulerDb });

    const claimed = await claimDueJobs({
      now,
      jobKind: "pr_state_scan",
      db: schedulerDb,
    });

    expect(claimed).toHaveLength(1);
    expect(claimed[0]).toMatchObject({
      id: `pr_state_scan.${projectId}`,
      jobKind: "pr_state_scan",
      projectId,
      target: { projectId },
    });

    await db
      .update(schema.projects)
      .set({ archivedAt: now })
      .where(eq(schema.projects.id, projectId));
    await disableArchivedPrStateScanJobs({ now, db: schedulerDb });

    let job = (
      await db
        .select()
        .from(schema.schedulerJobs)
        .where(eq(schema.schedulerJobs.id, `pr_state_scan.${projectId}`))
    )[0];

    expect(job.disabledAt).toEqual(now);

    await db
      .update(schema.projects)
      .set({ archivedAt: null })
      .where(eq(schema.projects.id, projectId));
    await ensurePrStateScanJobs({ now, db: schedulerDb });

    job = (
      await db
        .select()
        .from(schema.schedulerJobs)
        .where(eq(schema.schedulerJobs.id, `pr_state_scan.${projectId}`))
    )[0];
    expect(job.disabledAt).toBeNull();
    expect(job.consecutiveFailures).toBe(0);
  });

  it("preserves a poison-disabled scan while seeding active projects", async () => {
    const now = new Date("2026-06-05T10:00:00.000Z");
    const projectId = randomUUID();

    await db.insert(schema.projects).values({
      id: projectId,
      slug: `scan-${projectId.slice(0, 8)}`,
      name: "Poisoned scan project",
      repoPath: `/repos/${projectId}`,
      taskKey: `SCAN${projectId.replaceAll("-", "").slice(0, 8).toUpperCase()}`,
    });
    await ensureRepoDeliveryScanJobs({ now, db: schedulerDb });
    await db
      .update(schema.schedulerJobs)
      .set({ disabledAt: now, consecutiveFailures: 3 })
      .where(eq(schema.schedulerJobs.id, `repo_delivery_scan.${projectId}`));

    await ensureRepoDeliveryScanJobs({ now, db: schedulerDb });

    const job = (
      await db
        .select()
        .from(schema.schedulerJobs)
        .where(eq(schema.schedulerJobs.id, `repo_delivery_scan.${projectId}`))
    )[0];

    expect(job.disabledAt).toEqual(now);
    expect(job.consecutiveFailures).toBe(3);
  });

  // #M9: `ensurePrStateScanJobs` was cloned from the repo_delivery_scan seeder,
  // but its poison test was not — the clone above only covers the unarchive
  // re-enable, which is the SAME `ON CONFLICT DO UPDATE` minus the guard that
  // matters. Delete `consecutive_failures < max_failures` from jobs.ts and the
  // pr_state_scan clone still passes, while every seed tick silently re-enables a
  // poison-disabled scan: retry-forever, which ADR-140 explicitly forbids.
  it("(#M9) preserves a poison-disabled PR-state scan while seeding active projects", async () => {
    const now = new Date("2026-06-05T10:00:00.000Z");
    const projectId = randomUUID();

    await db.insert(schema.projects).values({
      id: projectId,
      slug: `scan-${projectId.slice(0, 8)}`,
      name: "Poisoned pr-state scan project",
      repoPath: `/repos/${projectId}`,
      taskKey: `SCAN${projectId.replaceAll("-", "").slice(0, 8).toUpperCase()}`,
    });
    await ensurePrStateScanJobs({ now, db: schedulerDb });

    // Poisoned: disabled having burned its whole retry budget. The project is
    // NOT archived, so every seed tick reconsiders this row.
    await db
      .update(schema.schedulerJobs)
      .set({ disabledAt: now, consecutiveFailures: 3 })
      .where(eq(schema.schedulerJobs.id, `pr_state_scan.${projectId}`));

    await ensurePrStateScanJobs({ now, db: schedulerDb });

    const job = (
      await db
        .select()
        .from(schema.schedulerJobs)
        .where(eq(schema.schedulerJobs.id, `pr_state_scan.${projectId}`))
    )[0];

    expect(job.disabledAt).toEqual(now);
    expect(job.consecutiveFailures).toBe(3);
  });

  it("two overlapping claims for one due job create exactly one attempt", async () => {
    const now = new Date("2026-06-05T10:00:00.000Z");
    const jobId = await insertSchedulerJob({
      jobKind: "system_sweep",
      nextRunAt: now,
    });

    const [first, second] = await Promise.all([
      claimDueJobs({ now, db: schedulerDb }),
      claimDueJobs({ now, db: schedulerDb }),
    ]);
    const attempts = await db
      .select()
      .from(schema.schedulerJobRuns)
      .where(eq(schema.schedulerJobRuns.jobId, jobId));

    expect(first.length + second.length).toBe(1);
    expect(attempts).toHaveLength(1);
  });

  it("fires one catch-up attempt and advances overdue next_run_at to the future", async () => {
    const now = new Date("2026-06-05T10:17:30.000Z");

    await insertSchedulerJob({
      jobKind: "system_sweep",
      nextRunAt: new Date("2026-06-05T10:00:00.000Z"),
      cadenceIntervalSeconds: 300,
    });

    const claimed = await claimDueJobs({ now, db: schedulerDb });

    expect(claimed).toHaveLength(1);
    expect(claimed[0].previousNextRunAt.toISOString()).toBe(
      "2026-06-05T10:00:00.000Z",
    );
    expect(claimed[0].nextRunAt.toISOString()).toBe("2026-06-05T10:20:00.000Z");
  });

  it("blocks an unexpired lease, reaps an expired lease, then allows reclaim", async () => {
    const now = new Date("2026-06-05T10:00:00.000Z");

    await insertSchedulerJob({
      jobKind: "system_sweep",
      nextRunAt: now,
      cadenceIntervalSeconds: 60,
    });

    const first = await claimDueJobs({
      now,
      leaseSeconds: 60,
      db: schedulerDb,
    });
    const blocked = await claimDueJobs({ now, db: schedulerDb });
    const reapAt = new Date("2026-06-05T10:01:01.000Z");
    const reaped = await reapStuckSchedulerAttempts({
      now: reapAt,
      db: schedulerDb,
    });
    const reclaimed = await claimDueJobs({ now: reapAt, db: schedulerDb });

    expect(first).toHaveLength(1);
    expect(blocked).toHaveLength(0);
    expect(reaped).toEqual([
      { attemptId: first[0].attemptId, jobId: first[0].id },
    ]);
    expect(reclaimed).toHaveLength(1);
    expect(reclaimed[0].id).toBe(first[0].id);
  });

  it("applies command and agent budgets before claiming due jobs", async () => {
    const oldCommands = process.env.MAISTER_MAX_CONCURRENT_COMMANDS;
    const oldAgents = process.env.MAISTER_MAX_CONCURRENT_AGENTS;

    process.env.MAISTER_MAX_CONCURRENT_COMMANDS = "1";
    process.env.MAISTER_MAX_CONCURRENT_AGENTS = "1";

    try {
      const now = new Date("2026-06-05T10:00:00.000Z");

      await insertSchedulerJob({ jobKind: "command", nextRunAt: now });
      await insertSchedulerJob({ jobKind: "command", nextRunAt: now });
      await insertSchedulerJob({ jobKind: "agent_tick", nextRunAt: now });
      await insertSchedulerJob({ jobKind: "agent_tick", nextRunAt: now });

      const claimed = await claimDueJobs({ now, db: schedulerDb });

      expect(claimed.filter((job) => job.jobKind === "command")).toHaveLength(
        1,
      );
      expect(
        claimed.filter((job) => job.jobKind === "agent_tick"),
      ).toHaveLength(1);
    } finally {
      restoreEnv("MAISTER_MAX_CONCURRENT_COMMANDS", oldCommands);
      restoreEnv("MAISTER_MAX_CONCURRENT_AGENTS", oldAgents);
    }
  });

  it("disables repeated agent_tick precondition skips using the env max-failure knob", async () => {
    const oldMaxFailures =
      process.env.MAISTER_SCHEDULER_AGENT_TICK_MAX_FAILURES;

    process.env.MAISTER_SCHEDULER_AGENT_TICK_MAX_FAILURES = "2";

    try {
      const firstAt = new Date("2026-06-05T10:00:00.000Z");
      const secondAt = new Date("2026-06-05T10:01:00.000Z");
      const jobId = await insertSchedulerJob({
        jobKind: "agent_tick",
        nextRunAt: firstAt,
        cadenceIntervalSeconds: 60,
        maxFailures: 99,
      });
      const first = await claimDueJobs({ now: firstAt, db: schedulerDb });

      await recordJobAttemptResult({
        jobId,
        attemptId: first[0].attemptId,
        status: "Skipped",
        errorCode: "PRECONDITION",
        now: firstAt,
        db: schedulerDb,
      });

      const second = await claimDueJobs({ now: secondAt, db: schedulerDb });

      await recordJobAttemptResult({
        jobId,
        attemptId: second[0].attemptId,
        status: "Skipped",
        errorCode: "PRECONDITION",
        now: secondAt,
        db: schedulerDb,
      });

      const rows = await db
        .select()
        .from(schema.schedulerJobs)
        .where(eq(schema.schedulerJobs.id, jobId));

      expect(rows[0].consecutiveFailures).toBe(2);
      expect(rows[0].disabledAt).toEqual(secondAt);
    } finally {
      restoreEnv("MAISTER_SCHEDULER_AGENT_TICK_MAX_FAILURES", oldMaxFailures);
    }
  });

  it("ignores stale handler completion after an expired lease was reaped", async () => {
    const now = new Date("2026-06-05T10:00:00.000Z");
    const reapAt = new Date("2026-06-05T10:01:01.000Z");
    const jobId = await insertSchedulerJob({
      jobKind: "system_sweep",
      nextRunAt: now,
      cadenceIntervalSeconds: 60,
    });
    const claimed = await claimDueJobs({
      now,
      leaseSeconds: 60,
      db: schedulerDb,
    });

    await reapStuckSchedulerAttempts({ now: reapAt, db: schedulerDb });
    await recordJobAttemptResult({
      jobId,
      attemptId: claimed[0].attemptId,
      status: "Succeeded",
      now: reapAt,
      db: schedulerDb,
    });

    const attempts = await db
      .select()
      .from(schema.schedulerJobRuns)
      .where(eq(schema.schedulerJobRuns.id, claimed[0].attemptId));
    const jobs = await db
      .select()
      .from(schema.schedulerJobs)
      .where(eq(schema.schedulerJobs.id, jobId));

    expect(attempts[0].status).toBe("Failed");
    expect(attempts[0].errorCode).toBe("LEASE_EXPIRED");
    expect(jobs[0].consecutiveFailures).toBe(1);
  });

  it("bootstraps the default system_sweep, run_schedule, webhook_delivery, domain_event_dispatch, agent_tick, auto_launch_triaged, auto_promote, evaluation_dispatch, and evaluation_suite_scan jobs idempotently", async () => {
    const now = new Date("2026-06-05T10:00:00.000Z");

    await ensureDefaultSchedulerJobs({ now, db: schedulerDb });
    await ensureDefaultSchedulerJobs({ now, db: schedulerDb });

    const rows = await db
      .select()
      .from(schema.schedulerJobs)
      .where(isNotNull(schema.schedulerJobs.id));

    expect(rows).toHaveLength(9);
    expect(
      rows.find((row) => row.id === "evaluation_dispatch.dispatcher"),
    ).toMatchObject({
      jobKind: "evaluation_dispatch",
      cadenceIntervalSeconds: 60,
      maxFailures: 3,
      nextRunAt: now,
    });
    expect(
      rows.find((row) => row.id === "evaluation_suite_scan.dispatcher"),
    ).toMatchObject({
      jobKind: "evaluation_suite_scan",
      cadenceIntervalSeconds: 60,
      maxFailures: 3,
      nextRunAt: now,
    });
    expect(rows.find((row) => row.id === "system_sweep.default")).toMatchObject(
      {
        jobKind: "system_sweep",
        cadenceIntervalSeconds: 60,
        nextRunAt: now,
      },
    );
    expect(
      rows.find((row) => row.id === "run_schedule.dispatcher"),
    ).toMatchObject({
      jobKind: "run_schedule",
      cadenceIntervalSeconds: 60,
      maxFailures: 3,
      nextRunAt: now,
    });
    expect(
      rows.find((row) => row.id === "webhook_delivery.default"),
    ).toMatchObject({
      jobKind: "webhook_delivery",
      cadenceIntervalSeconds: 60,
      maxFailures: 3,
      nextRunAt: now,
    });
    expect(
      rows.find((row) => row.id === "domain_event_dispatch.default"),
    ).toMatchObject({
      jobKind: "domain_event_dispatch",
      cadenceIntervalSeconds: 60,
      maxFailures: 3,
      nextRunAt: now,
    });
    expect(
      rows.find((row) => row.id === "agent_tick.dispatcher"),
    ).toMatchObject({
      jobKind: "agent_tick",
      cadenceIntervalSeconds: 60,
      maxFailures: 3,
      nextRunAt: now,
    });
    expect(
      rows.find((row) => row.id === "auto_launch_triaged.default"),
    ).toMatchObject({
      jobKind: "auto_launch_triaged",
      cadenceIntervalSeconds: 60,
      maxFailures: 3,
      nextRunAt: now,
    });
    expect(rows.find((row) => row.id === "auto_promote.default")).toMatchObject(
      {
        jobKind: "auto_promote",
        cadenceIntervalSeconds: 60,
        maxFailures: 3,
        nextRunAt: now,
      },
    );
  });

  it("requests an enabled system sweep through its durable scheduler claim and persists its summary", async () => {
    runSystemSweepMock.mockResolvedValue({
      keepalive: { idled: 0 },
      reconcile: { reconciled: 0 },
      cost: { candidates: 0, reconciled: 0 },
      workspace: null,
      workspaceReconciliation: null,
      revision: null,
      capabilities: null,
      ephemeralAgent: null,
      agentMaterialization: null,
      plainAgentDirectory: null,
      brain: null,
      brainReindex: null,
      worktreesPreserved: 0,
      worktreesRemoved: 0,
      revisionsRemoved: 0,
      errors: [],
      bundleErrors: [],
    });

    const tick = await requestSystemSweep();

    expect(tick).toMatchObject({ claimedCount: 1, succeededCount: 1 });
    expect(runSystemSweepMock).toHaveBeenCalledOnce();

    const attempts = await db
      .select()
      .from(schema.schedulerJobRuns)
      .where(eq(schema.schedulerJobRuns.jobId, DEFAULT_SYSTEM_SWEEP_JOB_ID));

    expect(attempts).toHaveLength(1);
    expect(attempts[0].summary).toMatchObject({
      workspaceReconciliation: null,
      errors: [],
    });
  });

  it("keeps a long system sweep claimed until its completion is durably fenced", async () => {
    const previousTimeout =
      process.env.MAISTER_SCHEDULER_ATTEMPT_TIMEOUT_SECONDS;

    process.env.MAISTER_SCHEDULER_ATTEMPT_TIMEOUT_SECONDS = "1";
    let releaseSweep = (): void => {
      throw new Error("system sweep release callback was not initialized");
    };

    runSystemSweepMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseSweep = () =>
            resolve({
              keepalive: null,
              reconcile: null,
              syncRecovery: null,
              cost: null,
              workspace: null,
              workspaceReconciliation: null,
              revision: null,
              capabilities: null,
              ephemeralAgent: null,
              agentMaterialization: null,
              plainAgentDirectory: null,
              brain: null,
              brainReindex: null,
              worktreesPreserved: 0,
              worktreesRemoved: 0,
              revisionsRemoved: 0,
              errors: [],
              bundleErrors: [],
            });
        }),
    );

    try {
      const tick = runSchedulerTick({ jobKind: "system_sweep" });

      await vi.waitFor(() => expect(runSystemSweepMock).toHaveBeenCalledOnce());
      await new Promise<void>((resolve) => setTimeout(resolve, 1_200));
      await requestSchedulerJobNow({
        jobId: DEFAULT_SYSTEM_SWEEP_JOB_ID,
        now: new Date(),
        db: schedulerDb,
      });

      const overlapping = await claimDueJobs({
        jobKind: "system_sweep",
        now: new Date(),
        db: schedulerDb,
      });

      expect(overlapping).toHaveLength(0);
      releaseSweep();
      await expect(tick).resolves.toMatchObject({ succeededCount: 1 });
    } finally {
      restoreEnv("MAISTER_SCHEDULER_ATTEMPT_TIMEOUT_SECONDS", previousTimeout);
    }
  }, 10_000);

  it("records a system sweep with bundle failures as a failed scheduler attempt", async () => {
    runSystemSweepMock.mockResolvedValue({
      keepalive: null,
      reconcile: null,
      syncRecovery: null,
      cost: null,
      workspace: null,
      workspaceReconciliation: null,
      revision: null,
      capabilities: null,
      ephemeralAgent: null,
      agentMaterialization: null,
      plainAgentDirectory: null,
      brain: null,
      brainReindex: null,
      worktreesPreserved: 0,
      worktreesRemoved: 0,
      revisionsRemoved: 0,
      errors: ["workspace reconciliation sweep failed: database unavailable"],
      bundleErrors: [
        "workspace reconciliation sweep failed: database unavailable",
      ],
    });

    const tick = await requestSystemSweep();
    const attempt = (
      await db
        .select()
        .from(schema.schedulerJobRuns)
        .where(eq(schema.schedulerJobRuns.jobId, DEFAULT_SYSTEM_SWEEP_JOB_ID))
    )[0];

    expect(tick).toMatchObject({ failedCount: 1, succeededCount: 0 });
    expect(attempt).toMatchObject({
      status: "Failed",
      errorCode: "SYSTEM_SWEEP_FAILED",
    });
  });

  it("makes an enabled scheduler job due without bypassing its claim", async () => {
    const now = new Date("2026-06-05T10:00:00.000Z");
    const future = new Date("2026-06-06T10:00:00.000Z");

    await ensureDefaultSchedulerJobs({ now, db: schedulerDb });
    await db
      .update(schema.schedulerJobs)
      .set({ nextRunAt: future })
      .where(eq(schema.schedulerJobs.id, DEFAULT_SYSTEM_SWEEP_JOB_ID));

    await requestSchedulerJobNow({
      jobId: DEFAULT_SYSTEM_SWEEP_JOB_ID,
      now,
      db: schedulerDb,
    });

    const job = (
      await db
        .select()
        .from(schema.schedulerJobs)
        .where(eq(schema.schedulerJobs.id, DEFAULT_SYSTEM_SWEEP_JOB_ID))
    )[0];

    expect(job.nextRunAt).toEqual(now);
    const claimed = await claimDueJobs({
      now,
      jobKind: "system_sweep",
      db: schedulerDb,
    });

    expect(claimed).toHaveLength(1);
  });
});

describe("run_schedule dispatcher tick", () => {
  it("runs the claimed dispatcher job and persists the dispatch summary", async () => {
    const tick = await runSchedulerTick({ jobKind: "run_schedule" });

    expect(tick.claimedCount).toBe(1);
    expect(tick.succeededCount).toBe(1);
    expect(tick.attempts[0]).toMatchObject({
      jobId: "run_schedule.dispatcher",
      jobKind: "run_schedule",
      status: "Succeeded",
    });

    const attempts = await db
      .select()
      .from(schema.schedulerJobRuns)
      .where(eq(schema.schedulerJobRuns.jobId, "run_schedule.dispatcher"));

    expect(attempts).toHaveLength(1);
    expect(attempts[0].status).toBe("Succeeded");
    expect(attempts[0].jobKind).toBe("run_schedule");
    expect(attempts[0].summary).toMatchObject({
      recurring: {
        fired: 0,
        skippedBusy: 0,
        skippedCap: 0,
        skippedTerminal: 0,
        catchupQueued: 0,
        launchFailed: 0,
        truncated: false,
      },
      oneTime: {
        claimed: 0,
        failed: 0,
        late: 0,
        launched: 0,
        recovered: 0,
        retried: 0,
        scanned: 0,
        truncated: false,
      },
    });
  });
});

async function insertSchedulerJob(args: {
  jobKind: schema.SchedulerJobKind;
  nextRunAt: Date;
  cadenceIntervalSeconds?: number;
  maxFailures?: number;
}): Promise<string> {
  const id = randomUUID();

  await db.insert(schema.schedulerJobs).values({
    id,
    jobKind: args.jobKind,
    target: {},
    cadenceIntervalSeconds: args.cadenceIntervalSeconds ?? 60,
    nextRunAt: args.nextRunAt,
    maxFailures: args.maxFailures ?? 3,
  });

  return id;
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];

    return;
  }

  process.env[name] = value;
}
