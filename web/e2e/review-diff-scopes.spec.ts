// M30 (ADR-082): review-diff scope switcher + dirty-state banner, end-to-end
// on the review-comments fixture (real worktree, parked review HITL).
//
// Asserted, supervisor-independent outcomes:
//   1. the gate diff renders the 4-scope toggle; `uncommitted` is enabled and
//      switching to it loads the working-tree diff (the spec's own dirty
//      file appears as an addition);
//   2. scopes whose base does not exist degrade DISABLED, not erroring:
//      `since-last-review` (prior visit has no review_tip_sha — pre-M30 row)
//      and `last-node` (no attempt carries a checkpoint ref);
//   3. the dirty banner lists the uncommitted file and "Proceed as-is"
//      records the choice (POST 200) → the persistent badge replaces the
//      actions and survives a reload.
//
// The spec uses only the NON-destructive choice (`proceed`) and a uniquely
// named dirty file, so the shared fixture stays usable for the sibling
// review-comments spec under fullyParallel.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { test, expect } from "@playwright/test";

type Fixtures = {
  byKey: {
    reviewComments: {
      runId: string;
      hitlRequestId: string;
      projectSlug: string;
      worktreePath: string;
    };
  };
};

function loadFixtures(): Fixtures {
  return JSON.parse(
    readFileSync(path.resolve("e2e/.auth/fixtures.json"), "utf8"),
  ) as Fixtures;
}

// Mutating spec (dirty file + recorded resolution) — keep the steps ordered.
test.describe.configure({ mode: "serial" });

test("scope toggle: uncommitted loads the working-tree diff; sha-less scopes degrade disabled", async ({
  page,
}) => {
  const fx = loadFixtures().byKey.reviewComments;

  writeFileSync(
    path.join(fx.worktreePath, "dirty-e2e.txt"),
    "uncommitted reviewer-visible change\n",
  );

  await page.goto(`/runs/${fx.runId}`);

  const switcher = page.locator('[data-testid="diff-scope-switcher"]');

  await expect(switcher).toBeVisible();

  // Degrade, not error: the two scopes whose base is absent are disabled.
  await expect(
    page.locator('[data-testid="diff-scope-since-last-review"]'),
  ).toBeDisabled();
  await expect(
    page.locator('[data-testid="diff-scope-last-node"]'),
  ).toBeDisabled();

  const uncommitted = page.locator('[data-testid="diff-scope-uncommitted"]');

  await expect(uncommitted).toBeEnabled();

  const diffResponse = page.waitForResponse(
    (r) => r.url().includes("/diff?scope=uncommitted") && r.status() === 200,
  );

  await uncommitted.click();
  await diffResponse;

  await expect(
    page
      .locator('[data-testid="hitl-gate-diff"]')
      .getByText("dirty-e2e.txt")
      .first(),
  ).toBeVisible();
});

test("dirty banner: lists the file, Proceed as-is records and the badge persists", async ({
  page,
}) => {
  const fx = loadFixtures().byKey.reviewComments;

  await page.goto(`/runs/${fx.runId}`);

  const banner = page.locator('[data-testid="dirty-banner"]');

  await expect(banner).toBeVisible();
  await expect(banner.getByText("dirty-e2e.txt")).toBeVisible();

  const resolutionResponse = page.waitForResponse(
    (r) =>
      r.url().includes(`/hitl/${fx.hitlRequestId}/dirty-resolution`) &&
      r.request().method() === "POST",
  );

  await page.locator('[data-testid="dirty-proceed"]').click();

  const res = await resolutionResponse;

  expect(res.status()).toBe(200);

  const badge = page.locator('[data-testid="dirty-proceed-badge"]');

  await expect(badge).toBeVisible();
  await expect(banner).toHaveCount(0);

  // Recorded on the hitl row — survives a full reload.
  await page.reload();
  await expect(
    page.locator('[data-testid="dirty-proceed-badge"]'),
  ).toBeVisible();
});
