import { test, expect } from "@playwright/test";

import { loadFixtures } from "./_seed/fixtures";

// Regression: the edit-task modal's right "Properties" panel must scroll
// independently inside the height-capped grid. The bug was an `auto` grid-row
// track that grew to the taller (right) column's content, overflowed the
// section's `max-h-[calc(100vh-32px)]`, and got clipped by `overflow-hidden` —
// so the lower fields (auto-promotion / relations) and the Save button were
// unreachable. The fix bounds the lg row track (`lg:grid-rows-[minmax(0,1fr)]`)
// and moves each column's scroll into an inner `h-full ... overflow-y-auto`
// wrapper, so both columns scroll within the section instead of clipping.
test("edit-task Properties panel scrolls and the Save button is reachable on a short viewport", async ({
  page,
}) => {
  const fx = loadFixtures().byKey.board;

  // A viewport shorter than the panel's content forces the scroll path; on a
  // tall viewport everything fits and the regression would not reproduce.
  await page.setViewportSize({ width: 1280, height: 600 });
  await page.goto(`/projects/${fx.projectSlug}`);

  const card = page
    .locator("[data-board]")
    .getByText("Acceptance backlog launch")
    .locator("xpath=ancestor::article");

  await card.getByRole("button", { name: "Edit task", exact: true }).click();

  const dialog = page.locator('section[role="dialog"][aria-modal="true"]');
  await expect(dialog).toBeVisible();

  const panel = dialog.locator("aside");
  const scroller = panel.locator(".overflow-y-auto").first();

  // The inner scroller is bounded by the section height → it is scrollable
  // (content taller than the visible area), and it does NOT overflow the
  // section (no clipping of the lower fields).
  const metrics = await scroller.evaluate((el) => {
    const section = el.closest('section[role="dialog"]') as HTMLElement;
    return {
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      panelHeight: Math.round(
        (el.closest("aside") as HTMLElement).getBoundingClientRect().height,
      ),
      sectionHeight: Math.round(section.getBoundingClientRect().height),
    };
  });

  expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight + 1);
  expect(metrics.panelHeight).toBeLessThanOrEqual(metrics.sectionHeight + 1);

  // The Save button lives at the bottom of the panel; it must become reachable
  // by scrolling the panel (it was clipped out of the section before the fix).
  const saveButton = dialog.getByRole("button", { name: "Save", exact: true });

  await scroller.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });

  await expect(saveButton).toBeInViewport();
});
