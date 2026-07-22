import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
}));

import {
  StandardizationCurrentBadge,
  StandardizationEligibility,
  standardizationRefusalLabel,
} from "@/components/evaluations/standardization-panel";

describe("standardizationRefusalLabel", () => {
  const t = (k: string): string => k;
  const tc = (k: string): string => k;

  it("localizes a standardization-only refusal code", () => {
    expect(standardizationRefusalLabel(t, tc, "no_conclusive_winner")).toBe(
      "standardization.refusal.no_conclusive_winner",
    );
  });

  it("routes a preflight-prefixed refusal to the shared controlled-launch copy", () => {
    expect(standardizationRefusalLabel(t, tc, "preflight:flow_untrusted")).toBe(
      "preflight.refusal.flow_untrusted",
    );
  });
});

describe("StandardizationCurrentBadge", () => {
  it("shows a not-standardized note when there is no current revision", () => {
    const markup = renderToStaticMarkup(
      createElement(StandardizationCurrentBadge, { current: null }),
    );

    expect(markup).toContain("standardization.none");
  });

  it("shows the standardized revision for a standardize row", () => {
    const markup = renderToStaticMarkup(
      createElement(StandardizationCurrentBadge, {
        current: {
          revision: 3,
          action: "standardize",
          rolledBackToRevision: null,
        },
      }),
    );

    expect(markup).toContain("standardization.standardizedAt");
    expect(markup).toMatch(/revision&quot;:3|revision":3/);
  });

  it("shows the rollback target for a rollback row", () => {
    const markup = renderToStaticMarkup(
      createElement(StandardizationCurrentBadge, {
        current: { revision: 4, action: "rollback", rolledBackToRevision: 2 },
      }),
    );

    expect(markup).toContain("standardization.rolledBack");
    expect(markup).toMatch(/to&quot;:2|to":2/);
  });
});

describe("StandardizationEligibility", () => {
  it("renders the eligible all-clear", () => {
    const markup = renderToStaticMarkup(
      createElement(StandardizationEligibility, {
        eligibility: { eligible: true, refusals: [] },
      }),
    );

    expect(markup).toContain("standardization.eligible");
  });

  it("renders localized refusal copy for a mixed refusal list", () => {
    const markup = renderToStaticMarkup(
      createElement(StandardizationEligibility, {
        eligibility: {
          eligible: false,
          refusals: ["no_conclusive_winner", "preflight:flow_untrusted"],
        },
      }),
    );

    expect(markup).toContain("standardization.ineligible");
    expect(markup).toContain("standardization.refusal.no_conclusive_winner");
    expect(markup).toContain("preflight.refusal.flow_untrusted");
  });
});
