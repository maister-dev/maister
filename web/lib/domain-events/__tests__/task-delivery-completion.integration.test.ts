// ADR-207: task completion after a confirmed PR merge, driven through the REAL
// scan → outbox → dispatcher → registered consumer path (C5, C6, C9). Decision
// branches are owned by lib/tasks/__tests__/completion-evidence.test.ts.
import type { PrStateReadResult } from "@/lib/runs/pr-adapter";

import { randomUUID } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";
import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import * as schema from "@/lib/db/schema";
import { dispatchDomainEvents } from "@/lib/domain-events/dispatch";
import { emitDomainEvent } from "@/lib/domain-events/outbox";
import { getPrState } from "@/lib/runs/pr-adapter";
import { runPrStateScanJob } from "@/lib/scheduler/handlers/pr-state-scan";
import { reconcileMergedTaskCompletion } from "@/lib/tasks/reconcile-merged-completion";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));

let testDatabase: StartedPostgresTestDb;
let db: NodePgDatabase<typeof schema>;

const MERGED: PrStateReadResult = {
  kind: "state",
  state: "merged",
  mergedAt: "2026-11-15T10:00:00.000Z",
  mergeCommitSha: "merge-sha",
  hasConflicts: false,
  headSha: null,
};

function mergedReader(): typeof getPrState {
  return (async () => MERGED) as unknown as typeof getPrState;
}

async function seedProject(): Promise<string> {
  const projectId = randomUUID();

  await db.insert(schema.projects).values({
    id: projectId,
    slug: `tdc-${projectId.slice(0, 8)}`,
    name: "delivery completion",
    repoPath: `/repos/${projectId}`,
    repoUrl: "https://github.com/acme/app.git",
    provider: "github",
    taskKey: `TDC${projectId.replaceAll("-", "").slice(0, 6).toUpperCase()}`,
    mainBranch: "main",
  });

  return projectId;
}

// A flow Run of an InFlight task with a recorded PR. `parked` = opened from the
// Run Git panel before finalize (Review, promotion none).
async function seedPrRun(
  projectId: string,
  opts: { parked?: boolean; taskStatus?: "InFlight" | "Done" } = {},
): Promise<{ taskId: string; runId: string; number: number }> {
  const taskId = randomUUID();
  const runId = randomUUID();
  const number = Math.trunc(Math.random() * 1e6) + 1;

  await db.insert(schema.tasks).values({
    id: taskId,
    projectId,
    number,
    title: `Task ${number}`,
    prompt: "ship it",
    status: opts.taskStatus ?? "InFlight",
  });
  await db.insert(schema.runs).values({
    id: runId,
    projectId,
    taskId,
    runKind: "flow",
    status: opts.parked ? "Review" : "Done",
    flowVersion: "v1.0.0",
    startedAt: new Date(),
    deliveryPolicySnapshot: {
      strategy: "pull_request",
      push: "on_success",
      trigger: "manual",
      targetBranch: "main",
    },
  });
  await db.insert(schema.workspaces).values({
    id: randomUUID(),
    runId,
    projectId,
    branch: `maister/${runId.slice(0, 8)}`,
    worktreePath: `/tmp/wt-${runId}`,
    parentRepoPath: `/repos/${projectId}`,
    targetBranch: "main",
    promotionMode: "pull_request",
    promotionState: opts.parked ? "none" : "done",
    prUrl: `https://github.com/acme/app/pull/${number}`,
    prNumber: number,
    prState: "open",
  });

  return { taskId, runId, number };
}

async function finalize(
  projectId: string,
  seeded: { taskId: string; runId: string },
) {
  await db.transaction(async (tx) => {
    await tx
      .update(schema.runs)
      .set({ status: "Done" })
      .where(eq(schema.runs.id, seeded.runId));
    await tx
      .update(schema.workspaces)
      .set({ promotionState: "done" })
      .where(eq(schema.workspaces.runId, seeded.runId));
    await emitDomainEvent({
      db: tx,
      kind: "run.done",
      projectId,
      taskId: seeded.taskId,
      runId: seeded.runId,
      actor: { type: "system", id: null },
      parentRunId: null,
      payload: { runId: seeded.runId, runKind: "flow", completion: "promoted" },
    });
  });
}

async function taskStatus(taskId: string): Promise<string> {
  const [row] = await db
    .select({ status: schema.tasks.status })
    .from(schema.tasks)
    .where(eq(schema.tasks.id, taskId));

  return row.status;
}

