// Auth fixture for the `authed` Playwright project. Runs after the webServer is
// ready (it's a test, not globalSetup), signs the seeded e2e admin in through
// the real credentials form, and persists the session cookies as storageState.
import { readFileSync } from "node:fs";
import path from "node:path";

import { test as setup, expect } from "@playwright/test";

const AUTH_FILE = "e2e/.auth/admin.json";

type Fixtures = { adminEmail: string; adminPassword: string };

function loadFixtures(): Fixtures {
  return JSON.parse(
    readFileSync(path.resolve("e2e/.auth/fixtures.json"), "utf8"),
  ) as Fixtures;
}

setup("authenticate seeded admin", async ({ page }) => {
  const { adminEmail, adminPassword } = loadFixtures();

  await page.goto("/login");
  await page.locator('input[name="email"]').fill(adminEmail);
  await page.locator('input[name="password"]').fill(adminPassword);
  await page.locator('form button[type="submit"]').click();

  // The seeded admin has must_change_password=false, so a successful sign-in
  // lands on the portfolio home — never back on /login or /change-password.
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), {
    timeout: 30_000,
  });
  await expect(page).not.toHaveURL(/\/(login|change-password)/);

  await page.context().storageState({ path: AUTH_FILE });
});
