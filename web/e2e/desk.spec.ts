// The Desk, end to end (`E2E-NAV-01`, `E2E-NAV-02`, `E2E-EDGE-NAV-01`,
// `E2E-EDGE-NAV-02`) — ADR-171.
//
// Three states, three readers, because the states are properties of WHO is
// looking rather than of a page flag:
//
//   busy   — the shared admin: it sees every seeded project, so the decision
//            queue, the work table and the feed are all non-empty.
//   quiet  — the `/work` fixture's member: one project, work in flight, and no
//            decision of any kind.
//   empty  — a member of no project at all.
//
// The tile-versus-badge case moved here from Phase 5, where no page rendered a
// tile yet. It asserts the equality that ADR-168 `ATN-05` actually claims — the
// Desk's Decisions region against the rail badge — and asserts that the Now
// `decisions` TILE is deliberately a different, smaller number: T5.4 defines it
// as decisions that are NEW since the reader's cursor, while the badge carries
// the whole queue. Asserting those two equal would be asserting a bug.

import type { Browser, Page } from "@playwright/test";

import { test, expect } from "@playwright/test";

import { loadFixtures, type E2EUserFixture } from "./_seed/fixtures";

const EMPTY_STORAGE = { cookies: [], origins: [] };

async function signIn(
  browser: Browser,
  user: Pick<E2EUserFixture, "email" | "password">,
): Promise<{ page: Page; landedOn: string }> {
  const context = await browser.newContext({ storageState: EMPTY_STORAGE });
  const page = await context.newPage();

  await page.goto("/login");
  await page.locator('input[name="email"]').fill(user.email);
  await page.locator('input[name="password"]').fill(user.password);
  await page.locator('form button[type="submit"]').click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), {
    timeout: 60_000,
  });

  return { page, landedOn: new URL(page.url()).pathname };
}

async function digits(page: Page, testid: string): Promise<number> {
  const text = await page.getByTestId(testid).textContent();

  return Number((text ?? "").trim());
}

test("E2E-NAV-01 the Desk is home, and every region it promises is on it", async ({
  page,
}) => {
  await page.goto("/");

  // The rail says where we are, and it says `home` — not `projects`.
  const railHome = page.getByTestId("rail-nav-home");

  await expect(railHome).toHaveAttribute("href", "/");
  await expect(railHome).toHaveAttribute("aria-current", "page");
  await expect(page.getByTestId("rail-nav-projects")).toHaveAttribute(
    "href",
    "/projects",
  );

  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  // The digest sentence is never blank: an all-zero window collapses to one
  // "nothing happened" clause rather than to an empty string.
  await expect(page.getByTestId("desk-digest")).not.toBeEmpty();

  // Five Now tiles, each a link.
  await expect(page.getByTestId("now-tiles")).toBeVisible();
  await expect(page.locator("[data-now-tile]")).toHaveCount(5);
  for (const tile of ["promoted", "crashed", "decisions", "events", "tokens"]) {
    await expect(page.locator(`[data-now-tile="${tile}"]`)).toHaveAttribute(
      "href",
      /^\//u,
    );
  }

  // All three regions, plus the composer (projects exist for the admin).
  await expect(page.getByTestId("desk-decisions")).toBeVisible();
  await expect(page.getByTestId("desk-work")).toBeVisible();
  await expect(page.getByTestId("desk-activity")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Start a scratch run" }),
  ).toBeVisible();

  // Busy: the admin has decisions, and the Desk composes `/inbox`'s cards
  // rather than a second copy of them.
  expect(await digits(page, "desk-decisions-count")).toBeGreaterThan(0);
  await expect(
    page
      .getByTestId("desk-decisions")
      .locator('[data-testid^="decision-section-"], [data-testid="hitl-card"]')
      .first(),
  ).toBeVisible();

  // The Desk | Projects switch is the explicit control for the two meanings
  // `/` used to carry.
  await expect(page.getByTestId("home-switch-desk")).toHaveAttribute(
    "aria-current",
    "page",
  );
  await page.getByTestId("home-switch-projects").click();
  await expect(page).toHaveURL(/\/projects$/);
  await expect(page.getByRole("heading", { name: "Projects." })).toBeVisible();
});

test("the Desk's Decisions count is the rail badge, and the Now tile is not", async ({
  page,
}) => {
  await page.goto("/");

  const badge = await digits(page, "inbox-nav-badge");
  const region = await digits(page, "desk-decisions-count");

  // `ATN-05`: one layout-level read, two renders of it.
  expect(badge).toBeGreaterThan(0);
  expect(region).toBe(badge);

  // The tile is the windowed number ("new since your last visit"), so it may be
  // anything from zero up to the queue — but never MORE than the queue, which
  // is the only relationship that can be asserted without a fixed cursor.
  const tile = await digits(page, "now-tile-decisions");

  expect(tile).toBeLessThanOrEqual(badge);
});

