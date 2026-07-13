import { eq } from "drizzle-orm";
import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import * as schema from "@/lib/db/schema";
import {
  claimDueJobs,
  ensureDefaultSchedulerJobs,
  type ClaimDueJobsInput,
} from "@/lib/scheduler/jobs";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

// =============================================================================
// T-D8 (ADR-086): the domain_event_dispatch singleton joins the scheduler the
// same way webhook_delivery.default did — self-healing seed, 60s cadence,
// budget-1 single claim under concurrent ticks.
// =============================================================================

type SchedulerTestDb = NonNullable<ClaimDueJobsInput["db"]>;

let testDatabase: StartedPostgresTestDb;
let db: NodePgDatabase;
let schedulerDb: SchedulerTestDb;

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "scheduler_domain_event_dispatch_test",
  });
  db = testDatabase.db;
  schedulerDb = db as unknown as SchedulerTestDb;
}, 180_000);

afterEach(async () => {
  await db.delete(schema.schedulerJobRuns);
  await db.delete(schema.schedulerJobs);
});

afterAll(async () => {
  await testDatabase?.stop();
});

describe("domain_event_dispatch scheduler integration", () => {
  it("seeds exactly one domain_event_dispatch.default job at 60s cadence", async () => {
    const now = new Date("2026-06-11T10:00:00.000Z");

    await ensureDefaultSchedulerJobs({ now, db: schedulerDb });
    await ensureDefaultSchedulerJobs({ now, db: schedulerDb });

    const rows = await db
      .select()
      .from(schema.schedulerJobs)
      .where(eq(schema.schedulerJobs.jobKind, "domain_event_dispatch"));

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: "domain_event_dispatch.default",
      jobKind: "domain_event_dispatch",
      cadenceIntervalSeconds: 60,
      nextRunAt: now,
    });
  });

  it("claims the seeded dispatcher exactly once under two concurrent ticks", async () => {
    const now = new Date("2026-06-11T10:00:00.000Z");

    await ensureDefaultSchedulerJobs({ now, db: schedulerDb });

    const [first, second] = await Promise.all([
      claimDueJobs({ now, jobKind: "domain_event_dispatch", db: schedulerDb }),
      claimDueJobs({ now, jobKind: "domain_event_dispatch", db: schedulerDb }),
    ]);

    const claimed = [...first, ...second].filter(
      (job) => job.jobKind === "domain_event_dispatch",
    );

    expect(claimed).toHaveLength(1);
    expect(claimed[0].id).toBe("domain_event_dispatch.default");
  });
});
