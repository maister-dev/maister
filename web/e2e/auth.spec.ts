import { test, expect } from "@playwright/test";

test.describe("authentication and redirects", () => {
  test("visiting / unauthenticated redirects to /login", async ({ page }) => {
    await page.goto("/");

    await expect(page).toHaveURL(/\/login/);
  });

  test("login page is accessible", async ({ page }) => {
    await page.goto("/login");

    await expect(page).toHaveURL(/\/login/);
    await expect(page.locator("text=/sign in/i")).toBeVisible();
  });

  test("login form has email and password fields", async ({ page }) => {
    await page.goto("/login");

    const emailInput = page.locator('input[type="email"]');
    const passwordInput = page.locator('input[type="password"]');

    await expect(emailInput).toBeVisible();
    await expect(passwordInput).toBeVisible();
  });
});
