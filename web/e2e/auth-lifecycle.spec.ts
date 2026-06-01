import type { Page } from "@playwright/test";

import { test, expect } from "@playwright/test";

import { countRows } from "./_seed/db";
import { loadFixtures, type E2EUserFixture } from "./_seed/fixtures";

async function signIn(
  page: Page,
  user: Pick<E2EUserFixture, "email" | "password">,
): Promise<void> {
  await page.goto("/login");
  await page.locator('input[name="email"]').fill(user.email);
  await page.locator('input[name="password"]').fill(user.password);
  await page.locator('form button[type="submit"]').click();
}

test.describe("authentication lifecycle", () => {
  test("rejects invalid credentials", async ({ page }) => {
    await page.goto("/login");
    await page.locator('input[name="email"]').fill("nobody@maister.local");
    await page.locator('input[name="password"]').fill("definitely-wrong");
    await page.locator('form button[type="submit"]').click();

    await expect(page.getByText("Invalid email or password.")).toBeVisible();
    await expect(page).toHaveURL(/\/login/);
  });

  test("pending and disabled users cannot sign in", async ({ page }) => {
    const { users } = loadFixtures();

    await signIn(page, users.pending);
    await expect(
      page.getByText("This account is waiting for admin approval."),
    ).toBeVisible();
    await expect(page).toHaveURL(/\/login/);

    await signIn(page, users.disabled);
    await expect(
      page.getByText("This account is disabled. Ask an admin to re-enable it."),
    ).toBeVisible();
    await expect(page).toHaveURL(/\/login/);
  });

  test("forced-password-change user must set a new password before app access", async ({
    page,
  }) => {
    const { users } = loadFixtures();
    const newPassword = "E2eChanged!pass1";

    await signIn(page, users.mustChange);
    await page.waitForURL(/\/change-password/, { timeout: 30_000 });
    await expect(
      page.getByRole("heading", { name: "Change your password" }),
    ).toBeVisible();

    await page.locator('input[name="password"]').fill(newPassword);
    await page.locator('input[name="confirm"]').fill("E2eDifferent!pass1");
    await page.getByRole("button", { name: "Set password & continue" }).click();
    await expect(
      page.getByText("The two passwords do not match."),
    ).toBeVisible();

    await page.locator('input[name="password"]').fill(newPassword);
    await page.locator('input[name="confirm"]').fill(newPassword);
    await page.getByRole("button", { name: "Set password & continue" }).click();
    await page.waitForURL("/", { timeout: 30_000 });
    await expect(page).not.toHaveURL(/\/change-password/);

    const mustChangeCount = await countRows(
      "users",
      "email = $1 AND must_change_password = true",
      [users.mustChange.email],
    );

    expect(mustChangeCount).toBe(0);
  });

  test("public registration creates a pending member account", async ({
    page,
  }) => {
    const email = `new-user-${Date.now()}@maister.local`;

    await page.goto("/login");
    await page.getByRole("tab", { name: "Create account" }).click();
    await page.locator('input[name="name"]').fill("New E2E User");
    await page.locator('input[name="email"]').fill(email);
    await page.locator('input[name="password"]').fill("E2eNewUser!pass1");
    await page
      .getByText("I'm OK with operating a POC release on a single host.")
      .click();
    await page.getByRole("button", { name: "Create account" }).click();

    await expect(
      page.getByText(
        "Account created. An admin must activate it before you can sign in.",
      ),
    ).toBeVisible();

    const pendingCount = await countRows(
      "users",
      "email = $1 AND role = 'member' AND account_status = 'pending'",
      [email],
    );

    expect(pendingCount).toBe(1);
  });
});
