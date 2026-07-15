import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import * as schema from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import {
  claimScheduledLaunch,
  createScheduledLaunch,
  dispatchClaimedScheduledLaunch,
} from "@/lib/scheduled-launches/service";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

let testDatabase: StartedPostgresTestDb;
let db: NodePgDatabase<typeof schema>;

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));

type Fixture = {
  flowId: string;
  projectId: string;
  taskId: string;
  userId: string;
};

async function seedFixture(): Promise<Fixture> {
  const projectId = randomUUID();
  const taskId = randomUUID();
  const flowId = randomUUID();
  const revisionId = randomUUID();
  const userId = randomUUID();
  const flowRefId = `maintenance-${flowId}`;

  await db.insert(schema.users).values({
    id: userId,
    email: `${userId}@scheduled-dispatch.test`,
  });
  await db.insert(schema.projects).values({
    id: projectId,
    slug: `dispatch-${projectId.slice(0, 8)}`,
    name: "Dispatch test",
    repoPath: `/tmp/dispatch-${projectId}`,
    maisterYamlPath: `/tmp/dispatch-${projectId}/maister.yaml`,
    taskKey: `D${projectId.slice(0, 8)}`.toUpperCase(),
  });
  await db.insert(schema.flowRevisions).values({
    id: revisionId,
    flowRefId,
    source: "github.com/test/maintenance",
    versionLabel: "v1.0.0",
    resolvedRevision: "a".repeat(40),
    manifestDigest: "digest",
    manifest: { schemaVersion: 1, name: "Maintenance", nodes: [] },
    schemaVersion: 1,
    installedPath: "/tmp/maintenance",
    packageStatus: "Installed",
  });
  await db.insert(schema.flows).values({
    id: flowId,
    projectId,
    flowRefId,
    source: "github.com/test/maintenance",
    version: "v1.0.0",
    installedPath: "/tmp/maintenance",
    manifest: { schemaVersion: 1, name: "Maintenance", nodes: [] },
    schemaVersion: 1,
    enabledRevisionId: revisionId,
    enablementState: "Enabled",
    trustStatus: "trusted",
  });
  await db.insert(schema.tasks).values({
    id: taskId,
    projectId,
    number: 1,
    title: "Dispatch exactly once",
    prompt: "dispatch test",
    flowId,
    status: "Backlog",
    attemptNumber: 0,
  });

  return { flowId, projectId, taskId, userId };
}

async function createDueIntent(fixture: Fixture) {
  return createScheduledLaunch({
    projectId: fixture.projectId,
    taskId: fixture.taskId,
    actorUserId: fixture.userId,
    idempotencyKey: randomUUID(),
    scheduledLocalTime: "2026-06-01T10:15",
    timezone: "UTC",
    launchRequest: { flowId: fixture.flowId },
    now: new Date("2026-01-01T00:00:00.000Z"),
    db,
  });
}

async function insertLinkedRun(input: {
  fixture: Fixture;
  scheduledLaunchId: string;
  runId: string;
}): Promise<void> {
  await db.insert(schema.runs).values({
    id: input.runId,
    projectId: input.fixture.projectId,
    taskId: input.fixture.taskId,
    flowId: input.fixture.flowId,
    flowVersion: "v1.0.0",
    flowRevision: "a".repeat(40),
    triggerSource: "scheduled",
    scheduledLaunchId: input.scheduledLaunchId,
  });
}

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "scheduled_launch_dispatch_test",
  });
  db = testDatabase.db;
}, 180_000);

afterAll(async () => {
  await testDatabase?.stop();
});

describe("scheduled task launch dispatcher", () => {
  it("links the one reserved Run and finalizes the intent through the launch seam", async () => {
    const fixture = await seedFixture();
    const created = await createDueIntent(fixture);
    const now = new Date("2026-06-01T10:15:00.000Z");
    const claim = await claimScheduledLaunch({
      scheduledLaunchId: created.intent.id,
      projectId: fixture.projectId,
      source: "tick",
      now,
      db,
    });
    const launch = vi.fn(async (input) => {
      expect(input.scheduledReservation).toMatchObject(claim.reservation);
      await insertLinkedRun({
        fixture,
        scheduledLaunchId: created.intent.id,
        runId: claim.reservation.runId,
      });

      return { runId: claim.reservation.runId, status: "Pending" };
    });

    await expect(
      dispatchClaimedScheduledLaunch({
        projectId: fixture.projectId,
        claimId: claim.claimId,
        claimFence: claim.claimFence,
        reservation: claim.reservation,
        now,
        db,
        launch,
      }),
    ).resolves.toEqual({ state: "Launched", runId: claim.reservation.runId });

    expect(launch).toHaveBeenCalledOnce();
    await expect(
      db
        .select({ state: schema.scheduledTaskLaunches.state })
        .from(schema.scheduledTaskLaunches)
        .where(eq(schema.scheduledTaskLaunches.id, created.intent.id)),
    ).resolves.toEqual([{ state: "Launched" }]);
    await expect(
      db
        .select({ state: schema.scheduledTaskLaunchAttempts.state })
        .from(schema.scheduledTaskLaunchAttempts)
        .where(
          eq(
            schema.scheduledTaskLaunchAttempts.scheduledLaunchId,
            created.intent.id,
          ),
        ),
    ).resolves.toEqual([{ state: "RunLinked" }]);
  });

  it("finalizes an already inserted reserved Run without reentering launch", async () => {
    const fixture = await seedFixture();
    const created = await createDueIntent(fixture);
    const now = new Date("2026-06-01T10:15:00.000Z");
    const claim = await claimScheduledLaunch({
      scheduledLaunchId: created.intent.id,
      projectId: fixture.projectId,
      source: "tick",
      now,
      db,
    });
    await insertLinkedRun({
      fixture,
      scheduledLaunchId: created.intent.id,
      runId: claim.reservation.runId,
    });
    const launch = vi.fn(async () => {
      throw new Error("must not call launch after the Run link exists");
    });

    await expect(
      dispatchClaimedScheduledLaunch({
        projectId: fixture.projectId,
        claimId: claim.claimId,
        claimFence: claim.claimFence,
        reservation: claim.reservation,
        now,
        db,
        launch,
      }),
    ).resolves.toEqual({ state: "Launched", runId: claim.reservation.runId });

    expect(launch).not.toHaveBeenCalled();
  });

  it("reuses a reservation after a bounded transient failure", async () => {
    const fixture = await seedFixture();
    const created = await createDueIntent(fixture);
    const now = new Date("2026-06-01T10:15:00.000Z");
    const first = await claimScheduledLaunch({
      scheduledLaunchId: created.intent.id,
      projectId: fixture.projectId,
      source: "tick",
      now,
      db,
    });

    await expect(
      dispatchClaimedScheduledLaunch({
        projectId: fixture.projectId,
        claimId: first.claimId,
        claimFence: first.claimFence,
        reservation: first.reservation,
        now,
        db,
        launch: async () => {
          throw new MaisterError("EXECUTOR_UNAVAILABLE", "runner is offline");
        },
      }),
    ).resolves.toEqual({ state: "RetryWaiting" });

    const second = await claimScheduledLaunch({
      scheduledLaunchId: created.intent.id,
      projectId: fixture.projectId,
      source: "tick",
      now: new Date("2026-06-01T10:16:00.000Z"),
      db,
    });

    expect(second.reservation).toMatchObject({
      id: first.reservation.id,
      runId: first.reservation.runId,
      branch: first.reservation.branch,
      worktreePath: first.reservation.worktreePath,
      claimFence: 2,
    });
  });
});
