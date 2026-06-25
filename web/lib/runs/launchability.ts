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
  | "flagged"
  | "blocked"
  | "unconfigured";

// ADR-078 D5: open relation blockers (X blocks T / T depends_on Y with the
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
  // M37 (ADR-098): a parked orchestrator is active (task in-flight) — the task
  // is not relaunchable while it awaits its children.
  WaitingOnChildren: "busy",
  Review: "busy",
  Crashed: "crashed",
  Done: "target_terminal",
  Abandoned: "launchable",
  Failed: "launchable",
} as const satisfies Record<RunStatus, TaskLaunchability>;

const MANUAL_RUN_STATUS_LAUNCHABILITY = {
  Pending: "busy",
  Running: "busy",
  NeedsInput: "busy",
  NeedsInputIdle: "busy",
  HumanWorking: "busy",
  WaitingOnChildren: "busy",
  Review: "launchable",
  Crashed: "launchable",
  Done: "launchable",
  Abandoned: "launchable",
  Failed: "launchable",
} as const satisfies Record<RunStatus, TaskLaunchability>;

export function classifyTaskLaunchability(
  task: {
    status: TaskStatus;
    flowId: string | null;
    triageStatus: "triaged" | "flagged" | null;
  },
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

  // Precedence: target_terminal > crashed > busy > flagged > blocked >
  // unconfigured > launchable (M34 ADR-089; flagged ADR-111) — relations gate
  // LAUNCHING only; they never mask an active run's state. `flagged` (a
  // confirmed duplicate / triage-rejected intake) is HELD even with a flow
  // set — a human must resolve it before launch; a flowless simple-intent task
  // is `unconfigured` until triage (or a human) fills the flow.
  if (base === "launchable") {
    if (task.triageStatus === "flagged") {
      return "flagged";
    }

    if ((relationGate?.openBlockers.length ?? 0) > 0) {
      return "blocked";
    }

    if (task.flowId === null) {
      return "unconfigured";
    }
  }

  return base;
}

export function classifyManualTaskLaunchability(
  task: { status: TaskStatus; triageStatus: "triaged" | "flagged" | null },
  latestRun: { status: RunStatus } | null,
  relationGate?: RelationGate,
): TaskLaunchability {
  const base =
    latestRun === null
      ? task.status === "InFlight"
        ? "busy"
        : "launchable"
      : MANUAL_RUN_STATUS_LAUNCHABILITY[latestRun.status];

  // `flagged` is held on the manual relaunch path too (ADR-111): a confirmed
  // duplicate / rejected intake is not relaunchable until resolved. Precedence
  // mirrors the launch path — busy/crashed/target_terminal still win (flagged
  // never masks an active/terminal run state), flagged outranks blocked.
  if (base === "launchable") {
    if (task.triageStatus === "flagged") {
      return "flagged";
    }

    if ((relationGate?.openBlockers.length ?? 0) > 0) {
      return "blocked";
    }
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
