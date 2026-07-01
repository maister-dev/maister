import type { TaskQueueSettings } from "@/lib/tasks/queue-settings";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({
  useTranslations: (ns: string) => (key: string) => `${ns}.${key}`,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

import { QueueSettingsControl } from "@/components/board/panels/queue-settings-control";

function render(
  taskQueueSettings: TaskQueueSettings | null,
  envEdgeDrainDefault = true,
): string {
  return renderToStaticMarkup(
    createElement(QueueSettingsControl, {
      projectSlug: "demo",
      taskQueueSettings,
      envEdgeDrainDefault,
    }),
  );
}

// The HeroUI Select renders the SELECTED option's label into its trigger
// (`data-slot="select-value"`), so we assert on which label the trigger shows.
function selectedLabel(html: string): string {
  const match = html.match(/data-slot="select-value"[^>]*>([^<]*)</);

  return match?.[1] ?? "";
}

describe("QueueSettingsControl", () => {
  it("uses HeroUI primitives (tri-state Select + Input), not a boolean checkbox", () => {
    const html = render({ edgeDrain: true, maxInFlightAuto: 4 });

    expect(html).toContain("settings.queueSettingsTitle");
    expect(html).toContain("settings.queueEdgeDrain");
    expect(html).toContain('data-slot="select"'); // HeroUI Select, not a raw <select>
    expect(html).not.toContain('type="checkbox"'); // tri-state, not boolean (Codex-3)
    // The max-in-flight override renders into the HeroUI Input.
    expect(html).toContain('value="4"');
    expect(html).toContain("settings.queueMaxInFlightAuto");
  });

  it("shows the stored ON override in the select trigger", () => {
    expect(selectedLabel(render({ edgeDrain: true }))).toBe(
      "settings.queueEdgeDrainOn",
    );
  });

  it("shows the stored OFF override in the select trigger", () => {
    expect(selectedLabel(render({ edgeDrain: false }))).toBe(
      "settings.queueEdgeDrainOff",
    );
  });

  it("defaults to INHERIT (not a hard-coded on) when no override is stored (Codex-3 regression)", () => {
    // No project override → inherit the env default, never write {edgeDrain:true}.
    expect(selectedLabel(render(null))).toBe("settings.queueEdgeDrainInherit");
  });

  it("does not show the saved-success glyph on first render (no save yet)", () => {
    const html = render({ edgeDrain: true });

    expect(html).not.toContain("settings.queueSaved");
  });
});
