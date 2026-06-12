import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// CONTRACT under test — `components/board/launch-popover.tsx` (M18 T1.5).
// The board Launch control is a compact popover that PRESERVES the one-click
// default: the primary button POSTs `/api/runs` with only `{ taskId }` (base =
// project default, target = base — no branch fields). A separate "Advanced"
// toggle (aria-expanded) discloses base/target branch selects; the panel is NOT
// in the DOM until opened, so the default render never fetches branches.
//
// `LaunchPopover` is a "use client" component using `useTranslations`,
// `useRouter`, and React hooks, so this render harness mocks `next-intl` +
// `next/navigation` at the module boundary (the repo's component tests are
// otherwise pure-render; these two hooks are the only context this needs).
// renderToStaticMarkup — no jsdom (repo convention).
// ---------------------------------------------------------------------------

vi.mock("next-intl", () => ({
  useTranslations: (namespace: string) => (key: string) =>
    `${namespace}.${key}`,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

import {
  LaunchPopover,
  type LaunchPopoverProps,
} from "@/components/board/launch-popover";

function render(over: Partial<LaunchPopoverProps> = {}): string {
  return renderToStaticMarkup(
    createElement(LaunchPopover, {
      taskId: "task-1",
      projectId: "project-1",
      slug: "demo",
      taskNumber: 1,
      // M33: a configured task — flowId set keeps the one-click default.
      verdict: {
        flowId: "flow-1",
        runnerId: null,
        targetBranch: null,
        promotionMode: null,
      },
      flowOptions: [{ id: "flow-1", label: "bugfix" }],
      runnerOptions: [{ id: "runner-1", label: "runner-1" }],
      label: "launch",
      disabledLabel: "unavailable",
      ...over,
    }),
  );
}

describe("LaunchPopover — one-click default (M18 T1.5)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the one-click Launch button with the threaded label", () => {
    const html = render();

    expect(html).toContain("launch");
    // The advanced toggle exists and is collapsed by default.
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-label="launch.advanced"');
  });

  it("does not render the advanced branch panel until it is opened", () => {
    const html = render();

    // The disclosure panel (and its branch-select labels) is absent on the
    // happy path — the default launch is a no-branch one-click POST.
    expect(html).not.toContain("run.baseBranch");
    expect(html).not.toContain("run.targetBranch");
    expect(html).not.toContain("<select");
  });

  it("renders the disabled label and disables both controls when a reason is set", () => {
    const html = render({ disabledReason: "supervisor offline" });

    expect(html).toContain("unavailable");
    // Both the primary launch and the advanced toggle are disabled.
    expect(html.match(/disabled=""/g)?.length).toBe(2);
  });
});

describe("LaunchPopover — unconfigured task (M33, ADR-088 D11)", () => {
  it("replaces the one-click label with the set-up affordance when the task has no flow", () => {
    const html = render({
      verdict: {
        flowId: null,
        runnerId: null,
        targetBranch: null,
        promotionMode: null,
      },
    });

    // The primary button reads "set up & launch" — a flowless task cannot
    // one-click launch; the popover collects the missing fields.
    expect(html).toContain("launch.setUp");
    // The control itself stays enabled (it opens the advanced panel).
    expect(html.match(/disabled=""/g)?.length ?? 0).toBe(0);
  });
});
