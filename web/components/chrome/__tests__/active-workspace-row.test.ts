import type { ActiveWorkspaceRowLabels } from "@/components/chrome/active-workspace-row";
import type { RailWorkspaceRow } from "@/lib/queries/portfolio";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({
  useTranslations: (namespace: string) => (key: string) =>
    `${namespace}.${key}`,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

import { ActiveWorkspaceRow } from "@/components/chrome/active-workspace-row";

function baseRow(over: Partial<RailWorkspaceRow> = {}): RailWorkspaceRow {
  return {
    runId: "run-1",
    runKind: "flow",
    name: "KEY-1 Fix the thing",
    branch: "maister/fix",
    executorLabel: "runner-1 · claude · claude-sonnet-4-6",
    launchedBy: "User",
    statusLabel: "Running",
    statusTone: "running",
    time: "3m",
    href: "/runs/run-1",
    latestActivityAt: new Date("2026-06-15T10:00:00.000Z"),
    ttlState: "active",
    effectiveRemovalAt: null,
    archived: false,
    pruned: false,
    lifecycleActions: [],
    flowRefLabel: "flow-x",
    flowVersion: "v1.0.0",
    taskKey: "KEY",
    taskNumber: 1,
    issueHref: "/projects/p/tasks/1",
    runnerDetail: {
      agent: "claude",
      model: "claude-sonnet-4-6",
      adapter: "claude",
      provider: "anthropic",
      sidecar: null,
    },
    ...over,
  };
}

function baseLabels(
  over: Partial<ActiveWorkspaceRowLabels> = {},
): ActiveWorkspaceRowLabels {
  return {
    statusWord: "Running",
    attention: false,
    flowLabel: "flow-x",
    flowTooltip: "flow-x · v1.0.0",
    flowAria: "Flow flow-x",
    runnerLabel: "claude-sonnet-4-6",
    runnerTooltip: "Agent: claude · Model: claude-sonnet-4-6",
    runnerAria: "Runner claude-sonnet-4-6",
    issueLabel: "KEY-1",
    issueAria: "Open task KEY-1",
    ttlTone: null,
    ttlLabel: null,
    ttlCountdown: null,
    archivedLabel: null,
    rename: {
      action: "Rename",
      placeholder: "Workspace name",
      confirm: "Save",
      cancel: "Cancel",
      busy: "Saving…",
      error: "Rename failed",
    },
    ...over,
  };
}

function render(
  row: RailWorkspaceRow,
  labels: ActiveWorkspaceRowLabels,
): string {
  return renderToStaticMarkup(
    createElement(ActiveWorkspaceRow, { row, labels }),
  );
}

describe("ActiveWorkspaceRow", () => {
  it("a running row pulses its dot and shows no inline status word", () => {
    const html = render(baseRow(), baseLabels());

    expect(html).toContain('data-status-tone="running"');
    expect(html).toContain("animate-[pulse-dot");
    expect(html).not.toContain('data-testid="status-word"');
  });

  it("an attention state shows the inline status word on the warm attention tone", () => {
    const html = render(
      baseRow({ statusLabel: "NeedsInput", statusTone: "needs" }),
      baseLabels({ statusWord: "Needs input", attention: true }),
    );

    expect(html).toContain('data-testid="status-word"');
    expect(html).toContain("Needs input");
    expect(html).toContain('data-status-tone="needs"');
    expect(html).toContain("bg-attention");
  });

  it("a crashed row uses the danger dot tone and surfaces the word", () => {
    const html = render(
      baseRow({ statusLabel: "Crashed", statusTone: "crashed" }),
      baseLabels({ statusWord: "Crashed", attention: true }),
    );

    expect(html).toContain('data-status-tone="crashed"');
    expect(html).toContain("bg-danger");
    expect(html).toContain('data-testid="status-word"');
  });

  it("renders the rename pencil only for scratch runs", () => {
    const flow = render(baseRow({ runKind: "flow" }), baseLabels());

    expect(flow).not.toContain('data-testid="rename-pencil"');
    expect(flow).not.toContain('data-testid="rename-pencil-icon"');

    const scratch = render(
      baseRow({ runKind: "scratch", href: "/scratch-runs/run-1" }),
      baseLabels(),
    );

    expect(scratch).toContain('data-testid="rename-pencil"');
    expect(scratch).toContain('data-testid="rename-pencil-icon"');
    expect(scratch).toContain('viewBox="0 0 24 24"');
  });

  it("renders the flow, runner, and issue chips when present", () => {
    const html = render(baseRow(), baseLabels());

    expect(html).toContain('data-testid="flow-chip"');
    expect(html).toContain('data-testid="flow-chip-icon"');
    expect(html).toContain('data-testid="runner-chip"');
    expect(html).toContain('data-testid="runner-chip-icon"');
    expect(html).toContain('data-testid="issue-chip"');
    expect(html).toContain('viewBox="0 0 24 24"');
    expect(html).toContain("KEY-1");
  });

  it("hides the issue chip when the run resolves no task", () => {
    const html = render(
      baseRow({ issueHref: null, taskKey: null, taskNumber: null }),
      baseLabels({ issueLabel: null, issueAria: null }),
    );

    expect(html).not.toContain('data-testid="issue-chip"');
    // flow + runner chips still render.
    expect(html).toContain('data-testid="flow-chip"');
    expect(html).toContain('data-testid="runner-chip"');
  });

  it("hides the flow and runner chips when their detail is absent", () => {
    const html = render(
      baseRow({ flowRefLabel: null, flowVersion: null, runnerDetail: null }),
      baseLabels({
        flowLabel: null,
        flowTooltip: null,
        flowAria: null,
        runnerLabel: null,
        runnerTooltip: null,
        runnerAria: null,
      }),
    );

    expect(html).not.toContain('data-testid="flow-chip"');
    expect(html).not.toContain('data-testid="runner-chip"');
  });

  it("renders the lifecycle icon actions for the run's available actions", () => {
    const html = render(baseRow({ lifecycleActions: ["stop"] }), baseLabels());

    expect(html).toContain('data-testid="workbench-lifecycle-actions"');
  });
});
