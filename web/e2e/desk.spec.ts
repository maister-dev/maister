// The Desk, end to end (`E2E-NAV-01`, `E2E-NAV-02`, `E2E-EDGE-NAV-01`,
// `E2E-EDGE-NAV-02`) — ADR-172.
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
// ADR-174 retargets the Now strip: its five tiles are the five in-flight WORK
// STAGES, counted from the rows the table renders, not the five numbers of a
// digest window. There is therefore no `decisions` tile left to compare against
// the rail badge — the `ATN-05` equality that survives is the Desk's Decisions
// region against that badge, and it is asserted on its own below.

import type { Browser, Page } from "@playwright/test";

import { test, expect } from "@playwright/test";

import { loadFixtures, type E2EUserFixture } from "./_seed/fixtures";

const EMPTY_STORAGE = { cookies: [], origins: [] };

// `WORK_IN_FLIGHT_STAGES`, spelled out: an e2e spec must not import server
// modules, and a sixth in-flight stage should fail HERE as a count mismatch
// rather than pass silently against a list derived from the code under test.
const IN_FLIGHT_STAGES = [
  "Queued",
  "Executing",
  "WaitingOnHuman",
  "Review",
  "Crashed",
] as const;

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
  // ADR-174 D3: no digest sentence, no window, no period selector.
  await expect(page.getByTestId("desk-digest")).toHaveCount(0);

  // Five Now tiles — the in-flight partition — each filtering `/` in place.
  await expect(page.getByTestId("now-tiles")).toBeVisible();
  await expect(page.locator("[data-now-tile]")).toHaveCount(5);
  for (const stage of IN_FLIGHT_STAGES) {
    await expect(page.locator(`[data-now-tile="${stage}"]`)).toHaveAttribute(
      "href",
      `/?stage=${stage}`,
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

// ── The Now strip filters the table in place (ADR-174 D1/D3) ───────────────
//
// `T-D3`/`T-D5`/`T-D6`. These are e2e rather than unit because every one of them
// is about a URL, a navigation and what the server then renders — none of which
// a pure function or a markup snapshot can see.

const DESK_WORK_ROWS = 12;

async function deskRows(page: Page): Promise<number> {
  return page
    .getByTestId("desk-work")
    .locator('[data-testid="work-row"]')
    .count();
}

test("T-D3 a Now tile filters the Desk in place, and a bad value does not", async ({
  page,
}) => {
  await page.goto("/");

  const unfiltered = await deskRows(page);

  expect(unfiltered).toBeGreaterThan(0);

  // 1 — the filter narrows to exactly its stage, and the URL stays on `/`.
  await page.locator('[data-now-tile="Crashed"]').click();
  await expect(page).toHaveURL(/\/\?stage=Crashed$/u);

  const crashedTile = await digits(page, "now-tile-Crashed");
  const crashedRows = await deskRows(page);
  const work = page.getByTestId("desk-work");

  // Every row rendered under the filter really is that stage — a row count
  // alone would pass for a filter that narrowed to the wrong population.
  expect(await work.locator('[data-stage="Crashed"]').count()).toBe(
    crashedRows,
  );

  // 2 — narrowed BEFORE the slice: the table shows the first `DESK_WORK_ROWS`
  // of the whole crashed population, not the crashed rows among the first 12.
  // Counting after the slice is the plausible-looking bug this catches.
  expect(crashedRows).toBe(Math.min(crashedTile, DESK_WORK_ROWS));

  // 3 — an unknown value, and a valid-but-settled one, both render unfiltered
  // rather than refusing (`REQ-D3`).
  for (const value of ["Nonsense", "Promoted"]) {
    await page.goto(`/?stage=${value}`);
    expect(await deskRows(page), value).toBe(unfiltered);
    await expect(
      page.locator("[data-now-tile][aria-current]"),
      value,
    ).toHaveCount(0);
  }
});

test("T-D5 an active filter survives a re-render that discards client state", async ({
  page,
}) => {
  await page.goto("/?stage=Crashed");

  const before = await deskRows(page);

  await expect(page.locator('[data-now-tile="Crashed"]')).toHaveAttribute(
    "aria-current",
    "true",
  );

  // `AttentionLiveRefresh` answers a tick with `router.refresh()`, which
  // re-renders the CURRENT url on the server. Waiting for a real tick would be
  // waiting on a fixture's background activity, so this asserts the property
  // that MAKES the filter tick-proof: it is derived from the URL and from
  // nothing else.
  //
  // A full reload is deliberately HARSHER than the tick — it destroys every
  // piece of client state a refresh would keep. A filter that survives this
  // cannot be lost by a refresh; one held in `useState` would fail here, and
  // that is the regression `REQ-D5` exists to catch.
  await page.reload();

  await expect(page).toHaveURL(/\/\?stage=Crashed$/u);
  await expect(page.locator('[data-now-tile="Crashed"]')).toHaveAttribute(
    "aria-current",
    "true",
  );
  expect(await deskRows(page)).toBe(before);
});

test("T-D6 a filter matching nothing says so, distinctly, and offers a way back", async ({
  browser,
}) => {
  // The `/work` fixture's member has work in flight and nothing crashed, so a
  // crashed filter is genuinely empty for them without seeding a new state.
  const fx = loadFixtures().byKey.workTable;
  const { page } = await signIn(browser, fx.member);

  try {
    await page.goto("/");

    const unfilteredEmpty = page.getByTestId("desk-work-empty");

    // Precondition: unfiltered, this reader's Desk is NOT empty.
    await expect(unfilteredEmpty).toHaveCount(0);

    await page.goto("/?stage=Crashed");

    const filtered = page.getByTestId("desk-work-filtered");

    // Distinct from the unfiltered empty state — a filtered Desk that reads
    // "Nothing is running." tells the reader the platform is dead (`REQ-D6`).
    await expect(filtered).toBeVisible();
    await expect(unfilteredEmpty).toHaveCount(0);
    await expect(filtered).toContainText("Crashed");

    // And the filter is reversible from the empty state itself.
    await filtered.getByRole("link").click();
    await expect(page).toHaveURL(/\/$/u);
    expect(await deskRows(page)).toBeGreaterThan(0);
  } finally {
    await page.context().close();
  }
});

test("the Desk's Decisions count is the rail badge", async ({ page }) => {
  await page.goto("/");

  const badge = await digits(page, "inbox-nav-badge");
  const region = await digits(page, "desk-decisions-count");

  // `ATN-05`: one layout-level read, two renders of it.
  expect(badge).toBeGreaterThan(0);
  expect(region).toBe(badge);
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

  // Nothing scrolls the PAGE sideways — the 1180px work table scrolls inside
  // its own container instead.
  //
  // Asserted on the DOCUMENT, not on `main`. It was scoped to `main` while the
  // shared header overflowed 390px on every route in the app (`/work` measured
  // 471px, `/inbox` 479px); that was chrome, not the Desk, so the narrower
  // scope kept this spec honest about what it owned. The header now fits — see
  // `E2E-NAV-07` — so the assertion covers what `EDGE-NAV-02` actually claims.
  const pageOverflows = await page.evaluate(
    () =>
      document.documentElement.scrollWidth >
      document.documentElement.clientWidth + 1,
  );

  expect(pageOverflows).toBe(false);

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

    // The Desk frame itself survives: all five tiles render at zero, not
    // missing — `REQ-D1`. A reader with no projects still sees the shape.
    await expect(page.getByTestId("now-tiles")).toBeVisible();
    await expect(page.locator("[data-now-tile]")).toHaveCount(5);
    for (const stage of IN_FLIGHT_STAGES) {
      expect(await digits(page, `now-tile-${stage}`), stage).toBe(0);
    }
    await expect(page.getByTestId("desk-digest")).toHaveCount(0);
  } finally {
    await page.context().close();
  }
});

// The shared `(app)` header, measured rather than eyeballed (`NAV-07`).
//
// It overflowed a 390px viewport on EVERY route — `gap-8` + `px-6` spend 80px
// before a single control renders, and flex items default to `min-width: auto`,
// so nothing shrank. Four routes because the header is chrome: a fix that only
// held on the Desk would be a fix for one page.
const PRIMARY_NAV = 'nav[aria-label="Primary navigation"]';

test("E2E-NAV-07 the header fits a 390px viewport on every route", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });

  for (const route of ["/", "/work", "/inbox", "/projects"]) {
    await page.goto(route);
    await expect(page.locator(PRIMARY_NAV), route).toBeVisible();

    const measured = await page.evaluate((selector) => {
      const root = document.documentElement;
      const header = document.querySelector(selector);

      return {
        document: root.scrollWidth,
        client: root.clientWidth,
        nav: header ? header.scrollWidth : -1,
        viewport: window.innerWidth,
      };
    }, PRIMARY_NAV);

    expect(measured.nav, `${route} nav`).toBeLessThanOrEqual(measured.viewport);
    expect(measured.document, `${route} document`).toBeLessThanOrEqual(
      measured.client + 1,
    );
  }
});

// The two things the narrow header must NOT trade away for that fit.
test("E2E-NAV-07 narrow keeps the rail toggle and every accessible name", async ({
  page,
}) => {
  await page.goto("/work");

  const accountName = async (): Promise<string> =>
    (
      (await page
        .locator(`${PRIMARY_NAV} summary span`)
        .nth(1)
        .textContent()) ?? ""
    ).trim();

  const wide = await accountName();

  expect(wide.length).toBeGreaterThan(0);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/work");

  // The only way to reach navigation below `md`.
  await expect(page.getByTestId("mobile-rail-toggle")).toBeVisible();

  // Each control is found BY its accessible name, so a name dropped along with
  // the visible text fails here rather than silently degrading.
  await expect(
    page.getByRole("button", { name: /^Switch language to/u }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /^Switch to (dark|light) mode$/u }),
  ).toBeVisible();

  // The user's name is TRUNCATED, not removed: the DOM text is what the
  // control's accessible name is computed from, so it must read identically at
  // both widths even though only part of it is painted at 390px.
  expect(await accountName()).toBe(wide);
});
