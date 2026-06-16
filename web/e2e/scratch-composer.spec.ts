import { expect, test } from "@playwright/test";

import { loadFixtures } from "./_seed/fixtures";

// FR-D (T5.2): the unified token-aware composer's interactive behaviour is
// e2e-only (the unit lane has no DOM). Exercises the `/` trigger → suggestion
// popup (sourced from the project capability catalog) → atomic chip insert.
test("capability composer: typing / opens the suggestion popup and inserts a chip", async ({
  page,
}) => {
  const fx = loadFixtures().byKey.scratch;

  // The composer's autocomplete is gated on the catalog fetch — await it so the
  // `/` keystroke deterministically has items (no race).
  const catalogLoaded = page.waitForResponse(
    (res) => res.url().includes("/capability-catalog"),
    { timeout: 20_000 },
  );

  await page.goto(`/scratch-runs/new?projectId=${fx.projectId}`);

  const form = page.locator("main");

  await expect(form.getByLabel("Project")).toHaveValue(fx.projectId, {
    timeout: 15_000,
  });
  await catalogLoaded;

  const editor = page.getByTestId("capability-composer-input");

  await expect(editor).toBeVisible();
  await editor.click();
  await page.keyboard.type("use /aif");

  // The seeded `aif-plan` skill drives the suggestion popup.
  const item = page.locator(
    '[data-testid="capability-suggestion-item"][data-slug="aif-plan"]',
  );

  await expect(item).toBeVisible({ timeout: 10_000 });
  await item.click();

  // The selection becomes an atomic chip; the popup closes.
  const chip = page.locator(
    '[data-testid="capability-chip"][data-slug="aif-plan"]',
  );

  await expect(chip).toBeVisible();
  await expect(chip).toHaveAttribute("data-kind", "skill");
  await expect(page.getByTestId("capability-suggestions")).toHaveCount(0);
});
