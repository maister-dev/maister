import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({
  useTranslations: (ns: string) => (key: string) => `${ns}.${key}`,
}));

import { ProjectBrainSettingsControl } from "@/components/board/panels/project-brain-settings-control";

function render(brainEnabled: boolean, platformConfigured: boolean): string {
  return renderToStaticMarkup(
    createElement(ProjectBrainSettingsControl, {
      projectSlug: "demo",
      brainEnabled,
      flows: [{ id: "flow-1", ref: "maister.project-brain-projection" }],
      homeResolution: { decision: "indexed" },
      projectionFlowId: "flow-1",
      autonomyDefaults: { "rule.low": "auto_draft" },
      platformConfigured,
    }),
  );
}

// The HeroUI Select renders the SELECTED option's label into its trigger.
function selectedLabel(html: string): string {
  const match = html.match(/data-slot="select-value"[^>]*>([^<]*)</);

  return match?.[1] ?? "";
}

describe("ProjectBrainSettingsControl", () => {
  it("renders the enabled state as a HeroUI Select (no boolean checkbox)", () => {
    const html = render(true, true);

    expect(html).toContain("settings.brainProjectTitle");
    expect(html).toContain("settings.brainEnabledLabel");
    expect(html).toContain("settings.brainAutonomyRuleLow");
    expect(html).toContain("settings.brainAutonomySkillLow");
    expect(html).toContain("settings.brainAutonomyFlowLow");
    expect(html).toContain("settings.brainHomeDecision");
    expect(html).toContain("settings.brainHomeDirection");
    expect(html).toContain("settings.brainHomeOwned");
    expect(html).toContain("settings.brainHomeIndexed");
    expect(html).toContain("settings.brainProjectionFlow");
    expect(html).toContain("maister.project-brain-projection");
    expect(html).toContain("settings.brainAutonomyAutoDraft");
    expect(html).toContain("settings.brainAutonomyManual");
    expect(html).toContain('data-slot="select"');
    expect(html).not.toContain('type="checkbox"');
    expect(html).not.toContain("auto_publish");
    expect(selectedLabel(html)).toBe("settings.brainEnabledOn");
  });

  it("shows the disabled state in the trigger, and no success glyph before a save", () => {
    const html = render(false, true);

    expect(selectedLabel(html)).toBe("settings.brainEnabledOff");
    expect(html).not.toContain("settings.brainProjectSaved");
  });

  it("hints that the platform must be configured when it is not (enable-gate)", () => {
    expect(render(false, false)).toContain("settings.brainNotConfigured");
  });

  it("omits the not-configured hint once the platform is configured", () => {
    expect(render(false, true)).not.toContain("settings.brainNotConfigured");
  });
});
