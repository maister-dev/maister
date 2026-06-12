import { randomUUID } from "node:crypto";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { eq, isNotNull } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
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
  ensureDefaultSchedulerJobs,
  reapStuckSchedulerAttempts,
  recordJobAttemptResult,
  type ClaimDueJobsInput,
} from "@/lib/scheduler/jobs";
import { runSchedulerTick } from "@/lib/scheduler/tick-service";

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));

type SchedulerTestDb = NonNullable<ClaimDueJobsInput["db"]>;

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase<typeof schema>;
let schedulerDb: SchedulerTestDb;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("scheduler_jobs_test")
    .withUsername("test")
    .withPassword("test")
    .start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool, { schema });
  schedulerDb = db as unknown as SchedulerTestDb;

  await migrate(db, { migrationsFolder: "./lib/db/migrations" });
}, 180_000);

afterEach(async () => {
  await db.delete(schema.agentSchedules);
  await db.delete(schema.schedulerJobRuns);
  await db.delete(schema.schedulerJobs);
});

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

describe("scheduler job SQL integration", () => {
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

  it("bootstraps the default system_sweep, run_schedule, webhook_delivery, domain_event_dispatch, and agent_tick jobs idempotently", async () => {
    const now = new Date("2026-06-05T10:00:00.000Z");

    await ensureDefaultSchedulerJobs({ now, db: schedulerDb });
    await ensureDefaultSchedulerJobs({ now, db: schedulerDb });

    const rows = await db
      .select()
      .from(schema.schedulerJobs)
      .where(isNotNull(schema.schedulerJobs.id));

    expect(rows).toHaveLength(5);
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
    expect(attempts[0].summary.fired).toBeDefined();
    expect(attempts[0].summary).toMatchObject({
      fired: 0,
      skippedBusy: 0,
      skippedCap: 0,
      skippedTerminal: 0,
      catchupQueued: 0,
      launchFailed: 0,
      truncated: false,
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