async function activity(taskId: string, kind: schema.TaskActivityEventKind) {
  return db
    .select({ payload: schema.taskActivity.payload })
    .from(schema.taskActivity)
    .where(
      and(
        eq(schema.taskActivity.taskId, taskId),
        eq(schema.taskActivity.eventKind, kind),
      ),
    );
}

async function dispatchAll(): Promise<void> {
  // Two passes: the outbox horizon admits rows committed before the pass.
  await dispatchDomainEvents({ db });
  await dispatchDomainEvents({ db });
}

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "delivery_completion_test",
  });
  db = testDatabase.db;
  // Register every consumer cursor ("startFrom: now") before any event exists.
  await dispatchDomainEvents({ db });
}, 180_000);

afterAll(async () => {
  await testDatabase?.stop();
});

describe("task_delivery_completion consumer (ADR-207)", () => {
  it("C5: a merge observed before a restart completes the task once after it, and a redelivered window is a no-op", async () => {
    const projectId = await seedProject();
    const seeded = await seedPrRun(projectId);

    await runPrStateScanJob({ projectId, db, getPrState: mergedReader() });
    // "Restart": nothing in memory carries the merge — only the outbox row.
    await dispatchAll();

    expect(await taskStatus(seeded.taskId)).toBe("Done");
    expect(await activity(seeded.taskId, "task_completed")).toEqual([
      {
        payload: {
          runId: seeded.runId,
          cause: "pr_merged",
          prNumber: seeded.number,
        },
      },
    ]);

    // Crash after handle but before the cursor advanced: the window replays.
    await db.execute(sql`
      UPDATE domain_event_consumers SET cursor_event_id = 0 WHERE consumer_id = 'task_delivery_completion'
    `);
    await dispatchAll();

    expect(await activity(seeded.taskId, "task_completed")).toHaveLength(1);
  });

  it("C9: a panel PR merged before finalize completes on the finalize's run.done", async () => {
    const projectId = await seedProject();
    const seeded = await seedPrRun(projectId, { parked: true });

    await runPrStateScanJob({ projectId, db, getPrState: mergedReader() });
    await dispatchAll();

    expect(await taskStatus(seeded.taskId)).toBe("InFlight");
    expect(
      await activity(seeded.taskId, "delivery_completion_not_applied"),
    ).toEqual([]);

    await finalize(projectId, seeded);
    await dispatchAll();

    expect(await taskStatus(seeded.taskId)).toBe("Done");
  });

  it("C9: finalize first, merge later also completes exactly once", async () => {
    const projectId = await seedProject();
    const seeded = await seedPrRun(projectId, { parked: true });

    await finalize(projectId, seeded);
    await dispatchAll();
    expect(await taskStatus(seeded.taskId)).toBe("InFlight");

    await runPrStateScanJob({ projectId, db, getPrState: mergedReader() });
    await dispatchAll();

    expect(await taskStatus(seeded.taskId)).toBe("Done");
    expect(await activity(seeded.taskId, "task_completed")).toHaveLength(1);
  });

  it("C6: reconciliation dry-run lists eligible merged tasks without writing; apply completes them once", async () => {
    const projectId = await seedProject();
    const eligible = await seedPrRun(projectId);
    const alreadyDone = await seedPrRun(projectId, { taskStatus: "Done" });

    // Merged before this package shipped: no run.pr_merged exists for them.
    await db
      .update(schema.workspaces)
      .set({ prState: "merged" })
      .where(eq(schema.workspaces.projectId, projectId));

    const dryRun = await reconcileMergedTaskCompletion({ apply: false }, db);

    expect(
      dryRun.tasks
        .filter((t) => [eligible.taskId, alreadyDone.taskId].includes(t.taskId))
        .map(({ taskId, runId, decision }) => ({ taskId, runId, decision })),
    ).toEqual([
      { taskId: eligible.taskId, runId: eligible.runId, decision: "apply" },
    ]);
    expect(await taskStatus(eligible.taskId)).toBe("InFlight");

    const applied = await reconcileMergedTaskCompletion({ apply: true }, db);

    expect(applied.applied).toBeGreaterThanOrEqual(1);
    expect(await taskStatus(eligible.taskId)).toBe("Done");
    expect(await activity(alreadyDone.taskId, "task_completed")).toEqual([]);

    const again = await reconcileMergedTaskCompletion({ apply: true }, db);

    expect(again.tasks.some((t) => t.taskId === eligible.taskId)).toBe(false);
    expect(await activity(eligible.taskId, "task_completed")).toHaveLength(1);
  });
});
