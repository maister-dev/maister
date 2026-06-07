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

test("admin creates a user with a one-time temp password", async ({ page }) => {
  const uniqueEmail = `e2e-created-${Date.now()}@maister.local`;

  await page.goto("/admin/users");
  await expect(
    page.getByRole("heading", { name: "User management" }),
  ).toBeVisible();

  // Click the table "New user" button (not inside a dialog yet).
  await page.getByRole("button", { name: "New user" }).click();

  const dialog = page.getByRole("dialog");

  await expect(dialog).toBeVisible();

  await dialog.getByLabel("Name").fill("E2E Created User");
  await dialog.getByLabel("Email").fill(uniqueEmail);
  await dialog.getByLabel("Role").selectOption("member");
  await dialog.getByLabel("Status").selectOption("active");

  // Submit via the dialog's own "New user" button.
  await dialog.getByRole("button", { name: "New user" }).click();

  // The once-shown temp password banner and Copy button.
  await expect(
    dialog.getByText(
      "This password is shown once — store it securely before closing.",
    ),
  ).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Copy" })).toBeVisible();

  // DB assertions.
  const dbStatus = await singleValue<string>(
    "SELECT account_status AS value FROM users WHERE email = $1",
    [uniqueEmail.toLowerCase()],
  );
  const dbMustChange = await singleValue<boolean>(
    "SELECT must_change_password AS value FROM users WHERE email = $1",
    [uniqueEmail.toLowerCase()],
  );

  expect(dbStatus).toBe("active");
  expect(dbMustChange).toBe(true);
});

test("admin edits a user's name and email", async ({ page }) => {
  const { users } = loadFixtures();
  const newName = "E2E Renamed Member";
  const newEmail = `e2e-renamed-${Date.now()}@maister.local`;

  await page.goto("/admin/users");
  await expect(
    page.getByRole("heading", { name: "User management" }),
  ).toBeVisible();

  await page
    .getByRole("searchbox", { name: "Search by name or email…" })
    .fill(users.member.email);
  await expect(page.getByText(users.member.email)).toBeVisible();

  await page
    .getByRole("button", { name: `Edit · ${users.member.name}`, exact: true })
    .click();

  const dialog = page.getByRole("dialog");

  await expect(dialog).toBeVisible();

  // Clear and fill Name.
  const nameInput = dialog.getByLabel("Name");

  await nameInput.clear();
  await nameInput.fill(newName);

  // Clear and fill Email.
  const emailInput = dialog.getByLabel("Email");

  await emailInput.clear();
  await emailInput.fill(newEmail);

  await dialog.getByRole("button", { name: "Save changes" }).click();
  await expect(dialog).toBeHidden();

  const dbName = await singleValue<string>(
    "SELECT name AS value FROM users WHERE id = $1",
    [users.member.id],
  );
  const dbEmail = await singleValue<string>(
    "SELECT email AS value FROM users WHERE id = $1",
    [users.member.id],
  );

  expect(dbName).toBe(newName);
  expect(dbEmail).toBe(newEmail.toLowerCase());
});

test("admin hard-deletes an unused pending user", async ({ page }) => {
  const { users } = loadFixtures();

  await page.goto("/admin/users");
  await expect(
    page.getByRole("heading", { name: "User management" }),
  ).toBeVisible();

  await page
    .getByRole("searchbox", { name: "Search by name or email…" })
    .fill(users.deletable.email);
  await expect(page.getByText(users.deletable.email)).toBeVisible();

  await page
    .getByRole("button", { name: `Edit · ${users.deletable.name}` })
    .click();

  const dialog = page.getByRole("dialog");

  await expect(dialog).toBeVisible();

  // The Delete button should be enabled (pending + never logged in).
  const deleteBtn = dialog.getByRole("button", { name: "Delete" });

  await expect(deleteBtn).toBeEnabled();
  await deleteBtn.click();
  await expect(dialog).toBeHidden();

  const count = await singleValue<string>(
    "SELECT count(*)::text AS value FROM users WHERE id = $1",
    [users.deletable.id],
  );

  expect(count).toBe("0");
});

test("hard-delete is blocked for an active user", async ({ page }) => {
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

  // The Delete button is rendered aria-disabled for non-pending/active users.
  const deleteBtn = dialog
    .locator("button[aria-disabled]")
    .filter({ hasText: "Delete" });

  await expect(deleteBtn).toBeVisible();
  // aria-disabled is set (not truly disabled via HTML disabled attribute).
  await expect(deleteBtn).toHaveAttribute("aria-disabled");
});
