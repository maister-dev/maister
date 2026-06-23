import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, refresh: () => {} }),
}));

import { PackagesList } from "@/components/studio/packages-list";

const groups = [
  {
    key: "a",
    name: "aif",
    sourceUrl: "file:///x",
    isLocal: true,
    needsTrust: false,
    counts: { flows: 5, skills: 2, agents: 0, mcps: 0, rules: 0 },
    versions: [
      {
        installId: "i",
        versionLabel: "local-dev",
        trustStatus: "trusted_by_policy",
      },
    ],
    attachedProjectCount: 1,
  },
];

describe("PackagesList", () => {
  it("renders one row per package with member counts and a detail link", () => {
    const html = renderToStaticMarkup(
      createElement(PackagesList, { groups: groups as never }),
    );

    expect(html).toContain("aif");
    expect(html).toContain("/studio/packages/aif"); // ref = name
    expect(html).toContain("5"); // flows count
    expect(html).toMatch(/local/i); // Local badge
  });

  it("offers a create-package affordance", () => {
    const html = renderToStaticMarkup(
      createElement(PackagesList, { groups: groups as never }),
    );

    expect(html).toContain('data-testid="studio-new-package"');
  });
});
