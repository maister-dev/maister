import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, refresh: () => {} }),
}));

import {
  LocalPackagesList,
  type LocalPackageListItem,
} from "@/components/studio/local-packages-list";

const ACTIVE: LocalPackageListItem = {
  id: "p1",
  name: "My Pack",
  slug: "my-pack",
  isDefault: false,
  status: "active",
};
const ARCHIVED: LocalPackageListItem = {
  id: "p2",
  name: "Old Pack",
  slug: "old-pack",
  isDefault: false,
  status: "archived",
};

function render(packages: LocalPackageListItem[]): string {
  return renderToStaticMarkup(createElement(LocalPackagesList, { packages }));
}

describe("LocalPackagesList", () => {
  it("renders the per-row management action cluster for an active package", () => {
    const html = render([ACTIVE]);

    expect(html).toContain('data-testid="local-new"');
    expect(html).toContain('data-testid="local-rename"');
    expect(html).toContain('data-testid="local-cut"');
    expect(html).toContain('data-testid="local-archive"');
    expect(html).toContain('data-testid="local-delete"');
    expect(html).toContain('data-testid="local-import"');
    expect(html).toContain("My Pack");
  });

  it("hides archived rows by default but offers a show-archived toggle", () => {
    const html = render([ACTIVE, ARCHIVED]);

    // Archived rows are hidden until the toggle is enabled (a client action).
    expect(html).not.toContain("Old Pack");
    expect(html).toContain('data-testid="local-show-archived"');
  });

  it("shows the empty state when there are no packages", () => {
    const html = render([]);

    expect(html).toContain("local.empty");
    expect(html).not.toContain('data-testid="local-list"');
  });
});
