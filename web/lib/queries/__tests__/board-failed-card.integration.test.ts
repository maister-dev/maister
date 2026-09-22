// ADR-181 D2 / D14 (RED 4): a task whose latest run is `Failed` or `Abandoned`
// derives to the Backlog column, and a Backlog card rendered no lifecycle menu —
// so the run's work was reachable only by knowing its URL. The card now carries
// the latest run's menu, but ONLY while that run's worktree is usable (the row
// is not removed AND the path exists): a card must never offer a git action
// against a worktree that is gone.

import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import * as fullSchema from "@/lib/db/schema";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

const schema = fullSchema as unknown as Record<string, any>;

let testDatabase: StartedPostgresTestDb;
let db: NodePgDatabase;
let root: string;

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));

let getBoardData: typeof import("@/lib/queries/board").getBoardData;

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "board_failed_card_test",
  });
  db = testDatabase.db;
  root = await mkdtemp(join(tmpdir(), "board-failed-card-"));
  ({ getBoardData } = await import("@/lib/queries/board"));
}, 180_000);

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
  await testDatabase?.stop();
});

async function seedProject(): Promise<{ projectId: string; flowId: string }> {
  const projectId = randomUUID();
  const flowId = randomUUID();

  await db.insert(schema.projects).values({
    id: projectId,
    slug: `p-${projectId.slice(0, 8)}`,
    name: "P",
    repoPath: `/repos/${projectId}`,
    maisterYamlPath: `/repos/${projectId}/maister.yaml`,
    taskKey: `B${projectId
      .replace(/[^0-9A-Za-z]/g, "")
      .slice(0, 6)
      .toUpperCase()}`,
  });
  await db.insert(schema.flows).values({
    id: flowId,
    projectId,
    flowRefId: `flow-${flowId.slice(0, 8)}`,
    source: "github.com/x/y",
    version: "v1.0.0",
    installedPath: "/tmp/flows/test",
    manifest: {},
    schemaVersion: 1,
  });

  return { projectId, flowId };
}

async function seedTaskWithRun(args: {
  projectId: string;
  flowId: string;
  runStatus: string | null;
  worktreePath?: string;
  removedAt?: Date | null;
}): Promise<{ taskId: string; runId: string | null }> {
  const taskId = randomUUID();

  await db.insert(schema.tasks).values({
    id: taskId,
    projectId: args.projectId,
    number: Math.trunc(Math.random() * 1e9) + 1,
    title: "t",
    prompt: "p",
    flowId: args.flowId,
    status: args.runStatus === null ? "Backlog" : "InFlight",
  });

  if (args.runStatus === null) return { taskId, runId: null };

  const runId = randomUUID();

  await db.insert(schema.runs).values({
    id: runId,
    projectId: args.projectId,
    taskId,
    flowId: args.flowId,
    flowVersion: "v1.0.0",
    status: args.runStatus,
    runKind: "flow",
    startedAt: new Date(),
    endedAt: new Date(),
  });
  await db.insert(schema.workspaces).values({
    id: randomUUID(),
    runId,
    projectId: args.projectId,
    branch: `maister/task-${taskId}/attempt-1`,
    worktreePath: args.worktreePath ?? join(root, `missing-${runId}`),
    parentRepoPath: `/repos/${args.projectId}`,
    removedAt: args.removedAt ?? null,
    removalKind: args.removedAt ? "drop" : null,
  });

  return { taskId, runId };
}

function backlogCard(
  board: Awaited<ReturnType<typeof getBoardData>>,
  taskId: string,
) {
  const card = board.columns.Backlog.backlog.find((c) => c.taskId === taskId);

  expect(card).toBeDefined();

  return card!;
}

describe("Backlog card — the latest parked run's git menu", () => {
  it.each(["Failed", "Abandoned"] as const)(
    "carries the menu of a %s latest run whose worktree is usable",
    async (runStatus) => {
      const { projectId, flowId } = await seedProject();
      const worktreePath = await mkdtemp(join(root, "wt-"));
      const { taskId, runId } = await seedTaskWithRun({
        projectId,
        flowId,
        runStatus,
        worktreePath,
      });

      const card = backlogCard(await getBoardData(projectId), taskId);

      expect(card.latestRun).toMatchObject({
        id: runId,
        kind: "flow",
        status: runStatus,
      });
      expect(card.latestRun?.lifecycleActions).toEqual(
        expect.arrayContaining([
          "archive",
          "drop",
          "exportBranch",
          "snapshotCommit",
          "discardChanges",
          "update",
        ]),
      );
      expect(card.latestRun?.lifecycleActions).not.toContain("stop");
      expect(card.latestRun?.lifecycleActions).not.toContain("reattach");
    },
  );

  it("carries no menu when the latest run's worktree path is gone", async () => {
    const { projectId, flowId } = await seedProject();
    const { taskId } = await seedTaskWithRun({
      projectId,
      flowId,
      runStatus: "Failed",
    });

    expect(
      backlogCard(await getBoardData(projectId), taskId).latestRun,
    ).toBeNull();
  });

  it("carries no menu when the latest run's workspace was removed", async () => {
    const { projectId, flowId } = await seedProject();
    const worktreePath = await mkdtemp(join(root, "wt-removed-"));
    const { taskId } = await seedTaskWithRun({
      projectId,
      flowId,
      runStatus: "Review",
      worktreePath,
      removedAt: new Date(),
    });

    expect(
      backlogCard(await getBoardData(projectId), taskId).latestRun,
    ).toBeNull();
  });

  it("carries no menu on a task that was never launched", async () => {
    const { projectId, flowId } = await seedProject();
    const { taskId } = await seedTaskWithRun({
      projectId,
      flowId,
      runStatus: null,
    });

    expect(
      backlogCard(await getBoardData(projectId), taskId).latestRun,
    ).toBeNull();
  });
});
