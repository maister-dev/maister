import "server-only";

import type { Run, RunStatus, TaskStatus } from "@/lib/db/schema";

import { and, desc, eq } from "drizzle-orm";

import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";

// FIXME(any): dual drizzle-orm peer-dep variants.
const { runs } = schemaModule as unknown as Record<string, any>;

// FIXME(any): dual drizzle-orm peer-dep variants.
type Db = any;

export type TaskLaunchability =
  | "launchable"
  | "busy"
  | "crashed"
  | "target_terminal"
  | "blocked";

// ADR-075 D5: open relation blockers (X blocks T / T depends_on Y with the
// counterpart in Backlog|InFlight), computed by getOpenRelationBlockers.
export type RelationGate = {
  openBlockers: Array<{ key: string; number: number }>;
};

// `tasks.status` is a one-way latch (create→Backlog, launch→InFlight; nothing
// writes Backlog back), so the latest flow run — not the task row — decides
// relaunchability. The `satisfies` map is compile-time exhaustive: adding a
// RunStatus fails the build until it is classified here.
const RUN_STATUS_LAUNCHABILITY = {
  Pending: "busy",
  Running: "busy",
  NeedsInput: "busy",
  NeedsInputIdle: "busy",
  HumanWorking: "busy",
  Review: "busy",
  Crashed: "crashed",
  Done: "target_terminal",
  Abandoned: "launchable",
  Failed: "launchable",
} as const satisfies Record<RunStatus, TaskLaunchability>;

export function classifyTaskLaunchability(
  task: { status: TaskStatus },
  latestRun: { status: RunStatus } | null,
  relationGate?: RelationGate,
): TaskLaunchability {
  if (task.status === "Done" || task.status === "Abandoned") {
    return "target_terminal";
  }

  const base =
    latestRun === null
      ? task.status === "Backlog"
        ? "launchable"
        : "busy"
      : RUN_STATUS_LAUNCHABILITY[latestRun.status];

  // Precedence: target_terminal > crashed > busy > blocked > launchable —
  // relations gate LAUNCHING only; they never mask an active run's state.
  if (base === "launchable" && (relationGate?.openBlockers.length ?? 0) > 0) {
    return "blocked";
  }

  return base;
}

export async function getLatestFlowRun(
  taskId: string,
  db?: Db,
): Promise<Run | null> {
  // FIXME(any): dual drizzle-orm peer-dep variants.
  const _db = (db ?? getDb()) as unknown as { select: any };
  const rows = (await _db
    .select()
    .from(runs)
    .where(and(eq(runs.taskId, taskId), eq(runs.runKind, "flow")))
    .orderBy(desc(runs.startedAt))
    .limit(1)) as Run[];

  return rows[0] ?? null;
}
