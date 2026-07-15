import { test, expect } from "@playwright/test";

import { loadFixtures } from "./_seed/fixtures";

// ADR-140 (Task 18) — PR reopen composition proof against the seeded harness.
// The fixture is a Done run whose PR is open + unmergeable (exactly what
// pr_state_scan records). The board surfaces the conflicts chip; reopening
// returns the run to Review, where the sync dialog is reachable to resolve it.
// No live gh/glab: the PR state is seeded, never fetched.

// The run-detail route is one of the heaviest in the app; under `next dev` its
// COLD compile alone can outrun the 30s default when specs race it in parallel.
test.describe.configure({ timeout: 90_000 });

test.describe("PR reopen (ADR-140)", () => {
  test("a conflicted-PR Done run reopens from the board and lands back on review with sync reachable", async ({
    page,
  }) => {
    const fx = loadFixtures().byKey.prReopen;

    await page.goto(`/projects/${fx.projectSlug}`);

    // (1) The conflicts chip paints (conflicts take precedence over pr_state).
    const chip = page.getByTestId("pr-state-chip").first();

    await expect(chip).toBeVisible();
    await expect(chip).toHaveAttribute("data-pr-conflicts", "true");

    // (2) The reopen affordance is LIVE on the card (run-scoped chip).
    const reopen = page.getByTestId("pr-reopen").first();

    await expect(reopen).toBeEnabled();

    // Await the POST itself: navigating while it is still in flight would abort
    // it, and the assertion below would race the reopen rather than prove it.
    const posted = page.waitForResponse((r) =>
      r.url().includes(`/api/runs/${fx.runId}/reopen`),
    );

    await reopen.click();
    expect((await posted).status()).toBe(200);

    // (3) The run returns to Review — the board card leaves Done for OnReview.
    //     Assert on the run surface, which is the durable proof of the flip.
    await page.goto(`/runs/${fx.runId}`);
    // Generous: this may be the run-detail route's COLD dev compile.
    await expect(page.getByTestId("review-panel")).toBeVisible({
      timeout: 60_000,
    });

    // (4) The sync dialog is reachable so the reviewer can resolve the conflict
    //     that made the PR unmergeable in the first place.
    await page.getByTestId("review-sync-open").first().click();
    await expect(page.getByTestId("review-sync-dialog")).toBeVisible();
  });
});
