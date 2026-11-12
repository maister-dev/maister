// M30 (ADR-082): review-diff scope switcher + dirty-state banner, end-to-end
// on the review-comments fixture (real worktree, parked review HITL).
//
// Asserted, supervisor-independent outcomes:
//   1. the Review Workspace starts with the complete `review` source, so the
//      spec's unstaged file appears without switching to a forensic scope;
//      the secondary workbench switcher still exposes `uncommitted`;
//   2. scopes whose base does not exist degrade DISABLED, not erroring:
//      `since-last-review` (prior visit has no review_tip_sha — pre-M30 row)
//      and `last-node` (no attempt carries a checkpoint ref);
//   3. the dirty banner lists the uncommitted file and "Proceed as-is"
//      records the choice (POST 200) → the persistent badge replaces the
//      actions and survives a reload.
//
// This spec owns a separate review fixture: resolving a gate in another
// browser journey must not change the available diff scopes here.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { test, expect } from "@playwright/test";

type Fixtures = {
  byKey: {
    reviewDiffScopes: {
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

test("Review Workspace starts with complete current-review diff; secondary scopes degrade safely", async ({
  page,
}) => {
  const fx = loadFixtures().byKey.reviewDiffScopes;

  writeFileSync(
    path.join(fx.worktreePath, "dirty-e2e.txt"),
    "uncommitted reviewer-visible change\n",
  );

  await page.goto(`/runs/${fx.runId}?wb=review&scope=review`);

  const workspaceDiff = page
    .getByRole("region", { name: "Review workspace" })
    .getByTestId("run-diff");

  await expect(workspaceDiff).toBeVisible();
  await expect(workspaceDiff.getByText("dirty-e2e.txt").first()).toBeVisible();

  await expect(
    workspaceDiff.locator('[data-testid="diff-scope-switcher"]'),
  ).toHaveCount(0);
  await page.goto(`/runs/${fx.runId}?wb=diff&scope=review`);

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
  await expect(page).toHaveURL(/[?&]scope=uncommitted(?:&|$)/);

  await expect(
    page
      .locator('[data-testid="run-workbench"] [data-testid="run-diff"]')
      .getByText("dirty-e2e.txt")
      .first(),
  ).toBeVisible();
});

test("dirty banner: lists the file, Proceed as-is records and the badge persists", async ({
  page,
}) => {
  const fx = loadFixtures().byKey.reviewDiffScopes;

  await page.goto(`/runs/${fx.runId}`);

  const banner = page.getByTestId("dirty-banner").filter({ visible: true });

  await expect(banner).toBeVisible();
  await expect(banner.getByText("dirty-e2e.txt")).toBeVisible();

  const resolutionResponse = page.waitForResponse(
    (r) =>
      r.url().includes(`/hitl/${fx.hitlRequestId}/dirty-resolution`) &&
      r.request().method() === "POST",
  );

  await banner.getByRole("button", { name: "Proceed as-is" }).click();

  const res = await resolutionResponse;

  expect(res.status()).toBe(200);

  const badge = page.getByRole("main").getByTestId("dirty-proceed-badge");

  await expect(badge).toBeVisible();
  await expect(banner).toHaveCount(0);

  // Recorded on the hitl row — survives a full reload.
  await page.reload();
  await expect(
    page.getByRole("main").getByTestId("dirty-proceed-badge"),
  ).toBeVisible();
});
