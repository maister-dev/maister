import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

import { LocalPackagesList } from "@/components/studio/local-packages-list";

describe("LocalPackagesList", () => {
  it("offers delete only for unattached local packages", () => {
    const html = renderToStaticMarkup(
      createElement(LocalPackagesList, {
        packages: [
          {
            id: "named",
            name: "Named pack",
            slug: "named-pack",
            isDefault: false,
            canDelete: true,
          },
          {
            id: "default",
            name: "Project default",
            slug: "project-default",
            isDefault: true,
            canDelete: false,
          },
        ],
      }),
    );

    expect(html).toContain('data-testid="local-delete-named"');
    expect(html).not.toContain('data-testid="local-delete-default"');
    expect(html).toContain("local.unattachedBadge");
    expect(html).toContain("local.defaultBadge");
  });
});
