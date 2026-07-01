import type { TaskQueueControlsLabels } from "@/components/board/task-queue-controls";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

import { TaskQueueControls } from "@/components/board/task-queue-controls";

const labels: TaskQueueControlsLabels = {
  priorityLow: "low",
  priorityNormal: "normal",
  priorityHigh: "high",
  priorityUrgent: "urgent",
  pause: "Pause in queue",
  resume: "Resume in queue",
  paused: "paused",
  error: "Could not save the task.",
};

describe("TaskQueueControls", () => {
  it("renders a visible badge for a high-priority task and the pause button", () => {
    const html = renderToStaticMarkup(
      createElement(TaskQueueControls, {
        slug: "maister",
        taskNumber: 7,
        taskPriority: "high",
        queuePaused: false,
        canAct: true,
        labels,
      }),
    );

    expect(html).toContain('data-testid="task-priority-badge"');
    expect(html).toContain("high");
    expect(html).toContain('aria-label="Pause in queue"');
    expect(html).not.toContain('data-testid="task-queue-paused"');
  });

  it("omits the priority badge for a normal-priority task", () => {
    const html = renderToStaticMarkup(
      createElement(TaskQueueControls, {
        slug: "maister",
        taskNumber: 7,
        taskPriority: "normal",
        queuePaused: false,
        canAct: true,
        labels,
      }),
    );

    expect(html).not.toContain('data-testid="task-priority-badge"');
    expect(html).toContain('aria-label="Pause in queue"');
  });

  it("renders the paused chip and a resume affordance when paused", () => {
    const html = renderToStaticMarkup(
      createElement(TaskQueueControls, {
        slug: "maister",
        taskNumber: 7,
        taskPriority: "urgent",
        queuePaused: true,
        canAct: true,
        labels,
      }),
    );

    expect(html).toContain('data-testid="task-queue-paused"');
    expect(html).toContain("paused");
    expect(html).toContain('aria-label="Resume in queue"');
  });

  it("hides the pause button when the viewer cannot act", () => {
    const html = renderToStaticMarkup(
      createElement(TaskQueueControls, {
        slug: "maister",
        taskNumber: 7,
        taskPriority: "high",
        queuePaused: false,
        canAct: false,
        labels,
      }),
    );

    expect(html).toContain('data-testid="task-priority-badge"');
    expect(html).not.toContain('aria-label="Pause in queue"');
  });
});