test("E2E-EDGE-NAV-02 narrow keeps every region, stacked Decisions then Work then Activity", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");

  const boxes: Array<{ id: string; top: number }> = [];

  for (const id of ["desk-decisions", "desk-work", "desk-activity"]) {
    const region = page.getByTestId(id);

    await expect(region).toBeVisible();

    const box = await region.boundingBox();

    expect(box, id).not.toBeNull();
    boxes.push({ id, top: box?.y ?? 0 });
  }

  // No region is dropped, and the order is the one `EDGE-NAV-02` fixes.
  expect(boxes.map((entry) => entry.id)).toEqual([
    "desk-decisions",
    "desk-work",
    "desk-activity",
  ]);
  expect(boxes[0].top).toBeLessThan(boxes[1].top);
  expect(boxes[1].top).toBeLessThan(boxes[2].top);

  // No Desk region scrolls the CONTENT AREA sideways — the 1180px work table
  // scrolls inside its own container instead.
  //
  // Scoped to `main`, not to the document: the shared header overflows a 390px
  // viewport on every route in the app (`/work` and `/inbox` measure 471px and
  // 479px on this same tree), which predates this milestone and belongs to the
  // chrome. Asserting on the document would make this spec fail for a reason
  // that has nothing to do with the Desk.
  const contentOverflows = await page.evaluate(() => {
    const main = document.querySelector("main");

    if (!main) return true;

    return main.scrollWidth > main.clientWidth + 1;
  });

  expect(contentOverflows).toBe(false);

  // And the table really is the thing scrolling, rather than nothing scrolling
  // because nothing rendered.
  const scroller = page
    .getByTestId("desk-work")
    .locator("div.overflow-x-auto")
    .first();

  await expect(scroller).toBeVisible();
  expect(
    await scroller.evaluate((el) => el.scrollWidth > el.clientWidth + 1),
  ).toBe(true);
});

test("E2E-NAV-02 a member lands on /work and an admin on the Desk", async ({
  browser,
}) => {
  const fx = loadFixtures();
  const member = await signIn(browser, fx.byKey.workTable.member);

  try {
    expect(member.landedOn).toBe("/work");
  } finally {
    await member.page.context().close();
  }

  const admin = await signIn(browser, {
    email: fx.adminEmail,
    password: fx.adminPassword,
  });

  try {
    expect(admin.landedOn).toBe("/");
  } finally {
    await admin.page.context().close();
  }
});

test("the quiet Desk says so instead of rendering an empty Decisions region", async ({
  browser,
}) => {
  const fx = loadFixtures().byKey.workTable;
  const { page } = await signIn(browser, fx.member);

  try {
    await page.goto("/");

    // Quiet: projects exist, work is in flight, nothing is blocked on the reader.
    expect(await digits(page, "desk-decisions-count")).toBe(0);
    await expect(page.getByTestId("desk-decisions")).toContainText(
      "Nothing is blocked on you.",
    );
    expect(await digits(page, "desk-work-count")).toBeGreaterThan(0);
    await expect(page.getByTestId("desk-work")).toContainText(fx.alphaName);
    // The Desk renders for a member too — only the LANDING route forks by role.
    await expect(page.getByTestId("now-tiles")).toBeVisible();
    await expect(page.getByTestId("desk-empty")).toHaveCount(0);
  } finally {
    await page.context().close();
  }
});

test("E2E-EDGE-NAV-01 the empty Desk reuses the first-run frame and drops the composer", async ({
  browser,
}) => {
  const fx = loadFixtures().byKey.desk;
  const { page } = await signIn(browser, fx.nobody);

  try {
    await page.goto("/");

    const empty = page.getByTestId("desk-empty");

    await expect(empty).toBeVisible();
    // The first-run checklist and the empty-state card, INSIDE the Desk frame.
    await expect(empty.getByTestId("portfolio-onboarding")).toBeVisible();
    await expect(empty.getByTestId("portfolio-empty-state")).toBeVisible();

    // The composer is absent, not disabled — there is nowhere for a scratch run
    // to go until a project exists.
    await expect(
      page.getByRole("button", { name: "Start a scratch run" }),
    ).toHaveCount(0);

    // The Desk frame itself survives: the tiles are all zero, not missing.
    await expect(page.getByTestId("now-tiles")).toBeVisible();
    expect(await digits(page, "now-tile-decisions")).toBe(0);
    await expect(page.getByTestId("desk-digest")).not.toBeEmpty();
  } finally {
    await page.context().close();
  }
});
