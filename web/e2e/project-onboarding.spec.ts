import path from "node:path";

import { test, expect, type Page } from "@playwright/test";

import { countRows } from "./_seed/db";

// Register a new-empty (greenfield) project and land on its board. Returns the
// derived slug. The greenfield repo is git-initialized on `main` (ADR-093), so
// it is persist-eligible.
async function registerNewEmpty(page: Page, location: string): Promise<string> {
  const slug = path.basename(location);

  await page.goto("/projects/new");
  await page.getByRole("radio", { name: "New empty project" }).click();
  await page.locator('input[name="target"]').fill(location);
  await page.getByRole("button", { name: "Register project" }).click();
  await page.getByRole("link", { name: /Open project/ }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${slug}(\\?|$)`));

  return slug;
}

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

test("renders a classified, collapsible error when a clone fails", async ({
  page,
}) => {
  await page.goto("/projects/new");

  // Unique repo name → a fresh clone is attempted; a refused localhost URL
  // fails fast → a classified clone PRECONDITION carrying advisory detail.
  await page
    .locator('input[name="repoUrl"]')
    .fill(`https://127.0.0.1:1/x/clonefail-${Date.now()}.git`);

  const res = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/projects") &&
      response.request().method() === "POST",
  );

  await page.getByRole("button", { name: "Register project" }).click();
  expect((await res).status()).toBe(409);

  // The collapsible git-output block is unique to the clone-error surface.
  await expect(page.getByText("Show git output")).toBeVisible();
});

test("persists a new-empty project's config from the board banner", async ({
  page,
}) => {
  const slug = await registerNewEmpty(
    page,
    path.resolve(`e2e/.runtime/persist-${Date.now()}`),
  );

  // The persist banner shows on the board (admin + config lives only in the DB).
  await expect(
    page.getByRole("button", { name: "Persist to maister.yaml" }),
  ).toBeVisible();

  const persisted = page.waitForResponse(
    (response) =>
      response.url().includes(`/projects/${slug}/persist-config`) &&
      response.request().method() === "POST",
  );

  await page.getByRole("button", { name: "Persist to maister.yaml" }).click();
  // The confirm step's button is the bare "Persist".
  await page.getByRole("button", { name: "Persist", exact: true }).click();
  expect((await persisted).status()).toBe(200);

  await expect(
    page.getByText("Config persisted to maister.yaml"),
  ).toBeVisible();

  // Closing refreshes server data → needsPersist flips → the banner is gone.
  await page.getByRole("button", { name: "Close" }).click();
  await expect(
    page.getByRole("button", { name: "Persist to maister.yaml" }),
  ).toHaveCount(0);
});

test("adds a git remote from Settings → Git", async ({ page }) => {
  const slug = await registerNewEmpty(
    page,
    path.resolve(`e2e/.runtime/remotes-${Date.now()}`),
  );

  await page.goto(`/projects/${slug}?tab=settings`);
  await expect(
    page.getByRole("heading", { name: "Git remotes" }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Add remote" }).click();

  const dialog = page.getByRole("dialog");

  await dialog.getByPlaceholder("origin").fill("origin");
  await dialog
    .getByPlaceholder("git@github.com:org/app.git")
    .fill("https://github.com/e2e/added.git");

  const added = page.waitForResponse(
    (response) =>
      response.url().includes(`/projects/${slug}/remotes`) &&
      response.request().method() === "POST",
  );

  await dialog.getByRole("button", { name: "Add remote" }).click();
  expect((await added).status()).toBe(201);

  await expect(
    page.getByText("https://github.com/e2e/added.git"),
  ).toBeVisible();
});
