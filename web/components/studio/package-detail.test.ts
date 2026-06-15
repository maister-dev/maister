import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

import { PackageDetail } from "@/components/studio/package-detail";

const pkg = {
  name: "aif",
  sourceUrl: "file:///x",
  isLocal: true,
  versions: [
    {
      installId: "i",
      versionLabel: "local-dev",
      trustStatus: "trusted_by_policy",
    },
  ],
  bom: {
    flows: [{ id: "aif-dev" }, { id: "aif-init" }],
    agents: [],
    skills: [{ id: "s1" }],
    mcps: [],
    rules: [],
  },
};

describe("PackageDetail", () => {
  it("renders bill-of-materials grouped by kind + a rework action", () => {
    const html = renderToStaticMarkup(
      createElement(PackageDetail, {
        pkg: pkg as never,
        canManage: true,
        canTrust: false,
      }),
    );

    expect(html).toContain("aif-dev");
    expect(html).toContain("s1");
    expect(html).toMatch(/rework|fork/i);
  });

  it("hides Trust for non-admins", () => {
    const html = renderToStaticMarkup(
      createElement(PackageDetail, {
        pkg: pkg as never,
        canManage: true,
        canTrust: false,
      }),
    );

    expect(html).not.toMatch(/\bTrust\b/);
  });
});
