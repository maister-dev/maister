import { test, expect } from "@playwright/test";

// WI-1: the unified /inbox surface + the canonical "Needs you" badge fan-out.
// Relies on the shared seed having at least one pending cross-project HITL
// (the board / m17 fixtures seed NeedsInput runs), so needsYou > 0.
test.describe("Unified inbox (WI-1)", () => {
  test("the Inbox nav reaches /inbox and lists cross-project HITL", async ({
    page,
  }) => {
    await page.goto("/");

    await page.locator('nav[aria-label="Sections"] a[href="/inbox"]').click();

    await expect(page).toHaveURL(/\/inbox$/);
    await expect(page.getByRole("heading", { name: "Inbox" })).toBeVisible();
    // The page reuses the cross-project HITL block that used to live on home.
    await expect(page.getByTestId("cross-project-hitl-inbox")).toBeVisible();
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
