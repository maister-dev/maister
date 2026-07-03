import type { AutoPromotionConfig } from "@/lib/auto-promotion/config";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// Key-echo i18n mock (repo convention): assertions key off resolved i18n keys +
// the component's data-* attributes, not translated text.
vi.mock("next-intl", () => ({
  useTranslations: (ns: string) => (key: string) => `${ns}.${key}`,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

import { HARD_DENY_GLOBS } from "@/lib/auto-promotion/classify";
import { AutoPromotionSettingsControl } from "@/components/board/panels/auto-promotion-settings-control";

function render(config: AutoPromotionConfig | null): string {
  return renderToStaticMarkup(
    createElement(AutoPromotionSettingsControl, {
      projectSlug: "demo",
      config,
    }),
  );
}

describe("AutoPromotionSettingsControl — defaults (never configured)", () => {
  it("renders the master Switch, the four built-in lanes, all enabled", () => {
    const html = render(null);

    // Master toggle present (HeroUI Switch → a labelled control).
    expect(html).toContain('data-testid="auto-promotion-master"');
    // All four lane classes render as rows, in canonical order.
    expect(html).toContain('data-lane="docs"');
    expect(html).toContain('data-lane="tests"');
    expect(html).toContain('data-lane="deps"');
    expect(html).toContain('data-lane="config"');
    // A never-configured project defaults every lane enabled (BUILT_IN_LANES).
    expect(html).toContain('data-enabled="true"');
    expect(html).not.toContain('data-enabled="false"');
    // The enabled cell shows the green-check glyph, not the word.
    expect(html).toContain("✓");
    // Default (omitted) mode shows the "project default" label.
    expect(html).toContain("settings.autoPromotion.mode.default");
  });

  it("renders the HARD_DENY_GLOBS read-only with a lock section", () => {
    const html = render(null);

    expect(html).toContain('data-testid="auto-promotion-deny-list"');
    expect(html).toContain("settings.autoPromotion.denyTitle");
    // Every non-configurable deny glob is listed verbatim.
    for (const glob of HARD_DENY_GLOBS) {
      expect(html).toContain(glob);
    }
    // The deny-list has NO edit affordance (it is not a knob).
    const denySection = html.slice(
      html.indexOf('data-testid="auto-promotion-deny-list"'),
    );

    expect(denySection).not.toContain('data-testid="auto-promotion-edit-');
  });

  it("does not show the saved-success glyph on first render", () => {
    const html = render(null);

    expect(html).not.toContain('role="status"');
  });

  it("offers a per-lane Edit button for every lane (view-table + popup convention)", () => {
    const html = render(null);

    expect(html).toContain('data-testid="auto-promotion-edit-docs"');
    expect(html).toContain('data-testid="auto-promotion-edit-tests"');
    expect(html).toContain('data-testid="auto-promotion-edit-deps"');
    expect(html).toContain('data-testid="auto-promotion-edit-config"');
    // The edit modal is NOT open on first render (no lane selected).
    expect(html).not.toContain('data-testid="auto-promotion-lane-modal"');
  });
});

describe("AutoPromotionSettingsControl — stored config", () => {
  const stored: AutoPromotionConfig = {
    enabled: true,
    lanes: [
      { class: "docs", enabled: true, delayMinutes: 5, mode: "pull_request" },
      {
        class: "tests",
        enabled: false,
        delayMinutes: 10,
        excludeGlobs: ["e2e/legacy/**"],
      },
      {
        class: "deps",
        enabled: true,
        delayMinutes: 30,
        requireExternalCheckId: "ci/build",
      },
      { class: "config", enabled: true, delayMinutes: 10 },
    ],
  };

  it("reflects per-lane mode, delay, CI gate, exclude globs, and disabled state", () => {
    const html = render(stored);

    // A disabled lane renders the em-dash, not the check.
    expect(html).toContain('data-enabled="false"');
    // Lane-specific mode label.
    expect(html).toContain("settings.autoPromotion.mode.pull_request");
    // The delay/gate/globs values render verbatim.
    expect(html).toContain("ci/build");
    expect(html).toContain("e2e/legacy/**");
  });

  it("fills a class the stored config omitted with the built-in default lane", () => {
    // A partial config (only docs) must still render all four lanes.
    const html = render({
      enabled: true,
      lanes: [{ class: "docs", enabled: false, delayMinutes: 0 }],
    });

    expect(html).toContain('data-lane="docs"');
    expect(html).toContain('data-lane="tests"');
    expect(html).toContain('data-lane="deps"');
    expect(html).toContain('data-lane="config"');
    // docs is the disabled one from the stored config; the rest are default-on.
    expect(html).toContain('data-enabled="false"');
    expect(html).toContain('data-enabled="true"');
  });
});
