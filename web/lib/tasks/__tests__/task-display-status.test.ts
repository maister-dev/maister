import { describe, expect, it } from "vitest";

import {
  deriveTaskDisplayStatus,
  TASK_DISPLAY_STATUS,
  type TaskDisplayStatusFacts,
} from "@/lib/tasks/task-display-status";

import en from "@/messages/en.json";
import ru from "@/messages/ru.json";

it("shares the English labels with MCP and translates every key to Russian", () => {
  const labels = Object.fromEntries(
    Object.entries(TASK_DISPLAY_STATUS).map(([key, { label }]) => [key, label]),
  );

  expect(en.taskDisplayStatus).toEqual(labels);
  expect(Object.keys(ru.taskDisplayStatus).sort()).toEqual(Object.keys(labels).sort());
});

const facts: TaskDisplayStatusFacts = {
  taskStatus: "Backlog",
  triageStatus: null,
  triageFlagOrigin: null,
  configuredFlow: true,
  incoming: false,
  blocked: false,
  qualificationAdmitted: true,
  manualAdmission: false,
  latestFlowStatus: null,
  workspaceRemoved: false,
};

describe("deriveTaskDisplayStatus", () => {
  it.each([
    [{ taskStatus: "Abandoned", triageStatus: "flagged", latestFlowStatus: "Crashed" }, "abandoned", "neutral"],
    [{ taskStatus: "Done", latestFlowStatus: "Running" }, "done", "success"],
    [{ latestFlowStatus: "Pending", blocked: true }, "queued", "neutral"],
    [{ latestFlowStatus: "Running" }, "in_progress", "accent"],
    [{ latestFlowStatus: "Waiting" }, "in_progress", "accent"],
    [{ latestFlowStatus: "WaitingOnChildren" }, "in_progress", "accent"],
    [{ latestFlowStatus: "NeedsInput" }, "waiting_on_human", "warning"],
    [{ latestFlowStatus: "NeedsInputIdle" }, "waiting_on_human", "warning"],
    [{ latestFlowStatus: "HumanWorking" }, "waiting_on_human", "warning"],
    [{ latestFlowStatus: "Review" }, "in_review", "accent"],
    [{ latestFlowStatus: "Crashed" }, "crashed", "danger"],
    [{ taskStatus: "InFlight", blocked: true }, "in_progress", "accent"],
    [{ taskStatus: "InFlight", latestFlowStatus: "Failed", blocked: true }, "blocked", "warning"],
    [{ latestFlowStatus: "Done" }, "done", "success"],
    [{ latestFlowStatus: "Done", workspaceRemoved: true }, "done", "success"],
    [{ incoming: true, blocked: true, triageStatus: "flagged", qualificationAdmitted: false }, "incoming", "neutral"],
    [{ blocked: true, triageStatus: "flagged" }, "blocked", "warning"],
    [{ triageStatus: "flagged", manualAdmission: true }, "needs_review", "warning"],
    [{ qualificationAdmitted: false }, "needs_review", "warning"],
    [{ qualificationAdmitted: false, manualAdmission: true, triageStatus: "flagged", triageFlagOrigin: "qualification" }, "ready", "success"],
    [{ latestFlowStatus: "Review", workspaceRemoved: true }, "ready", "success"],
    [{ latestFlowStatus: "Crashed", workspaceRemoved: true }, "ready", "success"],
    [{ latestFlowStatus: "Failed" }, "ready", "success"],
    [{ latestFlowStatus: "Abandoned", configuredFlow: false }, "backlog", "neutral"],
    [{ configuredFlow: false, triageStatus: "triaged" }, "backlog", "neutral"],
    [{}, "ready", "success"],
  ] as const)("projects %o as %s", (overrides, key, tone) => {
    expect(deriveTaskDisplayStatus({ ...facts, ...overrides })).toMatchObject({ key, tone });
  });
});
