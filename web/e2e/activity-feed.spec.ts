// E2E-ATN-10 (ADR-169) — the read cursor and the two badges, end to end.
//
// Both cases run as a DEDICATED member, never as the shared admin: the admin
// sees every seeded project, so neither of its counters is a knowable number.
// This reader owns one project, one decision and four activity rows straddling
// a cursor.
//
// The second case is the only end-to-end proof that `decisions` and `updates`
// are separate populations rather than one number rendered twice: a mutation
// that empties one of them leaves the other exactly where it was.

import type { Browser, Page } from "@playwright/test";

import { test, expect } from "@playwright/test";

import { loadFixtures, type E2EUserFixture } from "./_seed/fixtures";

// The project runs authenticated as the seeded admin, so `/login` redirects
// away for it. A member view needs its OWN context, started from empty storage.
const EMPTY_STORAGE = { cookies: [], origins: [] };

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

test("the rail entry lands on /activity and marks itself active", async ({
  page,
}) => {
  await page.goto("/activity");

  const railLink = page.getByTestId("rail-nav-activity");

  await expect(railLink).toHaveAttribute("href", "/activity");
  await expect(railLink).toHaveAttribute("aria-current", "page");
});

// One test, not two: the cursor write is irreversible and the seeded reader is
// shared, so a second test asserting the pre-click state would depend on
// running first. Both halves of `E2E-ATN-10` are asserted around the SAME click.
test("E2E-ATN-10 the divider marks the last visit, and clearing it leaves the decision badge untouched", async ({
  browser,
}) => {
  const fx = loadFixtures().byKey.activityFeed;
  const page = await pageAs(browser, fx.member);

  try {
    await page.goto("/activity");

    const rows = page.getByTestId("activity-row");
    const unreadRows = page.locator(
      '[data-testid="activity-row"][data-activity-unread="true"]',
    );
    const divider = page.getByTestId("activity-divider");
    const decisionsBadge = page.getByTestId("inbox-nav-badge");
    const updatesBadge = page.getByTestId("activity-nav-badge");

    await expect(rows).toHaveCount(4);
    await expect(divider).toBeVisible();
    await expect(unreadRows).toHaveCount(fx.unread);
    await expect(page.getByTestId("activity-caught-up")).toHaveCount(0);

    // Distinct numbers in ONE render is already half the proof: a single value
    // rendered twice could not disagree with itself. The leading digit is the
    // visible badge; what follows it is the screen-reader name.
    expect(fx.decisions).not.toBe(fx.unread);
    await expect(decisionsBadge).toHaveText(String(fx.decisions));
    await expect(updatesBadge).toHaveText(String(fx.unread));

    // ADR-169 D7: only the attention badge wears the attention tone.
    await expect(decisionsBadge).toHaveClass(/bg-amber/);
    await expect(updatesBadge).not.toHaveClass(/amber/);

    await page.getByTestId("activity-mark-read").click();

    // The cursor POST moved `seen_through` past the newest rendered row, so the
    // divider has nothing left to separate and the neutral population is empty.
    await expect(page.getByTestId("activity-caught-up")).toBeVisible({
      timeout: 30_000,
    });
    await expect(divider).toHaveCount(0);
    await expect(unreadRows).toHaveCount(0);
    await expect(rows).toHaveCount(4);
    await expect(updatesBadge).toHaveCount(0);

    // The amber badge is untouched: nothing about a decision queue reads a read
    // cursor. This is the end-to-end proof that the two are separate
    // populations rather than one number rendered twice.
    await expect(decisionsBadge).toHaveText(String(fx.decisions));

    // Monotonic: a reload does not resurrect the divider.
    await page.reload();
    await expect(page.getByTestId("activity-divider")).toHaveCount(0);
    await expect(page.getByTestId("activity-nav-badge")).toHaveCount(0);

    // And the decision is still there to be made.
    await page.goto("/inbox");
    await expect(page.getByTestId("inbox-nav-badge")).toHaveText(
      String(fx.decisions),
    );
  } finally {
    await page.context().close();
  }
});
