// M34 (ADR-089 D11) — the per-project attach panel: attached rows with
// schedule summaries, the attach picker for canManage admins, read-only
// rendering otherwise. M39 (ADR-106) adds the per-instance policy column +
// the edit-modal controls (branch base, 3-way auto-apply, on-budget-breach).
// renderToStaticMarkup — no jsdom (repo convention).

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

import { AttachEditModal } from "@/components/board/panels/agents-attach-edit-modal";
import {
  AgentsAttachPanel,
  type AttachedAgentRow,
} from "@/components/board/panels/agents-attach-panel";

const ATTACHED: AttachedAgentRow = {
  linkId: "11111111-1111-4111-8111-111111111111",
  enabled: true,
  runnerOverrideId: "runner-2",
  branchBase: "develop",
  executionPolicyOverride: {
    autoApply: "full",
    onBudgetBreach: "terminate_restorable",
  },
  config: null,
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
    packageName: "aif",
    workspace: "none",
    mode: "session",
    triggers: ["manual", "domain_event"],
    riskTier: "read_only",
    enabled: true,
    quarantinedAt: null,
    recommended: null,
    configSchema: null,
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
          packageName: "aif",
          recommended: null,
          configSchema: null,
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

  it("renders the per-instance policy summary column (M39)", () => {
    const html = render({});

    expect(html).toContain("agentsAttach.colPolicy");
    // policySummary() folds branch base + the {autoApply, onBudgetBreach}
    // override into one terse cell.
    expect(html).toContain("develop");
    expect(html).toContain("auto:full");
    expect(html).toContain("budget:terminate_restorable");
  });

  it("shows a disabled attachment and an em-dash policy when nothing is overridden", () => {
    const html = render({
      attached: [
        {
          ...ATTACHED,
          enabled: false,
          branchBase: null,
          executionPolicyOverride: null,
        },
      ],
    });

    // Enabled cell renders the em-dash; policy summary collapses to "—" too.
    expect(html).toContain("—");
    expect(html).not.toContain("auto:full");
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

describe("AttachEditModal (M39 instance policy controls)", () => {
  function renderModal(): string {
    return renderToStaticMarkup(
      createElement(AttachEditModal, {
        slug: "demo",
        row: ATTACHED,
        runners: [{ id: "runner-2", label: "runner-2" }],
        eventKinds: ["task.created"],
        onClose: vi.fn(),
        onSaved: vi.fn(),
      }),
    );
  }

  it("renders the 3-way auto-apply control (off / permissions / full)", () => {
    const html = renderModal();

    expect(html).toContain("agentsAttach.autoApply");
    expect(html).toContain("agentsAttach.autoApplyOff");
    expect(html).toContain("agentsAttach.autoApplyPermissions");
    expect(html).toContain("agentsAttach.autoApplyFull");
  });

  it("renders the on-budget-breach control and the branch-base field", () => {
    const html = renderModal();

    expect(html).toContain("agentsAttach.branchBase");
    expect(html).toContain("agentsAttach.onBudgetBreach");
    expect(html).toContain("agentsAttach.budgetEscalate");
    expect(html).toContain("agentsAttach.budgetTerminate");
    expect(html).toContain("agentsAttach.budgetTerminateRestorable");
  });
});
