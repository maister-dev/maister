import { randomUUID } from "node:crypto";

import { eq, sql } from "drizzle-orm";
import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as fullSchema from "@/lib/db/schema";
import { runTaskSourceBackfill } from "@/lib/tasks/external-source/backfill";
import { loadTaskSources } from "@/lib/tasks/external-source/service";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

const schema = fullSchema as unknown as Record<string, any>;

let testDatabase: StartedPostgresTestDb;
let db: NodePgDatabase;
const projectId = randomUUID();
const ids: Record<string, string> = {};

const markers = (id: string, n: number) =>
  `Fix it.\nSource-GitHub-ID: ${id}\nSource-GitHub-Issue: https://github.com/maister-dev/maister/issues/${n}`;

async function seedTask(
  number: number,
  title: string,
  prompt: string,
  history: string[] = [],
): Promise<void> {
  const id = randomUUID();

  ids[`MAI-${number}`] = id;
  await db
    .insert(schema.tasks)
    .values({ id, projectId, number, title, prompt });
  for (const [index, text] of history.entries()) {
    await db.insert(schema.taskStatementRevisions).values({
      taskId: id,
      revision: index + 1,
      statement: { goal: text },
      authorActorType: "system",
    });
  }
}

async function snapshot(): Promise<unknown> {
  const result = await db.execute(sql`
    SELECT
      (SELECT json_agg(t ORDER BY t.number) FROM (
        SELECT id, number, title, prompt, revision, status FROM tasks WHERE project_id = ${projectId}
      ) t) AS tasks,
      (SELECT count(*)::int FROM task_activity WHERE project_id = ${projectId}) AS activity,
      (SELECT count(*)::int FROM runs WHERE project_id = ${projectId}) AS runs
  `);

  return result.rows[0];
}

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "maister_test",
  });
  db = testDatabase.db;
  await db.insert(schema.projects).values({
    id: projectId,
    slug: "backfill",
    name: "backfill",
    repoPath: "/tmp/backfill",
    maisterYamlPath: "/tmp/backfill/maister.yaml",
    taskKey: "MAI",
  });
  await seedTask(
    8,
    "[GitHub #7] eight",
    markers("I_kwDOUPjedM8AAAABU8w1nQ", 7),
  );
  await seedTask(20, "[GitHub #29] twenty", "markers were edited away", [
    markers("I_kwDOUPjedM8AAAABYDsXwA", 29),
  ]);
  await seedTask(
    24,
    "[GitHub #6] twenty-four",
    markers("I_kwDOUPjedM8AAAABU8w0Wg", 6),
  );
  await seedTask(27, "[GitHub #31] no markers", "Only a description.");
  await seedTask(30, "[GitHub #40] numeric", markers("40", 40));
  await seedTask(31, "[GitHub #50] dup a", markers("I_dup", 50));
  await seedTask(32, "[GitHub #50] dup b", markers("I_dup", 50));
  await seedTask(33, "plain task", "nothing external");
}, 180_000);

afterAll(async () => {
  await testDatabase?.stop();
});

describe("tasks:backfill-sources (S4)", () => {
  it("dry-run classifies without writing and reports keys, never prompt text", async () => {
    const before = await snapshot();
    const report = await runTaskSourceBackfill({ apply: false }, db);

    expect(report.mode).toBe("dry-run");
    expect(report.applied).toBe(0);
    expect(report.tasks).toEqual([
      { taskKey: "MAI-8", classification: "bindable" },
      { taskKey: "MAI-20", classification: "bindable" },
      { taskKey: "MAI-24", classification: "bindable" },
      { taskKey: "MAI-27", classification: "no_markers" },
      { taskKey: "MAI-30", classification: "malformed" },
      { taskKey: "MAI-31", classification: "duplicate" },
      { taskKey: "MAI-32", classification: "duplicate" },
    ]);
    expect(report.counts).toMatchObject({
      bindable: 3,
      no_markers: 2,
      malformed: 1,
      duplicate: 2,
    });
    expect(JSON.stringify(report)).not.toContain("Source-GitHub");
    expect(await snapshot()).toEqual(before);
    expect((await loadTaskSources(db, Object.values(ids))).size).toBe(0);
  });

  it("apply binds only bindable tasks, and a second apply changes nothing", async () => {
    const before = await snapshot();
    const first = await runTaskSourceBackfill({ apply: true }, db);
    const sources = await loadTaskSources(db, Object.values(ids));

    expect(first.applied).toBe(3);
    expect(
      Object.fromEntries(
        Object.entries(ids)
          .filter(([, id]) => sources.has(id))
          .map(([key, id]) => [
            key,
            `${sources.get(id)!.externalId}|${sources.get(id)!.externalKey}`,
          ]),
      ),
    ).toEqual({
      "MAI-8": "I_kwDOUPjedM8AAAABU8w1nQ|#7",
      "MAI-20": "I_kwDOUPjedM8AAAABYDsXwA|#29",
      "MAI-24": "I_kwDOUPjedM8AAAABU8w0Wg|#6",
    });

    const origins = await db
      .select({ origin: schema.taskExternalSources.origin })
      .from(schema.taskExternalSources)
      .where(eq(schema.taskExternalSources.projectId, projectId));

    expect(origins.every((row) => row.origin === "backfill")).toBe(true);

    const second = await runTaskSourceBackfill({ apply: true }, db);

    expect(second.applied).toBe(0);
    expect(second.counts.already_bound_same).toBe(3);
    expect(await snapshot()).toEqual(before);
  });
});
