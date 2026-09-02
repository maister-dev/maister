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

// ADR-163: a delegated child task (a flow child's carrier, an as-plan task) is
// a `parent_of` TARGET. Its card used to be indistinguishable from a user task;
// the only provenance lived under the ORCHESTRATOR's card. The card now names
// its parent, and warns that a launch from here leaves the orchestrator's tree
// (a relaunch after the parent was abandoned produces a lineage-less run).

function card(over: Partial<BacklogCard> = {}): BacklogCard {
  return {
    taskId: "task-1",
    number: 7,
    keyRef: "MAI-7",
    title: "Fix collect 500",
    prompt: "Fix the 500 on collect",
    flowRef: "bugfix",
    flowIncompatibility: null,
    priority: "high",
    taskPriority: "normal",
    queuePaused: false,
    triageConfidence: null,
    awaitingClarification: false,
    runCount: 1,
    blockedBy: [],
    flowId: "flow-1",
    triageStatus: null,
    runnerId: null,
    baseBranch: null,
    targetBranch: null,
    promotionMode: null,
    executionPolicy: null,
    relations: [],
    childTasks: [],
    parentTask: { keyRef: "MAI-3", number: 3, projectSlug: "maister" },
    ...over,
  };
}

function render(c: BacklogCard, canAct = true): string {
  return renderToStaticMarkup(
    createElement(TaskCard, {
      awaitingClarificationLabel: "Awaiting clarification",
      blockedByLabel: "Blocked by",
      canAct,
      card: c,
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
      delegatedByLabel: "delegated by",
      delegatedRelaunchHint:
        "Delegated child of MAI-3 — a launch from this card starts a run outside its orchestrator's tree.",
      flaggedLabel: "Flagged",
      launchDisabledLabel: "Launch unavailable",
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
}

describe("TaskCard — delegated-child provenance (ADR-163)", () => {
  it("renders the parent chip linking to the orchestrator's task", () => {
    const html = render(card());

    expect(html).toContain('data-testid="task-card-delegated-by"');
    expect(html).toContain("delegated by");
    expect(html).toContain("MAI-3");
    expect(html).toContain('href="/projects/maister/tasks/3"');
  });

  it("warns before a relaunch that a launch from the card leaves the orchestrator's tree", () => {
    const html = render(card({ runCount: 1 }));

    expect(html).toContain('data-testid="task-card-delegated-relaunch-hint"');
    expect(html).toContain("outside its orchestrator");
  });

  it("shows no relaunch warning on a never-launched carrier, and none when the viewer cannot act", () => {
    expect(render(card({ runCount: 0 }))).not.toContain(
      "task-card-delegated-relaunch-hint",
    );
    expect(render(card({ runCount: 1 }), false)).not.toContain(
      "task-card-delegated-relaunch-hint",
    );
  });

  it("renders neither chip nor warning on a task with no parent", () => {
    const html = render(card({ parentTask: null }));

    expect(html).not.toContain("task-card-delegated-by");
    expect(html).not.toContain("task-card-delegated-relaunch-hint");
  });
});
