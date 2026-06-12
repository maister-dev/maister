// M33 (ADR-088 D11/D13) — the task-detail agent actions: manual agent
// launch (picker + button when manual-capable agents are attached) and the
// always-available "Send to triage" emitter trigger.
// renderToStaticMarkup — no jsdom (repo convention).

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

import { TaskAgentActions } from "@/components/social/task-agent-actions";

const LABELS = {
  runAgent: "Run agent",
  sendToTriage: "Send to triage",
  busy: "Working…",
  agentPickerLabel: "Agent to run",
};

function render(agents: Array<{ id: string; name: string }>): string {
  return renderToStaticMarkup(
    createElement(TaskAgentActions, {
      slug: "demo",
      taskId: "22222222-2222-4222-8222-222222222222",
      taskNumber: 7,
      agents,
      labels: LABELS,
    }),
  );
}

describe("TaskAgentActions (M33 D11/D13)", () => {
  it("renders the agent picker + run button when manual agents exist", () => {
    const html = render([{ id: "triager", name: "Triager" }]);

    expect(html).toContain("Agent to run");
    expect(html).toContain("Triager");
    expect(html).toContain("Run agent");
    expect(html).toContain("Send to triage");
  });

  it("renders only Send to triage when no manual agents are attached", () => {
    const html = render([]);

    expect(html).not.toContain("Run agent");
    expect(html).toContain("Send to triage");
  });
});
