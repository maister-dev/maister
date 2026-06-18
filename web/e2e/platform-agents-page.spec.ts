import { expect, test } from "@playwright/test";

// /agents is the admin-only platform-agent catalog, relocated off /settings
// (ADR-093). The admin spec runs as the seeded admin via AUTHED_SPEC
// (`platform-agents-.*`); the member spec opens its own unauthenticated context
// and signs in as the seeded non-admin member.
const MEMBER_EMAIL = "e2e-member@maister.local";
const MEMBER_PASSWORD = "E2eMember!pass1";

test("admin reaches /agents from the nav and sees the platform-agents panel", async ({
  page,
}) => {
  await page.goto("/");
  await page.locator('nav[aria-label="Sections"] a[href="/agents"]').click();

  await expect(page).toHaveURL(/\/agents$/);
  await expect(
    page.getByRole("heading", { level: 1, name: "Platform agents" }),
  ).toBeVisible();
  // The relocated AgentsPanel renders; its re-sync affordance is always present.
  await expect(
    page.getByRole("button", { name: "Re-sync catalog" }),
  ).toBeVisible();
});

test("a non-admin member has no /agents nav link and is forbidden on the route", async ({
  browser,
}) => {
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    await page.goto("/login");
    await page.locator('input[name="email"]').fill(MEMBER_EMAIL);
    await page.locator('input[name="password"]').fill(MEMBER_PASSWORD);
    await page.locator('form button[type="submit"]').click();
    await page.waitForURL((url) => !url.pathname.startsWith("/login"), {
      timeout: 30_000,
    });

    // The admin-only nav item is hidden for a member.
    await expect(
      page.locator('nav[aria-label="Sections"] a[href="/agents"]'),
    ).toHaveCount(0);

    // Direct navigation is gated: forbidden copy, no panel affordance.
    await page.goto("/agents");
    await expect(
      page.getByText("You do not have access to the platform agents catalog."),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Re-sync catalog" }),
    ).toHaveCount(0);
  } finally {
    await context.close();
  }
});
