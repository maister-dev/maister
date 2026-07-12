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
  upgradeTarget: {
    installId: "inst-2",
    versionLabel: "aif/v2.0.0",
    compatible: true,
    incompatibilityReason: null,
  },
  downgradeTargets: [] as {
    installId: string;
    versionLabel: string;
    compatible: boolean;
    incompatibilityReason: string | null;
  }[],
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
    compatible: true,
    incompatibilityReason: null,
    sourceLocalPackageId: null,
  },
  {
    id: "inst-2",
    name: "aif",
    versionLabel: "aif/v2.0.0",
    resolvedRevision: "b".repeat(40),
    trustStatus: "untrusted",
    flows: ["aif-dev"],
    compatible: true,
    incompatibilityReason: null,
    sourceLocalPackageId: null,
  },
  {
    id: "inst-3",
    name: "core",
    versionLabel: "core/v0.1.0",
    resolvedRevision: "c".repeat(40),
    trustStatus: "trusted_by_policy",
    flows: ["triager"],
    compatible: true,
    incompatibilityReason: null,
    sourceLocalPackageId: null,
  },
  // ADR-132 (T15): a Studio fork's cut — shares the upstream's name "aif".
  {
    id: "inst-cut",
    name: "aif",
    versionLabel: "local-abcdef123456",
    resolvedRevision: "d".repeat(40),
    trustStatus: "trusted_by_policy",
    flows: ["aif-dev"],
    compatible: true,
    incompatibilityReason: null,
    sourceLocalPackageId: "lp-9",
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

  // ADR-132 §c (T15): a local cut stays selectable even when its name
  // collides with an attached package (the explainer handles the collision);
  // an upstream sibling version of an attached name stays hidden (upgrade
  // path, not attach path).
  it("offers a name-colliding LOCAL CUT with a local-cut marker, but never an upstream sibling", () => {
    const markup = renderToStaticMarkup(
      createElement(ProjectPackagesSection, {
        slug: "demo",
        isAdmin: true,
        canTrust: true,
        attachments: [attachment],
        availableInstalls: installs,
      }),
    );

    expect(markup).toContain('value="inst-cut"');
    expect(markup).toContain("attachLocalCutBadge");
    expect(markup).not.toContain('value="inst-2"');
  });

  it("offers a downgrade path but never lists an older version as an upgrade", () => {
    const onNewest = {
      ...attachment,
      versionLabel: "aif/v2.1.0",
      updateAvailable: false,
      upgradeTarget: null,
      downgradeTargets: [
        {
          installId: "inst-2",
          versionLabel: "aif/v2.0.0",
          compatible: true,
          incompatibilityReason: null,
        },
      ],
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

  it("disables incompatible attach and upgrade targets with the refusal reason", () => {
    const reason = "Legacy steps manifests are not supported";
    const incompatibleInstalls = installs.map((install) =>
      install.id === "inst-3"
        ? { ...install, compatible: false, incompatibilityReason: reason }
        : install,
    );
    const incompatibleAttachment = {
      ...attachment,
      upgradeTarget: {
        ...attachment.upgradeTarget,
        compatible: false,
        incompatibilityReason: reason,
      },
    };

    const markup = renderToStaticMarkup(
      createElement(ProjectPackagesSection, {
        slug: "demo",
        isAdmin: true,
        canTrust: true,
        attachments: [incompatibleAttachment],
        availableInstalls: incompatibleInstalls,
      }),
    );

    expect(markup).toMatch(/<option[^>]*disabled=""[^>]*value="inst-3"/);
    expect(markup).toMatch(
      /<button[^>]*disabled=""[^>]*title="Legacy steps manifests are not supported"/,
    );
    expect(markup).toContain(
      "core@core/v0.1.0: Legacy steps manifests are not supported",
    );
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
