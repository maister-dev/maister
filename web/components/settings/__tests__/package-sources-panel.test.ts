import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
  usePathname: () => "/settings",
}));

import {
  PackageSourcesPanel,
  type PackageInstallRow,
  type PackageSourceRow,
} from "@/components/settings/package-sources-panel";

const source: PackageSourceRow = {
  id: "src-1",
  url: "github.com/org/maister-plugins",
  enabled: true,
  note: "main plugins repo",
  discovered: [
    { name: "aif", dir: "aif", tags: ["aif/v2.0.0", "aif/v1.0.0"] },
    { name: "core", dir: "core", tags: [] },
  ],
  lastCheckedAt: "2026-06-12T10:00:00.000Z",
  builtIn: true,
};

const install: PackageInstallRow = {
  id: "inst-1",
  sourceUrl: "github.com/org/maister-plugins",
  name: "aif",
  versionLabel: "aif/v2.0.0",
  resolvedRevision: "a".repeat(40),
  packageStatus: "Installed",
  trustStatus: "trusted_by_policy",
  flows: ["aif-dev", "aif-bugfix"],
};

describe("PackageSourcesPanel", () => {
  it("renders sources, the discovered catalog, and installed revisions", () => {
    const markup = renderToStaticMarkup(
      createElement(PackageSourcesPanel, {
        sources: [source],
        installs: [install],
      }),
    );

    expect(markup).toContain("pkgSourcesTitle");
    expect(markup).toContain("github.com/org/maister-plugins");
    expect(markup).toContain("pkgSourceBuiltIn");
    expect(markup).toContain("pkgRefresh");
    expect(markup).toContain("pkgCatalogTitle");
    // Installed tag renders as installed (disabled), not an install action.
    expect(markup).toContain("aif/v2.0.0 · pkgInstalled");
    expect(markup).toContain("aif/v1.0.0 · pkgInstall");
    expect(markup).toContain("pkgNoTags");
    expect(markup).toContain("pkgInstallsTitle");
    // Revision shown as 12-char prefix; installed_path never reaches the DTO.
    expect(markup).toContain("a".repeat(12));
    expect(markup).not.toContain("installedPath");
    expect(markup).toContain("aif-dev, aif-bugfix");
  });

  it("renders empty states without tables", () => {
    const markup = renderToStaticMarkup(
      createElement(PackageSourcesPanel, { sources: [], installs: [] }),
    );

    expect(markup).toContain("pkgSourcesEmpty");
    expect(markup).toContain("pkgInstallsEmpty");
    expect(markup).not.toContain("pkgCatalogTitle");
  });

  it("shows the Built-in badge only for builtIn sources", () => {
    const external: PackageSourceRow = {
      ...source,
      id: "src-external",
      url: "github.com/acme/other-plugins",
      builtIn: false,
    };
    const markup = renderToStaticMarkup(
      createElement(PackageSourcesPanel, {
        sources: [source, external],
        installs: [],
      }),
    );

    // The hint token is unique (the label "pkgSourceBuiltIn" is also a prefix
    // of it), so count the hint to assert exactly one badge rendered.
    expect(markup.match(/pkgSourceBuiltInHint/g) ?? []).toHaveLength(1);
  });
});
