import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { TaskClarificationHistory } from "@/components/board/task-clarification-history";

describe("TaskClarificationHistory", () => {
  it("shows the active condition and only ordered answered clarification history", () => {
    const html = renderToStaticMarkup(
      createElement(TaskClarificationHistory, {
        awaitingClarification: true,
        history: [
          {
            id: "later",
            seq: 2,
            question: "Second?",
            answer: { target: "production" },
            answeredAt: new Date("2026-07-13T12:00:00.000Z"),
            supersededAt: null,
            sourceHitlRequestId: "hitl-2",
            originRunId: "run-2",
            originAgentId: "agent-2",
            reTriggerMode: "agent",
          },
          {
            id: "first",
            seq: 1,
            question: "First?",
            answer: { target: "staging" },
            answeredAt: new Date("2026-07-13T11:00:00.000Z"),
            supersededAt: null,
            sourceHitlRequestId: "hitl-1",
            originRunId: "run-1",
            originAgentId: "agent-1",
            reTriggerMode: "agent",
          },
          {
            id: "superseded",
            seq: 3,
            question: "Do not render?",
            answer: { target: "obsolete" },
            answeredAt: new Date("2026-07-13T13:00:00.000Z"),
            supersededAt: new Date("2026-07-13T14:00:00.000Z"),
            sourceHitlRequestId: "hitl-3",
            originRunId: "run-3",
            originAgentId: "agent-3",
            reTriggerMode: "agent",
          },
        ],
        labels: {
          answer: "Answer",
          awaiting: "Awaiting clarification",
          question: "Question",
          title: "Clarifications",
        },
      }),
    );

    expect(html).toContain('data-testid="task-awaiting-clarification"');
    expect(html).toContain("First?");
    expect(html).toContain("Second?");
    expect(html.indexOf("First?")).toBeLessThan(html.indexOf("Second?"));
    expect(html).not.toContain("Do not render?");
  });
});
