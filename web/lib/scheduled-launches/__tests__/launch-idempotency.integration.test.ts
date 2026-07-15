import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import * as schema from "@/lib/db/schema";
import {
  claimScheduledLaunch,
  createScheduledLaunch,
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

  await db.insert(schema.users).values({
    id: userId,
    email: `${userId}@scheduled-claim.test`,
  });
  await db.insert(schema.projects).values({
    id: projectId,
    slug: `claim-${projectId.slice(0, 8)}`,
    name: "Claim test",
    repoPath: `/tmp/claim-${projectId}`,
    maisterYamlPath: `/tmp/claim-${projectId}/maister.yaml`,
    taskKey: `C${projectId.slice(0, 8)}`.toUpperCase(),
  });
  await db.insert(schema.flowRevisions).values({
    id: revisionId,
    flowRefId: "maintenance",
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
    flowRefId: "maintenance",
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
    title: "Claim exactly once",
    prompt: "claim test",
    flowId,
    status: "Backlog",
    attemptNumber: 0,
  });

  return { flowId, projectId, taskId, userId };
}

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "scheduled_launch_claim_test",
  });
  db = testDatabase.db;
}, 180_000);

afterAll(async () => {
  await testDatabase?.stop();
});

describe("claimScheduledLaunch", () => {
  it("makes one durable reservation before either concurrent claimant can reach Git", async () => {
    const fixture = await seedFixture();
    const dueAt = new Date("2026-06-01T10:15:00.000Z");
    const created = await createScheduledLaunch({
      projectId: fixture.projectId,
      taskId: fixture.taskId,
      actorUserId: fixture.userId,
      idempotencyKey: "concurrent-claim",
      scheduledLocalTime: "2026-06-01T10:15",
      timezone: "UTC",
      launchRequest: { flowId: fixture.flowId },
      now: new Date("2026-01-01T00:00:00.000Z"),
      db,
    });

    const claims = await Promise.allSettled(
      ["tick", "run_now"].map((source) =>
        claimScheduledLaunch({
          scheduledLaunchId: created.intent.id,
          projectId: fixture.projectId,
          source: source as "tick" | "run_now",
          now: dueAt,
          db,
        }),
      ),
    );

    const fulfilled = claims.filter(
      (claim): claim is PromiseFulfilledResult<Awaited<ReturnType<typeof claimScheduledLaunch>>> =>
        claim.status === "fulfilled",
    );

    expect(fulfilled).toHaveLength(1);
    expect(
      claims.filter((claim) => claim.status === "rejected"),
    ).toHaveLength(1);

    const reservation = fulfilled[0]?.value.reservation;

    expect(reservation).toMatchObject({
      scheduledLaunchId: created.intent.id,
      taskId: fixture.taskId,
      taskAttemptNumber: 1,
      claimFence: 1,
    });
    expect(reservation?.runId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );

    const attempts = await db
      .select()
      .from(schema.scheduledTaskLaunchAttempts)
      .where(
        eq(
          schema.scheduledTaskLaunchAttempts.scheduledLaunchId,
          created.intent.id,
        ),
      );
    const intentRows = await db
      .select()
      .from(schema.scheduledTaskLaunches)
      .where(eq(schema.scheduledTaskLaunches.id, created.intent.id));

    expect(attempts).toHaveLength(1);
    expect(intentRows).toMatchObject([
      {
        state: "Dispatching",
        attemptCount: 1,
        claimId: expect.any(String),
        claimFence: 1,
      },
    ]);
  });
});
