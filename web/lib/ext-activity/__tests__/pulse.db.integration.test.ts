import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import * as schema from "@/lib/db/schema";
import { getActivityPulse } from "@/lib/ext-activity/service";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

type Queryable = {
  query: (
    sql: string,
    params: unknown[],
  ) => Promise<{ rows: Array<{ id: string }> }>;
};

let testDatabase: StartedPostgresTestDb;

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "ext_activity_pulse_test",
  });
}, 180_000);

afterAll(async () => {
  await testDatabase?.stop();
});

beforeEach(async () => {
  await testDatabase.db.delete(schema.domainEvents);
  await testDatabase.db.delete(schema.projects);
});

async function seedProject(slug: string) {
  const projectId = randomUUID();

  await testDatabase.db.insert(schema.projects).values({
    taskKey: `T${randomUUID().slice(0, 8)}`.toUpperCase(),
    id: projectId,
    slug,
    name: `Project ${slug}`,
    repoPath: `/tmp/${slug}`,
    maisterYamlPath: `/tmp/${slug}/maister.yaml`,
  });

  return projectId;
}

async function insertDomainEvent(
  client: Queryable,
  projectId: string,
  kind: string,
  payload: Record<string, unknown>,
) {
  const result = await client.query(
    `INSERT INTO domain_events (kind, project_id, actor_type, payload, occurred_at)
     VALUES ($1, $2, 'system', $3::jsonb, $4)
     RETURNING id`,
    [
      kind,
      projectId,
      JSON.stringify(payload),
      new Date("2026-07-27T10:00:00.000Z"),
    ],
  );

  return BigInt(result.rows[0].id);
}

describe("assistant activity pulse commit horizon", () => {
  it("bootstraps from the visible tail so an older in-flight transaction is not skipped forever", async () => {
    const projectId = await seedProject(
      `ext-activity-horizon-${randomUUID().slice(0, 8)}`,
    );
    const baselineId = await insertDomainEvent(
      testDatabase.pool,
      projectId,
      "task.created",
      { taskKey: "OPS-1" },
    );
    const heldClient = await testDatabase.pool.connect();

    try {
      await heldClient.query("BEGIN");

      const heldId = await insertDomainEvent(
        heldClient,
        projectId,
        "task.comment_added",
        { taskKey: "OPS-2" },
      );
      const committedId = await insertDomainEvent(
        testDatabase.pool,
        projectId,
        "run.failed",
        { taskKey: "OPS-3" },
      );

      const bootstrap = await getActivityPulse(projectId, {
        since: null,
        salience: "high",
        client: testDatabase.db,
        now: new Date("2026-07-27T10:05:00.000Z"),
      });

      expect(bootstrap.happened).toEqual({
        items: [],
        nextCursor: baselineId,
        hasMore: false,
      });

      await heldClient.query("COMMIT");

      const replay = await getActivityPulse(projectId, {
        since: baselineId,
        salience: "high",
        client: testDatabase.db,
        now: new Date("2026-07-27T10:06:00.000Z"),
      });

      expect(replay.happened.items.map((item) => item.id)).toEqual([
        heldId.toString(10),
        committedId.toString(10),
      ]);
      expect(replay.happened.nextCursor).toBe(committedId);
    } finally {
      heldClient.release();
    }
  });
});
