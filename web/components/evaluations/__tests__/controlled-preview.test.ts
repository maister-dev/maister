import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
}));

import {
  MaterializationPreview,
  PreflightVerdict,
  type MaterializationPreviewView,
} from "@/components/evaluations/controlled-preview";

function preview(
  overrides: Partial<MaterializationPreviewView> = {},
): MaterializationPreviewView {
  return {
    slots: [
      {
        slotLabel: "Main session",
        capabilityAgent: "claude",
        model: "claude-sonnet-4-6",
        softMismatch: false,
      },
    ],
    overlay: { rulesAdded: 0, skillsAdded: 0, mcpsAdded: 0, subagentsAdded: 0 },
    policyPreset: "supervised",
    promotionHeld: true,
    evidenceMethodQualifiedId: "core:sdd-quality",
    evidenceCoverage: ["diff"],
    estimatedJudgeAttempts: 3,
    ...overrides,
  };
}

describe("PreflightVerdict", () => {
  it("renders a green all-clear when ok with no warnings", () => {
    const markup = renderToStaticMarkup(
      createElement(PreflightVerdict, {
        verdict: { ok: true, refusalCodes: [], warningCodes: [] },
      }),
    );

    expect(markup).toContain("preflight.ok");
    expect(markup).not.toContain("preflight.refusal");
  });

  it("renders localized refusal copy (not raw codes/messages) when blocked", () => {
    const markup = renderToStaticMarkup(
      createElement(PreflightVerdict, {
        verdict: {
          ok: false,
          refusalCodes: ["flow_untrusted", "slot_unbound"],
          warningCodes: [],
        },
      }),
    );

    expect(markup).toContain("preflight.refusal.flow_untrusted");
    expect(markup).toContain("preflight.refusal.slot_unbound");
  });

  it("renders advisory warnings alongside an ok verdict", () => {
    const markup = renderToStaticMarkup(
      createElement(PreflightVerdict, {
        verdict: {
          ok: true,
          refusalCodes: [],
          warningCodes: ["slot_intent_soft_mismatch"],
        },
      }),
    );

    expect(markup).toContain("preflight.okWithWarnings");
    expect(markup).toContain("preflight.warning.slot_intent_soft_mismatch");
  });
});

describe("MaterializationPreview", () => {
  it("shows effective per-slot model + capability with no raw runner ids", () => {
    const markup = renderToStaticMarkup(
      createElement(MaterializationPreview, { preview: preview() }),
    );

    expect(markup).toContain("claude-sonnet-4-6");
    expect(markup).toContain("claude");
    expect(markup).toContain("core:sdd-quality");
    // The promotion hold is always shown as held.
    expect(markup).toContain("preview.promotionHeld");
    expect(markup).toContain("preview.estimatedAttempts");
  });

  it("badges a soft-mismatched slot", () => {
    const markup = renderToStaticMarkup(
      createElement(MaterializationPreview, {
        preview: preview({
          slots: [
            {
              slotLabel: "Main session",
              capabilityAgent: "claude",
              model: "claude-opus-4-8",
              softMismatch: true,
            },
          ],
        }),
      }),
    );

    expect(markup).toContain("preview.softMismatchBadge");
  });

  it("summarizes capability overlay changes", () => {
    const markup = renderToStaticMarkup(
      createElement(MaterializationPreview, {
        preview: preview({
          overlay: {
            rulesAdded: 1,
            skillsAdded: 2,
            mcpsAdded: 0,
            subagentsAdded: 0,
          },
        }),
      }),
    );

    // The mock echoes the interpolation values, so the summed count (3) appears.
    expect(markup).toContain("preview.overlayCount");
    expect(markup).toMatch(/count&quot;:3|count":3/);
  });
});
