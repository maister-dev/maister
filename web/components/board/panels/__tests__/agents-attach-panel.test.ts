// M34 (ADR-089 D11) — the per-project attach panel: attached rows with
// schedule summaries, the attach picker for canManage admins, read-only
// rendering otherwise. renderToStaticMarkup — no jsdom (repo convention).

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({
  useTranslations: (namespace: string) => (key: string) =>
    `${namespace}.${key}`,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

import {
  AgentsAttachPanel,
  type AttachedAgentRow,
} from "@/components/board/panels/agents-attach-panel";

const ATTACHED: AttachedAgentRow = {
  linkId: "11111111-1111-4111-8111-111111111111",
  enabled: true,
  runnerOverrideId: "runner-2",
  schedules: [
    {
      triggerType: "cron",
      cronExpr: "*/30 * * * *",
      timezone: "UTC",
      enabled: true,
    },
    {
      triggerType: "event",
      eventKinds: ["task.created", "task.comment_added"],
      enabled: true,
    },
  ],
  agent: {
    id: "aif:triager",
    name: "Triager",
    flowRefId: "aif",
    workspace: "none",
    mode: "session",
    triggers: ["manual", "domain_event"],
    riskTier: "read_only",
    enabled: true,
    quarantinedAt: null,
  },
};

function render(over: {
  canManage?: boolean;
  attached?: AttachedAgentRow[];
}): string {
  return renderToStaticMarkup(
    createElement(AgentsAttachPanel, {
      slug: "demo",
      canManage: over.canManage ?? true,
      attached: over.attached ?? [ATTACHED],
      available: [
        {
          id: "aif:reviewer",
          name: "Reviewer",
          flowRefId: "aif",
          recommended: null,
        },
      ],
      runners: [{ id: "runner-2", label: "runner-2" }],
      eventKinds: ["task.created", "task.comment_added"],
    }),
  );
}

describe("AgentsAttachPanel (M34 D11)", () => {
  it("renders the attached row with runner override and trigger-binding summary", () => {
    const html = render({});

    expect(html).toContain("triager");
    expect(html).toContain("runner-2");
    expect(html).toContain("cron */30 * * * *");
    expect(html).toContain("event task.created|task.comment_added");
    expect(html).toContain("agentsAttach.detach");
    expect(html).toContain("agentsAttach.edit");
  });

  it("renders the attach picker for managers and hides actions otherwise", () => {
    const manager = render({});

    expect(manager).toContain("agentsAttach.attach");

    const viewer = render({ canManage: false });

    expect(viewer).not.toContain("agentsAttach.attach");
    expect(viewer).not.toContain("agentsAttach.detach");
  });

  it("renders the empty state without attachments", () => {
    const html = render({ attached: [] });

    expect(html).toContain("agentsAttach.empty");
  });
});
