// Render test for the searchable branch picker (no jsdom — renderToStaticMarkup).
// next/navigation hooks are read at render, so stub the three used here.

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
  it("renders a searchable input seeded with the current branch", () => {
    const markup = render({ current: "develop" });

    expect(markup).toContain('aria-label="Branch"');
    expect(markup).toContain("list=");
    expect(markup).toContain('value="develop"');
  });

  it("renders every branch as a datalist option for typeahead", () => {
    const markup = render({});

    expect(markup).toContain("<datalist");
    expect(markup).toContain('value="main"');
    expect(markup).toContain('value="develop"');
    expect(markup).toContain('value="feature/x"');
  });
});
