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
    timeout: 30_000,
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
  if (!baseURL) throw new Error("Playwright baseURL is required");
  const { users } = loadFixtures();
  const context = await browser.newContext({
    baseURL,
    storageState: { cookies: [], origins: [] },
  });
  const page = await context.newPage();

  try {
    await loginAs(page, users.member);
    await page.goto("/projects/new");
    await expect(
      page.getByText("Only an admin can register a project."),
    ).toBeVisible();
  } finally {
    await context.close();
  }
});
