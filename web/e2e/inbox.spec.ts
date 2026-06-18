import { test, expect } from "@playwright/test";

// Inbox card redesign: the full-bleed, project-grouped /inbox surface rendering
// the unified 3-tier HitlCard, plus the canonical "Needs you" badge fan-out.
// Relies on the shared seed having at least one pending cross-project HITL
// (the board / m17 fixtures seed NeedsInput runs), so needsYou > 0.
test.describe("Inbox card redesign", () => {
  test("the Inbox nav reaches /inbox and renders unified HITL cards", async ({
    page,
  }) => {
    await page.goto("/");

    await page.locator('nav[aria-label="Sections"] a[href="/inbox"]').click();

    await expect(page).toHaveURL(/\/inbox$/);
    await expect(page.getByRole("heading", { name: "Inbox" })).toBeVisible();
    await expect(page.getByTestId("hitl-card").first()).toBeVisible();
  });

  test("a card links to its run and expands its context in place", async ({
    page,
  }) => {
    await page.goto("/inbox");

    const card = page.getByTestId("hitl-card").first();

    await expect(card).toBeVisible();
    // The collapsed card carries a View-run link to the run page.
    await expect(card.locator('a[href^="/runs/"]').first()).toBeVisible();

    // The header toggle drives the collapsed → expanded disclosure.
    const toggle = card.locator("button[aria-expanded]").first();

    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
  });

  test("the rail badge and the home summary show the same canonical count", async ({
    page,
  }) => {
    await page.goto("/");

    const railBadge = page.getByTestId("inbox-nav-badge");
    const summaryCount = page.getByTestId("needs-you-count");

    await expect(railBadge).toBeVisible();
    await expect(summaryCount).toBeVisible();

    const rail = Number((await railBadge.textContent())?.trim());
    const summary = Number((await summaryCount.textContent())?.trim());

    expect(rail).toBeGreaterThan(0);
    expect(rail).toBe(summary);
  });
});
