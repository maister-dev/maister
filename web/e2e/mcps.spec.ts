import { test, expect } from "@playwright/test";

// WI-2: the platform MCP catalog (admin) is reachable behind the admin nav.
// The seeded user is the bootstrap admin, so the nav item is present and the
// route's requireGlobalRole("admin") passes.
test("admin reaches the /mcps catalog from the nav", async ({ page }) => {
  await page.goto("/");

  await page.locator('nav[aria-label="Sections"] a[href="/mcps"]').click();

  await expect(page).toHaveURL(/\/mcps$/);
  await expect(
    page.getByRole("heading", { level: 1, name: "MCP servers" }),
  ).toBeVisible();
  // The reused platform MCP panel renders; its create affordance is always present.
  await expect(
    page.getByRole("button", { name: "Add MCP server" }),
  ).toBeVisible();
});
