// T2.1 (spec §7.2 IA reachability): the installed-package cards on the project
// `packages` tab are no longer decoy <div> blocks — each card is a navigating
// <Link href="/projects/{slug}/packages/{ref}"> to the read-only package viewer.
// The admin action buttons (PackageActions) keep working: they live in a
// stop-propagation wrapper (data-testid="package-card-actions") so clicking an
// action does NOT also trigger card navigation.
//
// FlowPackagesPanel is an async Server Component calling getTranslations and
// mounting "use client" children (PackageActions / InstallPackageModal use
// next/navigation hooks). Rendered via `renderToStaticMarkup(await Panel(props))`
// with next-intl/server echoing keys and next/navigation stubbed.

import type { FlowPackageView } from "@/lib/queries/flow-packages";

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { FlowPackagesPanel } from "@/components/board/panels/flow-packages-panel";

vi.mock("next-intl/server", () => ({
  getTranslations: async () => (key: string) => key,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/projects/acme",
  useSearchParams: () => new URLSearchParams(),
}));

function makePackage(
  overrides: Partial<FlowPackageView> = {},
): FlowPackageView {
  return {
    flowRowId: "flow-row-1",
    ref: "bugfix",
    enablementState: "Enabled",
    trustStatus: "trusted",
    enabledRevision: {
      id: "rev-1",
      versionLabel: "v1.2.3",
      resolvedRevision: "abc1234567890def",
    },
    availableUpdate: null,
    compatWarning: null,
    hasSetupScript: false,
    enabledContract: { capabilities: ["plan"], artifacts: ["spec"] },
    installedRevisions: [
      {
        id: "rev-1",
        versionLabel: "v1.2.3",
        resolvedRevision: "abc1234567890def",
      },
    ],
    activeRunsOnOldRevision: 0,
    projectsUsing: 1,
    ...overrides,
  } as FlowPackageView;
}

async function render(args: { isAdmin: boolean }): Promise<string> {
  const el = await FlowPackagesPanel({
    packages: [makePackage()],
    slug: "acme",
    isAdmin: args.isAdmin,
  });

  return renderToStaticMarkup(el);
}

describe("FlowPackagesPanel — cards link to the package viewer", () => {
  it("renders each package card as a Link to /projects/{slug}/packages/{ref}", async () => {
    const html = await render({ isAdmin: false });

    expect(html).toContain('href="/projects/acme/packages/bugfix"');
    expect(html).toContain("<a");
  });
});

describe("FlowPackagesPanel — admin actions stay isolated from navigation", () => {
  it("keeps the admin action block (stop-propagation wrapper) when isAdmin", async () => {
    const html = await render({ isAdmin: true });

    expect(html).toContain('data-testid="package-card-actions"');
    // the card link is still present alongside the actions.
    expect(html).toContain('href="/projects/acme/packages/bugfix"');
  });

  it("omits the admin action block when not isAdmin", async () => {
    const html = await render({ isAdmin: false });

    expect(html).not.toContain('data-testid="package-card-actions"');
  });
});
