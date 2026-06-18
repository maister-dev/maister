import path from "node:path";

import { test, expect } from "@playwright/test";

import { countRows } from "./_seed/db";

// ADR-093 onboarding redesign. Runs as the seeded admin (authed storageState).
// Covers the two behaviors the headless component tests cannot drive:
//   1. live URL→name/key prefill (onChange) + dirty-stop,
//   2. the new-empty (greenfield) mode end-to-end.

test("prefills name + task key from the Git URL; a manual edit stops prefill", async ({
  page,
}) => {
  await page.goto("/projects/new");

  // Default mode is "clone" → the URL field is shown.
  await page
    .locator('input[name="repoUrl"]')
    .fill("git@github.com:org/my-cool-repo.git");

  await expect(page.locator('input[name="name"]')).toHaveValue("my-cool-repo");
  await expect(page.locator('input[name="taskKey"]')).toHaveValue("MYC");

  // A manual name edit marks the field dirty; later URL changes no longer
  // overwrite it.
  await page.locator('input[name="name"]').fill("Custom Name");
  await page
    .locator('input[name="repoUrl"]')
    .fill("git@github.com:org/other-repo.git");

  await expect(page.locator('input[name="name"]')).toHaveValue("Custom Name");
});

test("registers a new empty project with no maister.yaml (initialized)", async ({
  page,
}) => {
  // Absolute path under the e2e runtime root → mkdir stays out of ~/.maister.
  const location = path.resolve(`e2e/.runtime/greenfield-${Date.now()}`);
  const expectedSlug = path.basename(location);

  await page.goto("/projects/new");

  // Switch to greenfield mode → the URL field disappears.
  await page.getByRole("radio", { name: "New empty project" }).click();
  await expect(page.locator('input[name="repoUrl"]')).toHaveCount(0);

  await page.locator('input[name="target"]').fill(location);

  const registerResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/projects") &&
      response.request().method() === "POST",
  );

  await page.getByRole("button", { name: "Register project" }).click();
  expect((await registerResponse).status()).toBe(201);

  // gitStatus "initialized" → success state (not the remote redirect).
  await expect(page.getByText("Project registered")).toBeVisible();
  await expect(
    page.getByRole("link", { name: /Open project/ }),
  ).toHaveAttribute("href", `/projects/${expectedSlug}`);

  // Registered from DB defaults — the config lives only in the DB.
  const count = await countRows(
    "projects",
    "slug = $1 AND maister_yaml_path IS NULL",
    [expectedSlug],
  );

  expect(count).toBe(1);
});
