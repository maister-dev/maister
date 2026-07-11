import type { BacklogCard } from "@/lib/queries/board";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/components/board/launch-popover", () => ({
  LaunchPopover: () => null,
}));
vi.mock("@/components/board/task-card-editing", () => ({
  TaskCardEditModal: () => null,
  TaskInlineEditableField: () => null,
}));
vi.mock("@/components/board/task-decomposition", () => ({
  TaskDecomposition: () => null,
}));
vi.mock("@/components/board/task-queue-controls", () => ({
  TaskQueueControls: () => null,
}));

import { TaskCard } from "@/components/board/task-card";

const card: BacklogCard = {
  taskId: "task-1",
  number: 7,
  keyRef: "MAI-7",
  title: "Incompatible Flow task",
  prompt: "Repair the graph",
  flowRef: "bugfix",
  flowIncompatibility: {
    kind: "legacy_steps",
    reason:
      "legacy steps[] flows are not supported since engine 3.0.0; republish the package with nodes[]",
  },
  priority: "high",
  taskPriority: "normal",
  queuePaused: false,
  triageConfidence: null,
  runCount: 0,
  blockedBy: [],
  flowId: "flow-1",
  triageStatus: "triaged",
  runnerId: null,
  baseBranch: null,
  targetBranch: null,
  promotionMode: null,
  executionPolicy: null,
  relations: [],
  childTasks: [],
};

describe("TaskCard launch incompatibility", () => {
  it("renders a visible reason beside the disabled launch affordance", () => {
    const reason =
      "Republish the package with a non-empty nodes[] graph before launching.";
    const html = renderToStaticMarkup(
      createElement(TaskCard, {
        blockedByLabel: "Blocked by",
        canAct: true,
        card,
        decompositionLabels: {
          noRun: "No run",
          status: {
            Abandoned: "Abandoned",
            Crashed: "Crashed",
            Done: "Done",
            Failed: "Failed",
            HumanWorking: "Human working",
            NeedsInput: "Needs input",
            NeedsInputIdle: "Needs input idle",
            Pending: "Pending",
            Review: "Review",
            Running: "Running",
            WaitingOnChildren: "Waiting on children",
          },
          title: () => "Children",
        },
        flaggedLabel: "Flagged",
        launchDisabledLabel: "Launch unavailable",
        launchDisabledReason: reason,
        launchLabel: "Launch",
        queueControlsLabels: {
          error: "Error",
          pause: "Pause",
          paused: "Paused",
          priorityHigh: "High",
          priorityLow: "Low",
          priorityNormal: "Normal",
          priorityUrgent: "Urgent",
          resume: "Resume",
        },
        relationCandidates: [],
        runsCountLabel: (count) => `${count} runs`,
        slug: "maister",
        triagedLabel: "Triaged",
        unconfiguredLabel: "Unconfigured",
      }),
    );

    expect(html).toContain('data-testid="task-card-launch-unavailable-reason"');
    expect(html).toContain(reason);
  });
});
