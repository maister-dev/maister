import { test, expect } from "@playwright/test";

import { loadFixtures } from "./_seed/fixtures";

// ADR-126 / T20 — the auto-promotion settings surface renders in a real browser.
// The block ships defaults (master OFF + the four built-in lanes) for any project
// with no stored config, and the hard deny-list renders read-only. The run-panel
// verdict + hold round-trip are covered at the unit (renderToStaticMarkup) and
// route-integration levels; this e2e proves the settings block mounts + paints.

test.describe("auto-promotion lanes settings (ADR-126)", () => {
  test("project settings shows the lane block with the master toggle, four built-in lanes, and a read-only deny-list", async ({
    page,
  }) => {
    const fx = loadFixtures().byKey.board;

    await page.goto(`/projects/${fx.projectSlug}?tab=settings`);

    // Master toggle (ships OFF for a never-configured project).
    await expect(page.getByTestId("auto-promotion-master")).toBeVisible();

    // The lanes view-table with the four built-in classes.
    const table = page.getByTestId("auto-promotion-lanes-table");

    await expect(table).toBeVisible();

    for (const laneClass of ["docs", "tests", "deps", "config"]) {
      await expect(
        table.getByRole("cell", { name: laneClass, exact: true }),
      ).toBeVisible();
    }

    // The non-configurable deny-list is rendered read-only (CLAUDE.md is denied).
    await expect(page.getByText("CLAUDE.md", { exact: false }).first()).toBeVisible();
  });
});
