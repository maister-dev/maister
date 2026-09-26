import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { TaskUserClarifications } from "@/components/board/task-user-clarifications";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

const labels = {
  title: "Clarifications",
  blocking: "Blocks launch",
  nonBlocking: "Does not block launch",
  requestedBy: "Requested by",
  recipient: "For",
  reason: "Reason",
  open: "Open",
  answered: "Answered",
  cancelled: "Cancelled",
  superseded: "Corrected",
  answer: "Answer",
  submit: "Send answer",
  cancel: "Cancel request",
  recipientUnavailable: "Recipient can no longer answer",
  yes: "Yes",
  no: "No",
};

const row = {
  id: "question-1",
  seq: 1,
  originKind: "user" as const,
  originRunId: null,
  originAgentId: null,
  sourceHitlRequestId: null,
  reTriggerMode: "none" as const,
  requesterUserId: "requester",
  recipientUserId: "recipient",
  question: "Which region?",
  reason: "Deployment target is unclear",
  answerFormat: "text" as const,
  blocking: true,
  status: "open" as const,
  cancelReason: null,
  answer: null,
  answeredAt: null,
  supersededAt: null,
};

function render(userId: string, eligible = true): string {
  return renderToStaticMarkup(
    createElement(TaskUserClarifications, {
      history: [row],
      userId,
      canAct: true,
      recipientEligibleById: { recipient: eligible },
      nameById: { requester: "Alice", recipient: "Bob" },
      slug: "project",
      taskNumber: 3,
      labels,
    }),
  );
}

describe("TaskUserClarifications", () => {
  it("shows the addressed answer form to the recipient", () => {
    const html = render("recipient");

    expect(html).toContain("Which region?");
    expect(html).toContain("Blocks launch");
    expect(html).toContain("Send answer");
    expect(html).not.toContain("Cancel request");
  });

  it("shows requester cancellation and a live eligibility warning", () => {
    const html = render("requester", false);

    expect(html).toContain("Cancel request");
    expect(html).toContain("Recipient can no longer answer");
    expect(html).not.toContain("Send answer");
  });
});
