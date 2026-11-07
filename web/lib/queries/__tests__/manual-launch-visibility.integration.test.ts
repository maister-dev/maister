import type { Db } from "@/lib/execution-host/db";
import type { StartedPostgresTestDb } from "@/test-support/pg-container";
import type { TaskLaunchFixture } from "@/test-support/task-launch-admission";

import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";

import { afterAll, beforeAll, expect, it, vi } from "vitest";

import { tasks } from "@/lib/db/schema";
import { getBoardData } from "@/lib/queries/board";
import { getPortfolio } from "@/lib/queries/portfolio";
import { getWorkTable } from "@/lib/queries/work-table";
import { getTaskQualificationSummaries } from "@/lib/tasks/qualification-queries";
import {
  prepareTaskQualification,
  requireTaskRequalification,
} from "@/lib/tasks/qualification";
import { startMainPostgresTestDb } from "@/test-support/pg-container";
import { seedTaskLaunchFixture } from "@/test-support/task-launch-admission";
import { qualificationFixture } from "@/test-support/task-qualification";
import { mkdtempReal } from "@/test-support/worktree-test-root";

let database: StartedPostgresTestDb;
let fixture: TaskLaunchFixture;
let db: Db;
let root: string;
let sequence = 0;

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));

beforeAll(async () => {
  database = await startMainPostgresTestDb({
    databaseName: "manual_launch_visibility",
  });
  db = database.db;
  root = await mkdtempReal("manual-launch-visibility-");
  fixture = await seedTaskLaunchFixture(database, root);
}, 180_000);

afterAll(async () => {
  await database?.stop();
  if (root) await rm(root, { recursive: true, force: true });
});

async function task(flowId: string | null): Promise<string> {
  const id = randomUUID();

  await db.insert(tasks).values({
    id,
    projectId: fixture.projectId,
    number: ++sequence,
    title: "Intentional manual delivery",
    prompt: "Launch this configured task",
    flowId,
    runnerId: fixture.runnerId,
  });

  return id;
}

it("keeps configured missing, negative and stale assessments visible as work without changing their triage findings", async () => {
  const missing = await task(fixture.flowId);
  const negative = await task(fixture.flowId);
  const stale = await task(fixture.flowId);
  const unconfigured = await task(null);

  for (const taskId of [negative, stale]) {
    const value = qualificationFixture();
    const qualification = await prepareTaskQualification(db, {
      projectId: fixture.projectId,
      taskId,
      author: {
        kind: "user",
        identity: fixture.userId,
        userId: fixture.userId,
      },
      request: {
        requestKey: randomUUID(),
        expectedInputRevision: 1,
        expectedQualificationRevision: null,
        enqueue: false,
        qualification:
          taskId === negative
            ? {
                ...value,
                decision: "needs_review",
                reasonCodes: ["requirements_conflict"],
                nextActions: ["Resolve the conflicting requirements"],
                checks: value.checks.map((check) =>
                  check.dimension === "consistency"
                    ? {
                        ...check,
                        state: "fail",
                        rationale: "Two requirements conflict",
                      }
                    : check,
                ),
              }
            : value,
      },
    });

    await db.transaction(qualification.apply);
  }
  await db.transaction((tx) =>
    requireTaskRequalification(tx, fixture.projectId, stale),
  );
  const before = await getTaskQualificationSummaries(db, [
    missing,
    negative,
    stale,
  ]);
  const [board, portfolio, work] = await Promise.all([
    getBoardData(fixture.projectId),
    getPortfolio(fixture.userId, "admin"),
    getWorkTable({ id: fixture.userId, role: "admin" }),
  ]);
  const boardIds = Object.values(board.columns).flatMap((column) =>
    column.backlog.map((card) => card.taskId),
  );

  expect(boardIds).toEqual(expect.arrayContaining([missing, negative, stale]));
  expect(boardIds).not.toContain(unconfigured);
  expect(work.rows.map((row) => row.taskId)).toEqual(
    expect.arrayContaining([missing, negative, stale]),
  );
  expect(work.rows.map((row) => row.taskId)).not.toContain(unconfigured);
  expect(
    portfolio.projects.find((project) => project.id === fixture.projectId)
      ?.backlogCount,
  ).toBe(3);
  expect(before.get(missing)?.freshness).toBe("unassessed");
  expect(before.get(negative)?.decision).toBe("needs_review");
  expect(before.get(stale)?.freshness).toBe("stale");
  expect(
    await getTaskQualificationSummaries(db, [missing, negative, stale]),
  ).toEqual(before);
});
