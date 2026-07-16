import { test, expect } from "@playwright/test";

import { loadFixtures } from "./_seed/fixtures";

// ADR-141 — branch-sync composition proof against the seeded harness.
// The fixture's run branch is ahead 1 / behind 1 of `main`, so the behind chip
// paints, the MECHANICAL rebase has real work, and the post-sync promote still
// merges a real commit. No supervisor is involved: the rebase is clean, so the
// agent path is never entered (agent-path matrices live in integration).

// The run-detail route is one of the heaviest in the app; under `next dev` its
// COLD compile alone can outrun the 30s default when specs race it in parallel.
test.describe.configure({ timeout: 90_000 });

test.describe("branch sync (ADR-141)", () => {
  test("a Review run behind its target syncs mechanically, the chip clears, and promote succeeds", async ({
    page,
  }) => {
    const fx = loadFixtures().byKey.runSync;

    await page.goto(`/runs/${fx.runId}`);

    // (1) The behind/ahead chip paints the real drift (behind 1, ahead 1).
    const chip = page.getByTestId("review-ahead-behind");

    await expect(chip).toBeVisible();
    await expect(chip).toContainText("1 behind");

    // (2) Sync entry point → dialog seeded from the project default (rebase).
    await page.getByTestId("review-sync-open").first().click();
    await expect(page.getByTestId("review-sync-dialog")).toBeVisible();
    await expect(page.getByTestId("review-sync-strategy")).toHaveValue(
      "rebase",
    );

    // (3) Start the sync — a clean rebase resolves mechanically (no agent).
    await page.getByTestId("review-sync-start").click();

    // (4) The DRIFT clears: the run branch is rebased on top of the target, so
    // it is 0 behind. It stays 1 ahead — that is its own commit, which is the
    // whole point of promoting it — so the chip remains, now reading "0 behind".
    await expect(chip).toContainText("0 behind", { timeout: 30_000 });
    await expect(page.getByTestId("review-sync-dialog")).toBeHidden();

    // (5) The promote action is live again (no sync claim held) and succeeds —
    // the run leaves Review for a terminal Done.
    //
    // #C9: `review-promote` is rendered by a ternary against `drift`, and a
    // target-drift REFUSAL sets drift=true — so the button unmounts whether the
    // promote succeeded or was rejected, and `toBeHidden()` passed either way.
    // That made this the headline sync e2e while proving nothing about the
    // promote. Await the POST and assert its status, as the sibling reopen spec
    // does.
    const promoted = page.waitForResponse((r) =>
      r.url().includes(`/api/runs/${fx.runId}/promote`),
    );

    await page.getByTestId("review-promote").click();
    expect((await promoted).status()).toBe(200);
    await expect(page.getByTestId("review-promote")).toBeHidden({
      timeout: 30_000,
    });
  });
});
