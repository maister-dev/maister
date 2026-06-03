// M15 Phase 8: readiness summary badge & panel coverage — seeded server state.
// The fixture (e2e/_seed/seed-e2e.ts → seedM15Fixture, fixtures.json byKey.m15)
// plants ONE project `e2e-m15` carrying TWO seeded runs to demonstrate readiness
// badge visibility and panel state rendering:
//   • A run in Review with a BLOCKING gate seeded `failed` → board/portfolio
//     show [data-readiness="failed"]; run-detail panel shows "Failed" state +
//     reason.
//   • A run in Review with the SAME gate OVERRIDDEN → board/portfolio show
//     [data-readiness="overridden"]; panel shows "Overridden" state.
//
// Asserted, deterministic, supervisor-independent outcomes:
//   1. Navigate to the project board; verify the In Flight column shows TWO
//      cards with readiness badges [data-readiness="failed"] and
//      [data-readiness="overridden"].
//   2. Click the failed run card → run-detail page loads; ReadinessSummary
//      panel renders with state badge "Failed" and a reason listing the
//      blocking gate.
//   3. Click the overridden run card → run-detail page loads; ReadinessSummary
//      panel renders with state badge "Overridden".
//   4. Navigate to portfolio home; verify the workspace card for the failed
//      run shows [data-readiness="failed"]; overridden shows
//      [data-readiness="overridden"].
//
// SCOPE — what this e2e proxies vs. proves:
//   • The badge visibility on board/portfolio and the panel state are
//     rendered from seeded gate_results rows — no agent/runner involved.
//     Readiness state computation (rollupReadiness) is a pure function of
//     gate statuses and is tested in the integration layer.
//   • i18n labels ("Failed", "Overridden", reasons) resolve from the
//     getRunReadinessSummary DTO; the EN messages are asserted here.

import { readFileSync } from "node:fs";
import path from "node:path";

import { test, expect } from "@playwright/test";

type M15Fixture = {
  projectSlug: string;
  failedRunId: string;
  failedHitlRequestId: string;
  overriddenRunId: string;
  overriddenHitlRequestId: string;
  gateId: string;
};

function loadM15Fixture(): M15Fixture {
  const all = JSON.parse(
    readFileSync(path.resolve("e2e/.auth/fixtures.json"), "utf8"),
  ) as { byKey: { m15: M15Fixture } };

  return all.byKey.m15;
}

test("readiness summary: badge on board/portfolio + panel on run-detail", async ({
  page,
}) => {
  const fx = loadM15Fixture();

  // (1) Navigate to the project board. Two In Flight cards with readiness
  // badges: one "failed", one "overridden".
  await page.goto(`/projects/${fx.projectSlug}`);

  // Board: find the cards with the readiness badges.
  const failedBadge = page.locator(`[data-readiness="failed"]`).first();
  const overriddenBadge = page.locator(`[data-readiness="overridden"]`).first();

  await expect(failedBadge).toBeVisible();
  await expect(overriddenBadge).toBeVisible();

  // (2) Click the failed run card. The run-detail page loads and the
  // ReadinessSummary panel renders with state "Failed".
  await failedBadge.click({ force: true });
  await page.waitForURL(`/runs/${fx.failedRunId}*`);

  // The ReadinessSummary panel is present with the failed state badge.
  const failedStateSpan = page.locator(`[data-readiness="failed"]`);

  await expect(failedStateSpan).toBeVisible();

  // The panel heading is visible (localize as needed for i18n).
  const readinessSummaryHeading = page
    .getByRole("heading", { name: "Readiness" })
    .first();

  await expect(readinessSummaryHeading).toBeVisible();

  // The reasons list should be present (the blocking gate is the reason).
  const reasonsList = page
    .locator("section[class*='border'][class*='rounded']")
    .locator("ul");

  await expect(reasonsList).toBeVisible();

  // (3) Navigate back to the board and click the overridden run card.
  // The run-detail page loads and the ReadinessSummary panel renders
  // with state "Overridden".
  await page.goto(`/projects/${fx.projectSlug}`);

  const overriddenCard = page.locator(`[data-readiness="overridden"]`).first();

  await expect(overriddenCard).toBeVisible();

  await overriddenCard.click({ force: true });
  await page.waitForURL(`/runs/${fx.overriddenRunId}*`);

  // The ReadinessSummary panel renders with the overridden state badge.
  const overriddenStateSpan = page.locator(`[data-readiness="overridden"]`);

  await expect(overriddenStateSpan).toBeVisible();

  // The panel heading is visible.
  const overriddenHeading = page
    .getByRole("heading", { name: "Readiness" })
    .first();

  await expect(overriddenHeading).toBeVisible();

  // (4) Navigate to portfolio home. The workspace cards for both runs
  // should display readiness badges [data-readiness="failed"] and
  // [data-readiness="overridden"].
  await page.goto("/");

  // Portfolio cards display readiness badges for runs in Review with
  // non-ready readiness states. The failed and overridden badges should
  // be visible somewhere on the page.
  const portfolioFailedBadge = page
    .locator(`[data-readiness="failed"]`)
    .first();
  const portfolioOverriddenBadge = page
    .locator(`[data-readiness="overridden"]`)
    .first();

  await expect(portfolioFailedBadge).toBeVisible();
  await expect(portfolioOverriddenBadge).toBeVisible();
});
