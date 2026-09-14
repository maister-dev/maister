// `UT-NAV-03` (ADR-172 D2) — the portfolio RELOCATED; it was not rewritten.
//
// `E2E-NAV-03` proves the seeded surface still renders at `/projects`, but it
// cannot reach the empty state: the shared e2e database always has projects.
// So the parts a browser run can never see — the empty-state card, the
// onboarding checklist, the admin-only new-project affordance — are asserted
// from the source here. D2's words are "anything that renders differently
// afterwards is a bug in the move"; these are the pieces most likely to be
// dropped silently by a move.

import { readFileSync, statSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const WEB_ROOT = path.resolve(__dirname, "../../../..");
const PORTFOLIO = path.join(WEB_ROOT, "app/(app)/projects/page.tsx");

function portfolioSource(): string {
  return readFileSync(PORTFOLIO, "utf8");
}

describe("UT-NAV-03 the portfolio lives at /projects", () => {
  it("occupies the segment that used to 404", () => {
    expect(statSync(PORTFOLIO).isFile()).toBe(true);
  });

  it("still mounts every portfolio region, empty state included", () => {
    const source = portfolioSource();

    // The JSX OPEN TAG, not the bare identifier: `toContain("ProjectCard")`
    // also passes on `ProjectCardSummary`, so a renamed-away component would
    // slip through the substring.
    for (const component of [
      "EmptyState",
      "OnboardingChecklist",
      "ProjectCard",
      "NewProjectTile",
      "DecisionsSummary",
      "ConfigPersistBanner",
      "DensityToggle",
      "LiveTicker",
    ]) {
      expect(source, component).toMatch(
        new RegExp(`<${component}[\\s/>]`, "u"),
      );
    }
  });

  it("reads its counter from the one canonical read model", () => {
    expect(portfolioSource()).toContain('from "@/lib/queries/decisions"');
  });

  it("keeps the empty branch gated on the project list being empty", () => {
    const source = portfolioSource();

    expect(source).toContain("portfolio.projects.length === 0");
    expect(source).toMatch(/isEmpty \?\s*\(?\s*<EmptyState/u);
  });
});
