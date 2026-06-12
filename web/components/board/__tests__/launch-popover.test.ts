import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// CONTRACT under test — `components/board/launch-popover.tsx` (M18 T1.5).
// The board Launch control is modal-first: the primary button opens a dialog
// that loads `/api/runs/launch-options` and then POSTs `/api/runs` with the
// selected flow, runner, branches, and delivery policy. The dialog is NOT in
// the DOM until opened, so the default render never fetches launch options.
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

import { LaunchPopover } from "@/components/board/launch-popover";

function render(over: Partial<Record<string, string>> = {}): string {
  return renderToStaticMarkup(
    createElement(LaunchPopover, {
      taskId: "task-1",
      label: "launch",
      disabledLabel: "unavailable",
      ...over,
    }),
  );
}

describe("LaunchPopover — modal-first launch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the launch dialog trigger with the threaded label", () => {
    const html = render();

    expect(html).toContain("launch");
    expect(html).not.toContain('role="dialog"');
  });

  it("does not render launch option controls until it is opened", () => {
    const html = render();

    // The dialog and its branch-select labels are absent on the initial render.
    expect(html).not.toContain("run.baseBranch");
    expect(html).not.toContain("run.targetBranch");
    expect(html).not.toContain("<select");
  });

  it("renders the disabled label and disables the trigger when a reason is set", () => {
    const html = render({ disabledReason: "supervisor offline" });

    expect(html).toContain("unavailable");
    expect(html.match(/disabled=""/g)?.length).toBe(1);
  });
});
