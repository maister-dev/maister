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

  await expect(page.getByTestId("desk-work")).toBeVisible();
  await expect(page.getByTestId("desk-activity")).toBeVisible();

  // `T-D22` / `EDGE-NAV-01`, the other half: absent even WITH projects.
  await expect(
    page.getByRole("button", { name: "Start a scratch run" }),
  ).toHaveCount(0);

  // Busy: the admin has work in flight, and it is rendered ONCE — as rows.
  // ADR-174 D2 removed the Decisions region because three of its four
  // populations were these same rows under another name.
  await expect(page.getByTestId("desk-decisions")).toHaveCount(0);
  await expect(
    page.getByTestId("desk-work").locator('[data-testid="work-row"]').first(),
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

test("ATN-05 the rail badge is the number /inbox renders", async ({ page }) => {
  // Re-homed from the Desk by ADR-174: the Desk no longer renders a decisions
  // number, because it no longer renders a decisions REGION. `ATN-05`'s text is
  // surface-agnostic — "every surface MUST render one layout-level `decisions`
  // value" — so the assertion follows the surviving surface rather than dying
  // with the removed one.
  await page.goto("/");

  const badge = await digits(page, "inbox-nav-badge");

  expect(badge).toBeGreaterThan(0);

  await page.goto("/inbox");

  // Asserted on `/inbox`'s own copy, with no testid added there: this change
  // does not touch that surface.
  await expect(
    page.getByText(/things waiting on you across all projects/u),
  ).toHaveText(new RegExp(`^${badge}\\b`, "u"));
});

// ── A row expands into its decision panel (ADR-174 D2) ─────────────────────
//
// `T-D14`. The interaction itself is proved in jsdom, in CI
// (`components/work/__tests__/work-rows-table.dom.test.ts`); what needs a real
// page is that the panel a given STAGE opens is the right one, wired to the
// right run, against seeded data.

test("T-D14 each stage expands to its own panel, and Review never promotes inline", async ({
  page,
}) => {
  await page.goto("/");

  const work = page.getByTestId("desk-work");
  const expandable = work.locator('tr[data-testid="work-row"][aria-expanded]');

  // The Desk opts in; every row it renders can be opened.
  expect(await expandable.count()).toBeGreaterThan(0);

  const seen = new Set<string>();

  for (const stage of IN_FLIGHT_STAGES) {
    const row = work
      .locator(`tr[data-testid="work-row"][data-stage="${stage}"]`)
      .first();

    if ((await row.count()) === 0) continue;

    // A row is expandable only when its stage actually resolves to content: a
    // `Queued` or `Executing` run with no recent events opens onto nothing, and
    // an affordance that promises a panel and delivers an empty box is worse
    // than no affordance. `aria-expanded` is therefore the feature detector.
    if ((await row.getAttribute("aria-expanded")) === null) continue;

    await row.click();
    await expect(row).toHaveAttribute("aria-expanded", "true");

    const panel = work
      .locator('[data-testid="work-row-panel"]:not([hidden])')
      .first();

    await expect(panel, stage).toBeVisible();
    seen.add(stage);

    if (stage === "Review") {
      // `REQ-D14`: a LINK to the review surface, never an inline promote. The
      // drift-guarded reviewed target commit exists only there, so promoting
      // from here would promote something the reader never saw.
      await expect(panel.locator('a[href*="wb=review"]')).toHaveCount(1);
      await expect(
        panel.getByRole("button", { name: /promote/iu }),
        "no promote control may render in a Desk panel",
      ).toHaveCount(0);
    }

    await row.click();
    await expect(row).toHaveAttribute("aria-expanded", "false");
  }

  // A seeded Desk that happened to contain no in-flight row would make every
  // assertion above vacuous.
  expect(
    seen.size,
    "no expandable stage was present in the fixture",
  ).toBeGreaterThan(0);
});

test("E2E-EDGE-NAV-02 narrow keeps every region, stacked strip then Work then Held then Activity", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");

  const boxes: Array<{ id: string; top: number }> = [];

  // `desk-held` renders only when a `flagged` decision exists — it is the one
  // decision kind no work row carries — so it is included when present rather
  // than required, and the ORDER is asserted over whatever is there.
  for (const id of ["now-tiles", "desk-work", "desk-held", "desk-activity"]) {
    const region = page.getByTestId(id);

    if (id === "desk-held" && (await region.count()) === 0) continue;

    await expect(region, id).toBeVisible();

    const box = await region.boundingBox();

    expect(box, id).not.toBeNull();
    boxes.push({ id, top: box?.y ?? 0 });
  }

  // Every region that exists is present and in source order — and since there
  // is only ONE arrangement now (`REQ-D21`), this IS the order at every width.
  expect(
    boxes.length,
    "strip, work and activity are never dropped",
  ).toBeGreaterThanOrEqual(3);
  expect(boxes.map((entry) => entry.top)).toEqual(
    [...boxes.map((entry) => entry.top)].sort((a, b) => a - b),
  );

  // Nothing scrolls the PAGE sideways.
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

  // INVERTED by ADR-174 `REQ-D11`: the table no longer scrolls inside its own
  // container — it drops columns by priority instead. A horizontal scroller on
  // a phone hides data behind a gesture nobody makes.
  const work = page.getByTestId("desk-work");

  await expect(work.locator("div.overflow-x-auto")).toHaveCount(0);

  const table = work.locator("table").first();

  await expect(table).toBeVisible();
  expect(
    await table.evaluate((el) => el.scrollWidth > el.clientWidth + 1),
    "the table must fit its container at 390px",
  ).toBe(false);

  // `T-D11`: an expanded panel still spans the FULL painted width at 390px.
  // jsdom can prove the colSpan VALUE but applies no stylesheet, so only a real
  // viewport can show that the cell actually covers the row once columns drop.
  const expandableRow = work
    .locator('tr[data-testid="work-row"][aria-expanded]')
    .first();

  if ((await expandableRow.count()) > 0) {
    await expandableRow.click();

    const rowBox = await expandableRow.boundingBox();
    const panelBox = await work
      .locator('[data-testid="work-row-panel"]:not([hidden]) td')
      .first()
      .boundingBox();

    expect(rowBox, "the row is laid out").not.toBeNull();
    expect(panelBox, "the panel cell is laid out").not.toBeNull();
    // Within a pixel: the panel must not stop short of the row it belongs to.
    expect(
      Math.abs((panelBox?.width ?? 0) - (rowBox?.width ?? 0)),
      "panel cell spans the full row width at 390px",
    ).toBeLessThanOrEqual(1);

    await expandableRow.click();
  }

  // And it fits because columns DROPPED, not because nothing rendered.
  await expect(work.locator('[data-testid="work-row"]').first()).toBeVisible();
  expect(
    await work.locator("thead th").count(),
    "low-priority headers are still in the DOM, hidden by CSS",
  ).toBeGreaterThan(0);
  expect(
    await work.locator("thead th:visible").count(),
    "but fewer of them are painted at 390px",
  ).toBeLessThan(await work.locator("thead th").count());
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
    expect(await digits(page, "desk-work-count")).toBeGreaterThan(0);
    await expect(page.getByTestId("desk-work")).toContainText(fx.alphaName);

    // No Held region — `Held` is the one decision kind no work row carries, and
    // this reader has none of it. Quiet is now the ABSENCE of that region
    // rather than a region saying it is empty.
    await expect(page.getByTestId("desk-held")).toHaveCount(0);

    // And the tiles that mean "a human is needed" are zero, while the strip
    // itself still renders all five — `REQ-D1`.
    for (const stage of ["WaitingOnHuman", "Review", "Crashed"]) {
      expect(await digits(page, `now-tile-${stage}`), stage).toBe(0);
    }
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

    // `T-D22`: the composer is absent UNCONDITIONALLY now (`REQ-D22`) — not
    // "until a project exists". The rail owns the launcher and the shortcut.
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

// `NAV-08` — one work item, one object (ADR-174).
//
// This is the change's reason for existing, and until now nothing would have
// caught its regression. The counted finding behind the ADR was a single task
// rendered FOUR times on one screen; a `WaitingOnHuman` row is the exact shape
// that used to produce two of them — a work row and a HITL card — because
// `STAGE_BY_KIND` maps the `hitl` decision kind onto an in-flight stage.
//
// The activity feed is deliberately excluded: it is a log of EVENTS, and
// ADR-174 D4 refuses to collapse it.

test("E2E-NAV-08 a task in flight and blocked on a human is ONE object", async ({
  page,
}) => {
  await page.goto("/");

  const work = page.getByTestId("desk-work");
  const blocked = work
    .locator('tr[data-testid="work-row"][data-stage="WaitingOnHuman"]')
    .first();

  // The fixture must actually contain the shape under test, or this passes
  // vacuously — which is how a guard for "exactly one" quietly becomes a guard
  // for "at most one, including zero".
  await expect(
    blocked,
    "the seeded Desk must hold a WaitingOnHuman row",
  ).toBeVisible();

  const key = (await blocked.locator("td").first().innerText()).trim();

  expect(key, "the row names its task").not.toBe("");

  // Every object on the Desk that renders this task, OUTSIDE the activity log.
  const objects = page.locator(
    [
      `[data-testid="work-row"]:has-text("${key}")`,
      `[data-testid="hitl-card"]:has-text("${key}")`,
      `[data-testid="decision-card"]:has-text("${key}")`,
    ].join(", "),
  );

  expect(
    await objects.count(),
    `${key} must appear exactly once outside the activity feed`,
  ).toBe(1);

  // And its decision is reachable — merged INTO that one object rather than
  // deleted along with the duplicate.
  await blocked.click();
  await expect(blocked).toHaveAttribute("aria-expanded", "true");
  await expect(
    work.locator('[data-testid="work-row-panel"]:not([hidden])'),
  ).toHaveCount(1);
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
