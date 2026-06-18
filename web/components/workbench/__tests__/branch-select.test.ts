// Render test for the searchable branch combobox (no jsdom —
// renderToStaticMarkup). next/navigation hooks are read at render, so stub the
// three used here. The dropdown is opened by focus (a client effect), which
// does not run under static markup, so these assert the collapsed contract; the
// open/filter behavior is exercised in the browser.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => "/projects/acme",
  useSearchParams: () => new URLSearchParams(),
}));

import { BranchSelect } from "@/components/workbench/branch-select";

function render(props: Partial<Parameters<typeof BranchSelect>[0]>): string {
  return renderToStaticMarkup(
    createElement(BranchSelect, {
      branches: ["main", "develop", "feature/x"],
      current: "main",
      defaultBranch: "main",
      label: "Branch",
      ...props,
    }),
  );
}

describe("BranchSelect", () => {
  it("renders a combobox input seeded with the current branch", () => {
    const markup = render({ current: "develop" });

    expect(markup).toContain('role="combobox"');
    expect(markup).toContain('aria-label="Branch"');
    expect(markup).toContain('value="develop"');
  });

  it("keeps the dropdown collapsed until focus (no listbox initially)", () => {
    const markup = render({});

    expect(markup).toContain('aria-expanded="false"');
    expect(markup).not.toContain('role="listbox"');
  });
});
