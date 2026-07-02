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
    expect(html).toContain('data-slot="select"');
    expect(html).not.toContain('type="checkbox"');
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
