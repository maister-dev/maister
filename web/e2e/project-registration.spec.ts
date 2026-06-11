import type { Page } from "@playwright/test";

import { test, expect } from "@playwright/test";

import { countRows } from "./_seed/db";
import { loadFixtures, type E2EUserFixture } from "./_seed/fixtures";

async function loginAs(page: Page, user: E2EUserFixture): Promise<void> {
  await page.goto("/login");
  await page.locator('input[name="email"]').fill(user.email);
  await page.locator('input[name="password"]').fill(user.password);
  await page.locator('form button[type="submit"]').click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), {
    timeout: 60_000,
  });
}

test("admin registers a local project and duplicate registration conflicts", async ({
  page,
}) => {
  const fx = loadFixtures().byKey.registration;

  await page.goto("/projects/new");
  await page.locator('input[name="target"]').fill(fx.repoPath);

  const registerResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/projects") &&
      response.request().method() === "POST",
  );

  await page.getByRole("button", { name: "Register project" }).click();
  expect((await registerResponse).status()).toBe(201);
  await expect(page.getByText("Project registered")).toBeVisible();
  await expect(
    page.getByRole("link", { name: /Open project/ }),
  ).toHaveAttribute("href", `/projects/${fx.expectedSlug}`);

  const registeredCount = await countRows("projects", "slug = $1", [
    fx.expectedSlug,
  ]);

  expect(registeredCount).toBe(1);

  await page.getByRole("button", { name: "Register another" }).click();
  await page.locator('input[name="target"]').fill(fx.repoPath);

  const duplicateResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/projects") &&
      response.request().method() === "POST",
  );

  await page.getByRole("button", { name: "Register project" }).click();
  expect((await duplicateResponse).status()).toBe(409);
  await expect(
    page.getByText(
      "A project with this slug or repo path is already registered.",
    ),
  ).toBeVisible();
});

test("non-admin users cannot register projects", async ({
  browser,
  baseURL,
}) => {
  // The only test in this file doing a cold credentials login (no
  // storageState); under full-suite parallel dev-server compiles the login
  // round-trip alone can eat the default 30s budget.
  test.slow();
  if (!baseURL) throw new Error("Playwright baseURL is required");
  const { users } = loadFixtures();
  const context = await browser.newContext({
    baseURL,
    storageState: { cookies: [], origins: [] },
  });
  const page = await context.newPage();

  try {
    // users.memberCandidate, NOT users.member: admin-users.spec renames
    // member's email in the DB mid-suite, which kills member's fixture
    // credentials whenever that spec wins the parallel race. memberCandidate's
    // user row is never mutated (project-members.spec only touches its
    // project_members rows).
    await loginAs(page, users.memberCandidate);
    await page.goto("/projects/new");
    await expect(
      page.getByText("Only an admin can register a project."),
    ).toBeVisible();
  } finally {
    await context.close();
  }
});
