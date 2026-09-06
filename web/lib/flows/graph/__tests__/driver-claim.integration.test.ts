import type { Db } from "@/lib/execution-host/db";
import type { StartedPostgresTestDb } from "@/test-support/pg-container";

import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { executionAssignments, runs, tasks } from "@/lib/db/schema";
import {
  claimFlowDriver,
  FlowDriverClaimLost,
  releaseFlowDriverClaim,
  renewFlowDriverClaim,
} from "@/lib/flows/graph/driver-claim";
import { flowDriverDatabase } from "@/lib/flows/graph/driver-db";
import { releaseAssignmentForRun } from "@/lib/execution-host/assignments";
import { boundedPostgresTransaction } from "@/lib/execution-host/events/projection-transaction";
import { seedGraphRun } from "@/test-support/graph-run-seed";
import { fakeExecutionHosts } from "@/test-support/fake-execution-host";
import { startMainPostgresTestDb } from "@/test-support/pg-container";

let database: StartedPostgresTestDb;
let db: Db;

beforeAll(async () => {
  database = await startMainPostgresTestDb({
    databaseName: "flow_driver_claims",
  });
  db = database.db as unknown as Db;
}, 180_000);

afterAll(async () => {
  await database?.stop();
});

async function seedClaim() {
  const seeded = await seedGraphRun(database.db, {
    schemaVersion: 1,
    name: "driver-claim",
    nodes: [
      {
        id: "work",
        type: "cli",
        action: { command: "true" },
        transitions: { success: "done" },
      },
    ],
  });
  const { assignment } = await fakeExecutionHosts(db, { runId: seeded.runId });

  if (!assignment) throw new Error("seeded assignment missing");

  return { runId: seeded.runId, assignmentId: assignment.id };
}

describe("Flow traversal database fences", () => {
  it("admits one concurrent driver and preserves Drizzle join row modes and date parsers", async () => {
    const input = await seedClaim();
    const claims = await Promise.all([
      claimFlowDriver(db, input),
      claimFlowDriver(db, input),
    ]);
    const winners = claims.filter((claim) => claim !== null);

    expect(winners).toHaveLength(1);
    const driver = flowDriverDatabase(db, winners[0]!);

    await driver
      .update(runs)
      .set({ currentStepId: "work" })
      .where(eq(runs.id, input.runId));
    const [row] = await driver
      .select({ run: runs, task: tasks })
      .from(runs)
      .innerJoin(tasks, eq(tasks.id, runs.taskId))
      .where(eq(runs.id, input.runId));

    expect(row.run).toMatchObject({ id: input.runId, currentStepId: "work" });
    expect(row.run.startedAt).toBeInstanceOf(Date);
    expect(row.task.id).toBe(row.run.taskId);
    await renewFlowDriverClaim(db, winners[0]!);
    await releaseFlowDriverClaim(db, winners[0]!);
  });

  it("rolls back nested graph writes together", async () => {
    const input = await seedClaim();
    const claim = await claimFlowDriver(db, input);

    if (!claim) throw new Error("driver claim missing");
    const driver = flowDriverDatabase(db, claim);

    await expect(
      driver.transaction(async (tx) => {
        await tx
          .update(runs)
          .set({ currentStepId: "outer" })
          .where(eq(runs.id, input.runId));
        await tx.transaction(async (nested) => {
          await nested
            .update(runs)
            .set({ currentStepId: "nested" })
            .where(eq(runs.id, input.runId));
        });
        throw new Error("rollback complete continuation");
      }),
    ).rejects.toThrow("rollback complete continuation");
    const [run] = await db.select().from(runs).where(eq(runs.id, input.runId));

    expect(run.currentStepId).toBeNull();
    await releaseFlowDriverClaim(db, claim);
  });

  it("rejects a stale driver and its cleanup after actual lease expiry and successor claim", async () => {
    const input = await seedClaim();
    const original = await claimFlowDriver(db, input);

    if (!original) throw new Error("driver claim missing");
    const stale = flowDriverDatabase(db, original);

    await database.pool.query(
      "SELECT pg_sleep(greatest(0, extract(epoch from flow_driver_lease_expires_at - clock_timestamp())) + 0.05) FROM runs WHERE id = $1",
      [input.runId],
    );
    const successor = await claimFlowDriver(db, input);

    expect(successor).not.toBeNull();
    await expect(
      stale
        .update(runs)
        .set({ currentStepId: "stale" })
        .where(eq(runs.id, input.runId)),
    ).rejects.toThrow(FlowDriverClaimLost);
    await expect(renewFlowDriverClaim(db, original)).rejects.toThrow(
      FlowDriverClaimLost,
    );
    await releaseFlowDriverClaim(db, original);
    const [run] = await db.select().from(runs).where(eq(runs.id, input.runId));

    expect(run.flowDriverToken).toBe(successor!.token);
    expect(run.currentStepId).toBeNull();
    await releaseFlowDriverClaim(db, successor!);
  }, 45_000);

  it("rolls back a continuation whose lease expires while it holds the run lock", async () => {
    const input = await seedClaim();
    const claim = await claimFlowDriver(db, input);

    if (!claim) throw new Error("driver claim missing");
    const driver = flowDriverDatabase(db, claim);

    await database.pool.query(
      "SELECT pg_sleep(greatest(0, extract(epoch from flow_driver_lease_expires_at - clock_timestamp()) - 1.5)) FROM runs WHERE id = $1",
      [input.runId],
    );
    await expect(
      driver.transaction(async (tx) => {
        await tx
          .update(runs)
          .set({ currentStepId: "expired" })
          .where(eq(runs.id, input.runId));
        await tx.execute(sql`SELECT pg_sleep(2)`);
      }),
    ).rejects.toThrow(FlowDriverClaimLost);
    const [run] = await db.select().from(runs).where(eq(runs.id, input.runId));

    expect(run.currentStepId).toBeNull();
    await releaseFlowDriverClaim(db, claim);
  }, 45_000);

  it("allows its own terminal transaction to release the execution assignment", async () => {
    const input = await seedClaim();
    const claim = await claimFlowDriver(db, input);

    if (!claim) throw new Error("driver claim missing");
    await flowDriverDatabase(db, claim).transaction(async (tx) => {
      await tx
        .update(runs)
        .set({ status: "Review" })
        .where(eq(runs.id, input.runId));
      await releaseAssignmentForRun(tx, input.runId, "run_terminal");
    });
    const [assignment] = await db
      .select()
      .from(executionAssignments)
      .where(eq(executionAssignments.id, input.assignmentId));

    expect(assignment.state).toBe("released");
    await releaseFlowDriverClaim(db, claim);
  });

  it("closes the raw query bridge when its transaction callback returns", async () => {
    let query: ((...args: unknown[]) => Promise<unknown>) | undefined;

    await boundedPostgresTransaction(db, async (_tx, boundedQuery) => {
      query = boundedQuery;
    });
    if (!query) throw new Error("query bridge missing");
    await expect(query("SELECT 1")).rejects.toMatchObject({
      details: { reason: "projection_transaction_deadline" },
    });
  });
});
