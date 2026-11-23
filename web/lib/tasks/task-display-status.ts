import type { Task } from "@/lib/db/schema";
import type { RunStatusValue } from "@/lib/runs/run-status-values";

import { isManualTriageHold } from "@/lib/tasks/manual-launch-hold";
import { workStageOfRun, type WorkStage } from "@/lib/work/stage";

export type TaskDisplayTone = "neutral" | "accent" | "warning" | "danger" | "success";

export const TASK_DISPLAY_STATUS = {
  abandoned: { label: "Abandoned", tone: "neutral" },
  done: { label: "Done", tone: "success" },
  queued: { label: "Queued", tone: "neutral" },
  in_progress: { label: "In progress", tone: "accent" },
  waiting_on_human: { label: "Waiting on human", tone: "warning" },
  in_review: { label: "In review", tone: "accent" },
  crashed: { label: "Crashed", tone: "danger" },
  incoming: { label: "Incoming", tone: "neutral" },
  blocked: { label: "Blocked", tone: "warning" },
  needs_review: { label: "Needs review", tone: "warning" },
  ready: { label: "Ready", tone: "success" },
  backlog: { label: "Backlog", tone: "neutral" },
} as const satisfies Record<string, { label: string; tone: TaskDisplayTone }>;

export type TaskDisplayStatusKey = keyof typeof TASK_DISPLAY_STATUS;
export type TaskDisplayStatus = {
  [Key in TaskDisplayStatusKey]: { key: Key } & (typeof TASK_DISPLAY_STATUS)[Key];
}[TaskDisplayStatusKey];

export type TaskDisplayStatusFacts = {
  taskStatus: Task["status"];
  triageStatus: Task["triageStatus"];
  triageFlagOrigin: Task["triageFlagOrigin"];
  configuredFlow: boolean;
  incoming: boolean;
  blocked: boolean;
  qualificationAdmitted: boolean;
  manualAdmission: boolean;
  latestFlowStatus: RunStatusValue | null;
  workspaceRemoved: boolean;
};

const DISPLAY_BY_RUN_STAGE: Partial<Record<WorkStage, TaskDisplayStatusKey>> = {
  Queued: "queued",
  Executing: "in_progress",
  WaitingOnHuman: "waiting_on_human",
  Review: "in_review",
  Crashed: "crashed",
  Promoted: "done",
};

function displayKey(facts: TaskDisplayStatusFacts): TaskDisplayStatusKey {
  if (facts.taskStatus === "Abandoned") return "abandoned";
  if (facts.taskStatus === "Done") return "done";

  if (facts.latestFlowStatus !== null) {
    const stage = workStageOfRun(facts.latestFlowStatus, facts.workspaceRemoved);
    const key = DISPLAY_BY_RUN_STAGE[stage];

    if (key) return key;
  } else if (facts.taskStatus === "InFlight") {
    return "in_progress";
  }

  if (facts.incoming) return "incoming";
  if (facts.blocked) return "blocked";
  if (isManualTriageHold(facts) || (!facts.qualificationAdmitted && !facts.manualAdmission)) {
    return "needs_review";
  }

  return facts.configuredFlow ? "ready" : "backlog";
}

export function deriveTaskDisplayStatus(facts: TaskDisplayStatusFacts): TaskDisplayStatus {
  const key = displayKey(facts);

  return { key, ...TASK_DISPLAY_STATUS[key] } as TaskDisplayStatus;
}
