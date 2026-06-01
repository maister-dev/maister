import { test, expect } from "@playwright/test";

import { singleValue } from "./_seed/db";
import { loadFixtures } from "./_seed/fixtures";

test("admin can filter and edit a user account", async ({ page }) => {
  const { users } = loadFixtures();

  await page.goto("/admin/users");
  await expect(
    page.getByRole("heading", { name: "User management" }),
  ).toBeVisible();

  await page
    .getByRole("searchbox", { name: "Search by name or email…" })
    .fill(users.editTarget.email);
  await expect(page.getByText(users.editTarget.email)).toBeVisible();

  await page
    .getByRole("button", { name: `Edit · ${users.editTarget.name}` })
    .click();
  const dialog = page.getByRole("dialog");

  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Role").selectOption("admin");
  await dialog.getByLabel("Status").selectOption("disabled");
  await dialog.getByLabel("Reset password").fill("E2eResetTarget!pass1");
  await dialog.getByRole("button", { name: "Save changes" }).click();
  await expect(dialog).toBeHidden();

  const role = await singleValue<string>(
    "SELECT role AS value FROM users WHERE id = $1",
    [users.editTarget.id],
  );
  const status = await singleValue<string>(
    "SELECT account_status AS value FROM users WHERE id = $1",
    [users.editTarget.id],
  );
  const mustChange = await singleValue<boolean>(
    "SELECT must_change_password AS value FROM users WHERE id = $1",
    [users.editTarget.id],
  );

  expect(role).toBe("admin");
  expect(status).toBe("disabled");
  expect(mustChange).toBe(true);
});
