import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
  usePathname: () => "/projects/demo",
}));

import { ProjectPackagesSection } from "@/components/board/panels/project-packages-section";

const attachment = {
  id: "att-1",
  packageInstallId: "inst-1",
  packageName: "aif",
  versionLabel: "aif/v1.0.0",
  resolvedRevision: "a".repeat(40),
  trustStatus: "untrusted",
  attachedAt: "2026-06-12T10:00:00.000Z",
  updateAvailable: true,
  upgradeTarget: { installId: "inst-2", versionLabel: "aif/v2.0.0" },
  downgradeTargets: [] as { installId: string; versionLabel: string }[],
  flows: ["aif-dev", "aif-bugfix"],
};

const installs = [
  {
    id: "inst-1",
    name: "aif",
    versionLabel: "aif/v1.0.0",
    resolvedRevision: "a".repeat(40),
    trustStatus: "untrusted",
    flows: ["aif-dev", "aif-bugfix"],
  },
  {
    id: "inst-2",
    name: "aif",
    versionLabel: "aif/v2.0.0",
    resolvedRevision: "b".repeat(40),
    trustStatus: "untrusted",
    flows: ["aif-dev"],
  },
  {
    id: "inst-3",
    name: "core",
    versionLabel: "core/v0.1.0",
    resolvedRevision: "c".repeat(40),
    trustStatus: "trusted_by_policy",
    flows: ["triager"],
  },
];

describe("ProjectPackagesSection", () => {
  it("renders attachments with badge, viewer link, and admin actions", () => {
    const markup = renderToStaticMarkup(
      createElement(ProjectPackagesSection, {
        slug: "demo",
        isAdmin: true,
        canTrust: true,
        attachments: [attachment],
        availableInstalls: installs,
      }),
    );

    expect(markup).toContain("attachmentsTitle");
    expect(markup).toContain("updateAvailable");
    expect(markup).toContain("/studio/packages/aif");
    expect(markup).not.toContain("package-installs");
    // Upgrade target comes from the DTO (a newer install); trust shown for untrusted.
    expect(markup).toContain("aif/v2.0.0");
    expect(markup).toContain(">trust<");
    expect(markup).toContain("detach");
    // Attach picker offers only packages not yet attached (core, not aif).
    expect(markup).toContain("core@core/v0.1.0");
    expect(markup).not.toContain("aif@aif/v2.0.0</option>");
  });

  it("offers a downgrade path but never lists an older version as an upgrade", () => {
    const onNewest = {
      ...attachment,
      versionLabel: "aif/v2.1.0",
      updateAvailable: false,
      upgradeTarget: null,
      downgradeTargets: [{ installId: "inst-2", versionLabel: "aif/v2.0.0" }],
    };

    const markup = renderToStaticMarkup(
      createElement(ProjectPackagesSection, {
        slug: "demo",
        isAdmin: true,
        canTrust: true,
        attachments: [onNewest],
        availableInstalls: installs,
      }),
    );

    // On the newest installed version there is NO "Upgrade → …" affordance.
    expect(markup).not.toContain("upgrade");
    // The older version is reachable only through the explicit downgrade picker.
    expect(markup).toContain("downgradePick");
    expect(markup).toContain("aif/v2.0.0");
  });

  it("hides the trust button from project admins without the global role", () => {
    const markup = renderToStaticMarkup(
      createElement(ProjectPackagesSection, {
        slug: "demo",
        isAdmin: true,
        canTrust: false,
        attachments: [attachment],
        availableInstalls: installs,
      }),
    );

    // Trust is platform-scoped (global admin); project admins keep the rest.
    expect(markup).not.toContain(">trust<");
    expect(markup).toContain("detach");
  });

  it("hides admin controls for non-admin viewers and shows the empty state", () => {
    const markup = renderToStaticMarkup(
      createElement(ProjectPackagesSection, {
        slug: "demo",
        isAdmin: false,
        canTrust: false,
        attachments: [],
        availableInstalls: installs,
      }),
    );

    expect(markup).toContain("attachmentsEmpty");
    expect(markup).not.toContain("attach-package-select");
    expect(markup).not.toContain("detach");
  });
});
