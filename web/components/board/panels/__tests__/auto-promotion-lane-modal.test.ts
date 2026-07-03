import type { AutoPromotionLane } from "@/lib/auto-promotion/config";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({
  useTranslations: (ns: string) => (key: string) => `${ns}.${key}`,
}));

import { AutoPromotionLaneModal } from "@/components/board/panels/auto-promotion-lane-modal";

function render(lane: AutoPromotionLane): string {
  return renderToStaticMarkup(
    createElement(AutoPromotionLaneModal, {
      lane,
      onApply: vi.fn(),
      onClose: vi.fn(),
    }),
  );
}

describe("AutoPromotionLaneModal", () => {
  it("is a labelled dialog with the lane class in the title", () => {
    const html = render({ class: "deps", enabled: true, delayMinutes: 10 });

    expect(html).toContain('data-testid="auto-promotion-lane-modal"');
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('aria-labelledby="auto-promotion-lane-title"');
    expect(html).toContain("settings.autoPromotion.editLaneTitle");
  });

  it("pre-fills every field from the lane", () => {
    const html = render({
      class: "deps",
      enabled: true,
      delayMinutes: 30,
      mode: "pull_request",
      requireExternalCheckId: "ci/build",
      excludeGlobs: ["vendor/**", "third_party/**"],
    });

    // Delay input pre-filled.
    expect(html).toContain('value="30"');
    // CI check id pre-filled.
    expect(html).toContain('value="ci/build"');
    // The mode select carries the pull_request option (selected).
    expect(html).toContain("settings.autoPromotion.mode.pull_request");
    // Exclude globs joined newline-separated inside the textarea.
    expect(html).toContain("vendor/**");
    expect(html).toContain("third_party/**");
    // Apply affordance present.
    expect(html).toContain('data-testid="auto-promotion-lane-apply"');
  });

  it("renders the enabled checkbox reflecting the lane state", () => {
    const html = render({ class: "docs", enabled: false, delayMinutes: 10 });

    expect(html).toContain('type="checkbox"');
    // A disabled lane renders an unchecked box (no `checked` attribute).
    const checkboxTag = html.slice(
      html.indexOf('type="checkbox"') - 60,
      html.indexOf('type="checkbox"') + 20,
    );

    expect(checkboxTag).not.toContain("checked");
  });
});
