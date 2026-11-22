import { describe, expect, it } from "vitest";

import {
  taskNextAction,
  type TaskNextActionInput,
} from "@/lib/tasks/task-next-action";

function input(over: Partial<TaskNextActionInput> = {}): TaskNextActionInput {
  return {
    taskStatus: "Backlog",
    launchable: true,
    latestRun: null,
    completionReady: false,
    canAct: true,
    ...over,
  };
}

const run = (
  status: NonNullable<TaskNextActionInput["latestRun"]>["status"],
  hasPr = false,
) => ({ status, hasPr });

describe("taskNextAction (D10 state → actions)", () => {
  it.each<
    [string, Partial<TaskNextActionInput>, ReturnType<typeof taskNextAction>]
  >([
    [
      "launchable Backlog",
      {},
      {
        primary: "launch",
        secondary: ["send_to_triage", "run_agent", "queue"],
      },
    ],
    [
      "blocked Backlog",
      { launchable: false },
      {
        primary: "blocked",
        secondary: ["send_to_triage", "run_agent", "queue"],
      },
    ],
    [
      "running attempt",
      { taskStatus: "InFlight", latestRun: run("Running") },
      { primary: "open_run", secondary: ["queue", "run_agent"] },
    ],
    [
      "pending attempt",
      { taskStatus: "InFlight", latestRun: run("Pending") },
      { primary: "open_run", secondary: ["queue", "run_agent"] },
    ],
    [
      "needs input",
      { taskStatus: "InFlight", latestRun: run("NeedsInputIdle") },
      { primary: "respond", secondary: [] },
    ],
    [
      "review, not completable",
      { taskStatus: "InFlight", latestRun: run("Review") },
      { primary: "open_review", secondary: [] },
    ],
    [
      "review, completable",
      {
        taskStatus: "InFlight",
        latestRun: run("Review"),
        completionReady: true,
      },
      { primary: "open_review", secondary: ["complete"] },
    ],
    [
      "PR open",
      { taskStatus: "InFlight", latestRun: run("Done", true) },
      { primary: "open_pr", secondary: ["run_again"] },
    ],
    [
      "PR merged and completable",
      {
        taskStatus: "InFlight",
        latestRun: run("Done", true),
        completionReady: true,
      },
      { primary: "complete", secondary: ["open_pr", "run_again"] },
    ],
    [
      "failed attempt",
      { taskStatus: "InFlight", latestRun: run("Failed") },
      { primary: "run_again", secondary: ["open_run", "run_agent", "queue"] },
    ],
    [
      "Done task",
      { taskStatus: "Done", latestRun: run("Done", true) },
      { primary: "result", secondary: ["new_attempt", "send_to_triage"] },
    ],
    [
      "Abandoned task",
      { taskStatus: "Abandoned" },
      { primary: "abandoned", secondary: [] },
    ],
    [
      "read-only viewer keeps the primary, loses every secondary",
      { canAct: false },
      { primary: "launch", secondary: [] },
    ],
  ])("%s", (_name, over, expected) => {
    expect(taskNextAction(input(over))).toEqual(expected);
  });
});
