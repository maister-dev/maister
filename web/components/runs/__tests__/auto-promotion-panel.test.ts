import type { RunAutoPromotionPanel } from "@/lib/auto-promotion/panel";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// The i18n mock returns `${namespace}.${key}` (values ignored), so assertions key
// off the resolved i18n key strings + the component's data-* attributes.
vi.mock("next-intl", () => ({
  useTranslations: (namespace: string) => (key: string) =>
    `${namespace}.${key}`,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

import { AutoPromotionPanel } from "@/components/runs/auto-promotion-panel";

function render(panel: RunAutoPromotionPanel, canHold = true): string {
  return renderToStaticMarkup(
    createElement(AutoPromotionPanel, { canHold, panel, runId: "run-1" }),
  );
}

describe("AutoPromotionPanel — verdict branches", () => {
  it("eligible: renders the countdown chip + a Hold button (pause)", () => {
    const eligibleAt = new Date(Date.now() + 6 * 60_000).toISOString();
    const html = render({
      evaluation: {
        verdict: "eligible",
        lane: "docs",
        reviewEnteredAt: new Date().toISOString(),
        eligibleAt,
      },
      promotedLane: null,
    });

    expect(html).toContain('data-testid="auto-promotion-eligible"');
    // ~6 minutes out → the compact "6m" countdown token.
    expect(html).toContain('data-countdown="6m"');
    // The eligible chip uses the promotesIn label (interpolated by the real
    // provider; the mock returns the key).
    expect(html).toContain("autoPromotion.panel.promotesIn");
    // Hold affordance present with the pause label as accessible name.
    expect(html).toContain('data-testid="auto-promotion-hold"');
    expect(html).toContain('aria-label="autoPromotion.panel.hold"');
  });

  it("eligible + grace already elapsed: shows the ready label, not a stale countdown", () => {
    const eligibleAt = new Date(Date.now() - 1000).toISOString();
    const html = render({
      evaluation: {
        verdict: "eligible",
        lane: "tests",
        reviewEnteredAt: new Date().toISOString(),
        eligibleAt,
      },
      promotedLane: null,
    });

    expect(html).toContain('data-testid="auto-promotion-eligible"');
    // Past-due → the "ready" label (panel.eligible), not promotesIn.
    expect(html).toContain("autoPromotion.panel.eligible");
    expect(html).toContain('data-countdown="0s"');
  });

  it("held: renders the reason + a Release button (play)", () => {
    const html = render({
      evaluation: {
        verdict: "held",
        hold: {
          source: "user",
          reason: "waiting on QA",
          createdAt: new Date().toISOString(),
        },
      },
      promotedLane: null,
    });

    expect(html).toContain('data-testid="auto-promotion-held"');
    expect(html).toContain("autoPromotion.panel.held");
    // Reason rendered verbatim.
    expect(html).toContain("waiting on QA");
    // Release affordance present, Hold absent (already held).
    expect(html).toContain('data-testid="auto-promotion-release"');
    expect(html).toContain('aria-label="autoPromotion.panel.release"');
    expect(html).not.toContain('data-testid="auto-promotion-hold"');
  });

  it("ineligible: localized reason label + files rendered verbatim", () => {
    const html = render({
      evaluation: {
        verdict: "ineligible",
        reason: "deny_list",
        files: ["CLAUDE.md", ".github/workflows/ci.yml"],
      },
      promotedLane: null,
    });

    expect(html).toContain('data-testid="auto-promotion-ineligible"');
    expect(html).toContain('data-reason="deny_list"');
    // The reason label comes from the reason.* namespace.
    expect(html).toContain("autoPromotion.reason.deny_list");
    // Files listed verbatim (untranslated).
    expect(html).toContain("CLAUDE.md");
    expect(html).toContain(".github/workflows/ci.yml");
    // A non-held Review verdict still offers Hold.
    expect(html).toContain('data-testid="auto-promotion-hold"');
  });

  it("ineligible grace_pending: renders the countdown from eligibleAt", () => {
    const eligibleAt = new Date(Date.now() + 4 * 60_000).toISOString();
    const html = render({
      evaluation: {
        verdict: "ineligible",
        reason: "grace_pending",
        eligibleAt,
      },
      promotedLane: null,
    });

    expect(html).toContain('data-reason="grace_pending"');
    expect(html).toContain('data-countdown="4m"');
    expect(html).toContain("autoPromotion.panel.promotesIn");
  });

  it("ineligible: renders the detail string verbatim when present", () => {
    const html = render({
      evaluation: {
        verdict: "ineligible",
        reason: "deps_content",
        detail: "lockfile change without manifest evidence",
      },
      promotedLane: null,
    });

    expect(html).toContain("autoPromotion.reason.deps_content");
    expect(html).toContain("lockfile change without manifest evidence");
  });

  it("disabled (platform): renders the platform-off label, no buttons", () => {
    const html = render({
      evaluation: { verdict: "disabled", scope: "platform" },
      promotedLane: null,
    });

    expect(html).toContain('data-testid="auto-promotion-disabled"');
    expect(html).toContain("autoPromotion.panel.disabledPlatform");
    expect(html).not.toContain('data-testid="auto-promotion-hold"');
  });

  it("disabled (project): renders the project-off label", () => {
    const html = render({
      evaluation: { verdict: "disabled", scope: "project" },
      promotedLane: null,
    });

    expect(html).toContain("autoPromotion.panel.disabledProject");
  });

  it("not_applicable: renders the reason label, no buttons", () => {
    const html = render({
      evaluation: { verdict: "not_applicable", reason: "shared_workspace" },
      promotedLane: null,
    });

    expect(html).toContain('data-testid="auto-promotion-not-applicable"');
    expect(html).toContain("autoPromotion.notApplicable.shared_workspace");
    expect(html).not.toContain('data-testid="auto-promotion-hold"');
  });

  it("promoted (Done, no evaluation): renders the promoted-via note", () => {
    const html = render({ evaluation: null, promotedLane: "docs" });

    expect(html).toContain('data-testid="auto-promotion-promoted"');
    expect(html).toContain("autoPromotion.panel.promotedVia");
  });

  it("renders nothing when there is neither an evaluation nor a promoted lane", () => {
    const html = render({ evaluation: null, promotedLane: null });

    expect(html).toBe("");
  });

  it("hides Hold/Release when the viewer cannot promote (canHold=false)", () => {
    const eligibleAt = new Date(Date.now() + 6 * 60_000).toISOString();
    const html = render(
      {
        evaluation: {
          verdict: "eligible",
          lane: "docs",
          reviewEnteredAt: new Date().toISOString(),
          eligibleAt,
        },
        promotedLane: null,
      },
      false,
    );

    // The verdict is still visible; only the action is gated.
    expect(html).toContain('data-testid="auto-promotion-eligible"');
    expect(html).not.toContain('data-testid="auto-promotion-hold"');
  });
});
