import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { LeftRail } from "@/components/chrome/left-rail";

vi.mock("@/components/chrome/scratch-launch-popover", () => ({
  ScratchLaunchPopover: () => null,
}));

vi.mock("next-intl/server", () => ({
  getLocale: async () => "en",
  getTranslations: async (namespace: string) => {
    const copy: Record<string, string> = {
      "nav.collapseRail": "Collapse sidebar",
      "nav.expandRail": "Expand sidebar",
      "nav.projects": "Projects",
      "nav.inbox": "Inbox",
      "nav.studio": "Studio",
      "portfolio.activeWorkspaces": "Active workspaces",
      "portfolio.launchHint": "Launch hint",
      "portfolio.launchRun": "Launch run",
      "portfolio.launchUnavailableHint": "Launch unavailable",
      "portfolio.noneActive": "none active",
      "portfolio.runnersNone": "No runners",
      "portfolio.runnersReadiness": "Runners readiness",
      "portfolio.seeAll": "See all",
    };

    return (key: string) => copy[`${namespace}.${key}`] ?? key;
  },
}));

describe("LeftRail", () => {
  it("links Active workspaces See all to the runs ledger", async () => {
    const element = await LeftRail({
      platformStatus: {
        kind: "unavailable",
        message: "offline",
        reason: "network",
      },
      workspaceGroups: [],
    });
    const html = renderToStaticMarkup(element);

    expect(html).toContain('href="/runs"');
    expect(html).toContain("See all");
  });
});
