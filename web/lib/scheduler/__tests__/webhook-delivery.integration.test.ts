import { randomUUID } from "node:crypto";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { testPlatformRunnerRow } from "@/lib/__tests__/runner-fixtures";
import * as schema from "@/lib/db/schema";
import { runWebhookDeliveryJob } from "@/lib/scheduler/handlers/webhook-delivery";
import {
  claimDueJobs,
  ensureDefaultSchedulerJobs,
  type ClaimDueJobsInput,
} from "@/lib/scheduler/jobs";

type SchedulerTestDb = NonNullable<ClaimDueJobsInput["db"]>;

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;
let schedulerDb: SchedulerTestDb;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("scheduler_webhook_delivery_test")
    .withUsername("test")
    .withPassword("test")
    .start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);
  schedulerDb = db as unknown as SchedulerTestDb;

  await migrate(db, { migrationsFolder: "./lib/db/migrations" });
}, 180_000);

afterEach(async () => {
  await db.delete(schema.schedulerJobRuns);
  await db.delete(schema.schedulerJobs);
  await db.delete(schema.platformRuntimeSettings);
  await db.delete(schema.platformAcpRunners);
});

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

describe("webhook_delivery scheduler integration", () => {
  it("seeds exactly one webhook_delivery.default job at 60s cadence", async () => {
    const now = new Date("2026-06-05T10:00:00.000Z");

    await ensureDefaultSchedulerJobs({ now, db: schedulerDb });
    await ensureDefaultSchedulerJobs({ now, db: schedulerDb });

    const rows = await db
      .select()
      .from(schema.schedulerJobs)
      .where(eq(schema.schedulerJobs.jobKind, "webhook_delivery"));

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: "webhook_delivery.default",
      jobKind: "webhook_delivery",
      cadenceIntervalSeconds: 60,
      nextRunAt: now,
    });
  });

  it("claims the seeded webhook_delivery job exactly once under two concurrent ticks", async () => {
    const now = new Date("2026-06-05T10:00:00.000Z");

    await ensureDefaultSchedulerJobs({ now, db: schedulerDb });

    const [first, second] = await Promise.all([
      claimDueJobs({ now, jobKind: "webhook_delivery", db: schedulerDb }),
      claimDueJobs({ now, jobKind: "webhook_delivery", db: schedulerDb }),
    ]);

    const claimedDeliveryJobs = [...first, ...second].filter(
      (job) => job.jobKind === "webhook_delivery",
    );

    expect(claimedDeliveryJobs).toHaveLength(1);
    expect(claimedDeliveryJobs[0].id).toBe("webhook_delivery.default");
  });

  it("no-ops with skipped:disabled when platform_runtime_settings.webhooksEnabled is false", async () => {
    await seedRuntimeSettings(false);

    const summary = await runWebhookDeliveryJob({ db: schedulerDb });

    expect(summary).toEqual({
      skipped: "disabled",
      fanout: 0,
      delivered: 0,
      failed: 0,
      dead: 0,
      pruned: 0,
    });
  });

  it("returns a zero-count summary (not skipped) when webhooksEnabled is true", async () => {
    await seedRuntimeSettings(true);

    const summary = await runWebhookDeliveryJob({ db: schedulerDb });

    expect(summary).toEqual({
      fanout: 0,
      delivered: 0,
      failed: 0,
      dead: 0,
      pruned: 0,
    });
  });
});

async function seedRuntimeSettings(webhooksEnabled: boolean): Promise<void> {
  const runnerId = randomUUID();

  // FIXME(any): dual drizzle-orm peer-dep variants — importing the scheduler
  // handler pulls the second drizzle pg-core into scope, so the shared runner
  // fixture's column shape no longer matches this builder's insert model.
  await db
    .insert(schema.platformAcpRunners)
    .values(testPlatformRunnerRow(runnerId, "claude") as never);

  await db.insert(schema.platformRuntimeSettings).values({
    id: "singleton",
    defaultRunnerId: runnerId,
    webhooksEnabled,
  });
}
