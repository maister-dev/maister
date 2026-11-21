import type { RunStatus, TaskStatus } from "@/lib/db/schema";

// D10: the task page is organized around one primary next action; everything
// else lives in the "More" menu. Pure — the page renders, it never decides.

export type TaskPrimaryAction =
  | "qualify"
  | "launch"
  | "blocked"
  | "open_run"
  | "respond"
  | "open_review"
  | "open_pr"
  | "complete"
  | "run_again"
  | "result"
  | "abandoned";

export type TaskSecondaryAction =
  | "queue"
  | "run_agent"
  | "send_to_triage"
  | "complete"
  | "open_pr"
  | "open_run"
  | "run_again"
  | "new_attempt";

export type TaskNextActionInput = {
  taskStatus: TaskStatus;
  needsQualification: boolean;
  launchable: boolean;
  latestRun: { status: RunStatus; hasPr: boolean } | null;
  completionReady: boolean;
  canAct: boolean;
};

export type TaskNextAction = {
  primary: TaskPrimaryAction;
  secondary: TaskSecondaryAction[];
};

const BACKLOG_SECONDARY: TaskSecondaryAction[] = [
  "send_to_triage",
  "run_agent",
  "queue",
];

const IN_FLIGHT_BY_RUN_STATUS = {
  Pending: () => ({ primary: "open_run", secondary: ["queue", "run_agent"] }),
  Running: () => ({ primary: "open_run", secondary: ["queue", "run_agent"] }),
  Waiting: () => ({ primary: "open_run", secondary: [] }),
  WaitingOnChildren: () => ({
    primary: "open_run",
    secondary: ["queue", "run_agent"],
  }),
  HumanWorking: () => ({
    primary: "open_run",
    secondary: ["queue", "run_agent"],
  }),
  NeedsInput: () => ({ primary: "respond", secondary: [] }),
  NeedsInputIdle: () => ({ primary: "respond", secondary: [] }),
  Review: (i: TaskNextActionInput) => ({
    primary: "open_review",
    secondary: i.completionReady ? ["complete"] : [],
  }),
  Done: (i: TaskNextActionInput) =>
    i.latestRun?.hasPr
      ? i.completionReady
        ? { primary: "complete", secondary: ["open_pr", "run_again"] }
        : { primary: "open_pr", secondary: ["run_again"] }
      : i.completionReady
        ? { primary: "complete", secondary: ["run_again"] }
        : { primary: "open_run", secondary: ["run_again"] },
  Failed: () => ({
    primary: "run_again",
    secondary: ["open_run", "run_agent", "queue"],
  }),
  Crashed: () => ({
    primary: "run_again",
    secondary: ["open_run", "run_agent", "queue"],
  }),
  Abandoned: () => ({
    primary: "run_again",
    secondary: ["open_run", "run_agent", "queue"],
  }),
} satisfies Record<RunStatus, (input: TaskNextActionInput) => TaskNextAction>;

function decide(input: TaskNextActionInput): TaskNextAction {
  switch (input.taskStatus) {
    case "Done":
      return {
        primary: "result",
        secondary: ["new_attempt", "send_to_triage"],
      };
    case "Abandoned":
      return { primary: "abandoned", secondary: [] };
    case "InFlight":
      if (input.latestRun) {
        return IN_FLIGHT_BY_RUN_STATUS[input.latestRun.status](input);
      }
      break;
    case "Backlog":
      break;
  }
  if (input.needsQualification) {
    return { primary: "qualify", secondary: ["queue", "run_agent"] };
  }

  return {
    primary: input.launchable ? "launch" : "blocked",
    secondary: BACKLOG_SECONDARY,
  };
}

export function taskNextAction(input: TaskNextActionInput): TaskNextAction {
  const action = decide(input);

  return input.canAct ? action : { primary: action.primary, secondary: [] };
}
