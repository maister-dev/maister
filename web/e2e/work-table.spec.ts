// E2E-STG-09 — `/work` lists tasks only from the projects the reader can see,
// and its filters, grouping and saved views survive the round trip through the
// URL.
//
// The scope half is asserted in both directions on purpose: an admin sees rows
// from two projects, and a member of one of them sees the first and not the
// second. A deny-only assertion cannot tell a working scope from an empty page.

import type { Browser, Page } from "@playwright/test";

import { test, expect } from "@playwright/test";

import { loadFixtures, type E2EUserFixture } from "./_seed/fixtures";

// The project runs authenticated as the seeded admin, so `/login` redirects
// away for it. A member view needs its OWN context, started from empty storage.
const EMPTY_STORAGE = { cookies: [], origins: [] };

// Page content is read inside <main>: for a moment after a load the page can be
// in the document twice (web/CLAUDE.md, "A freshly loaded page can be in the
// DOM twice"). Role locators already skip the hidden copy.
function work(page: Page) {
  return page.getByRole("main");
}

async function pageAs(browser: Browser, user: E2EUserFixture): Promise<Page> {
  const context = await browser.newContext({ storageState: EMPTY_STORAGE });
  const page = await context.newPage();

  await page.goto("/login");
  await page.locator('input[name="email"]').fill(user.email);
  await page.locator('input[name="password"]').fill(user.password);
  await page.locator('form button[type="submit"]').click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), {
    timeout: 60_000,
  });

  return page;
}

function keyCell(page: Page, keyRef: string) {
  return page.getByRole("link", { name: keyRef, exact: true });
}

test("E2E-STG-09 admin reads rows from every visible project; a member only their own", async ({
  browser,
  page,
}) => {
  const fx = loadFixtures().byKey.workTable;

  await page.goto("/work");
  await expect(keyCell(page, fx.alphaKeyRef)).toBeVisible();
  await expect(keyCell(page, fx.betaKeyRef)).toBeVisible();

  const memberPage = await pageAs(browser, fx.member);

  await memberPage.goto("/work");
  await expect(keyCell(memberPage, fx.alphaKeyRef)).toBeVisible();
  await expect(keyCell(memberPage, fx.betaKeyRef)).toHaveCount(0);

  // The project filter can only offer what the reader can already reach.
  await expect(
    work(memberPage).locator('select[name="project"] option', {
      hasText: fx.betaName,
    }),
  ).toHaveCount(0);
  await memberPage.context().close();
});

test("the rail entry lands on /work and marks itself active", async ({
  page,
}) => {
  await page.goto("/work");

  const railLink = page.getByTestId("rail-nav-work");

  await expect(railLink).toHaveAttribute("href", "/work");
  await expect(railLink).toHaveAttribute("aria-current", "page");
});

test("filters and grouping round-trip through the URL", async ({ page }) => {
  const fx = loadFixtures().byKey.workTable;

  await page.goto("/work");
  await work(page).locator('select[name="project"]').selectOption(fx.alphaSlug);
  await work(page).locator('select[name="stage"]').selectOption("Ready");
  await page.getByRole("button", { name: "Apply" }).click();

  await page.waitForURL(/\/work\?.*project=/);
  expect(new URL(page.url()).searchParams.get("project")).toBe(fx.alphaSlug);
  expect(new URL(page.url()).searchParams.get("stage")).toBe("Ready");

  await expect(keyCell(page, fx.alphaKeyRef)).toBeVisible();
  await expect(keyCell(page, fx.alphaExecutingKeyRef)).toHaveCount(0);
  await expect(keyCell(page, fx.betaKeyRef)).toHaveCount(0);

  // A deep link reconstructs the same view without touching the form.
  await page.goto(`/work?project=${fx.alphaSlug}&group=stage`);
  await expect(work(page).locator('tbody[data-group="Ready"]')).toHaveCount(1);
  await expect(work(page).locator('tbody[data-group="Executing"]')).toHaveCount(
    1,
  );
  await expect(work(page).locator('select[name="group"]')).toHaveValue("stage");
});

test("E2E-STG-09 an unreachable project filter is dropped, not refused", async ({
  browser,
}) => {
  const fx = loadFixtures().byKey.workTable;
  const memberPage = await pageAs(browser, fx.member);
  const response = await memberPage.goto(`/work?project=${fx.betaSlug}`);

  expect(response?.status()).toBe(200);
  await expect(work(memberPage).getByTestId("work-empty")).toBeVisible();
  await expect(keyCell(memberPage, fx.betaKeyRef)).toHaveCount(0);
  await memberPage.context().close();
});

test("a saved view restores its filters", async ({ page }) => {
  const fx = loadFixtures().byKey.workTable;

  await page.goto(`/work?project=${fx.alphaSlug}&stage=Ready`);
  await work(page).getByLabel("Name this view").fill("Alpha ready");
  await page.getByRole("button", { name: "Save this view" }).click();

  await page.goto("/work");
  await expect(keyCell(page, fx.betaKeyRef)).toBeVisible();

  await page.getByRole("link", { name: "Alpha ready", exact: true }).click();
  await page.waitForURL(/project=/);

  expect(new URL(page.url()).searchParams.get("project")).toBe(fx.alphaSlug);
  expect(new URL(page.url()).searchParams.get("stage")).toBe("Ready");
  await expect(keyCell(page, fx.alphaKeyRef)).toBeVisible();
  await expect(keyCell(page, fx.betaKeyRef)).toHaveCount(0);
});
