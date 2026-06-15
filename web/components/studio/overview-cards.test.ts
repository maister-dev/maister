import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

import { OverviewCards } from "@/components/studio/overview-cards";

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
  {
    key: "b",
    name: "bugfix",
    sourceUrl: "github.com/x",
    isLocal: false,
    needsTrust: true,
    counts: { flows: 1, skills: 0, agents: 0, mcps: 0, rules: 0 },
    versions: [
      { installId: "j", versionLabel: "v0.0.1", trustStatus: "untrusted" },
    ],
    attachedProjectCount: 0,
  },
];

describe("OverviewCards", () => {
  it("shows counts and a needs-attention entry for untrusted packages", () => {
    const html = renderToStaticMarkup(
      createElement(OverviewCards, { groups: groups as never, isAdmin: true }),
    );

    expect(html).toContain("2"); // package count
    expect(html).toContain("bugfix"); // untrusted → needs attention
    expect(html).toContain("/studio/packages");
  });

  it("hides the Sources card for non-admins", () => {
    const html = renderToStaticMarkup(
      createElement(OverviewCards, { groups: [] as never, isAdmin: false }),
    );

    expect(html).not.toContain("/studio/sources");
  });
});
