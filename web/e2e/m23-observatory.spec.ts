import { test, expect } from "@playwright/test";

import { loadFixtures, type E2EM23Fixture } from "./_seed/fixtures";

function loadM23(): E2EM23Fixture {
  return loadFixtures().byKey.m23;
}

test.describe("M23 Observatory", () => {
  // ADR-177: the section opens on the overview table, and the flow ledger
  // moved under `?view=quality`.
  test("the portfolio opens on the overview table with totals and the Platform row", async ({
    page,
  }) => {
    await page.goto("/observatory");

    await expect(
      page.getByRole("heading", { name: "Observatory" }),
    ).toBeVisible();
    await expect(page.getByTestId("observatory-overview")).toBeVisible();
    await expect(page.getByTestId("observatory-overview-total")).toBeVisible();
    // The flow-ledger summary is no longer the first screen.
    await expect(page.getByText("Correction rate")).toHaveCount(0);

    const overview = page.getByTestId("observatory-overview");

    await expect(overview).toContainText("MAIster E2E M23 Observatory");
    // The authed project runs as the seeded global admin, so the project-less
    // Studio scratch run shows on its own row.
    await expect(overview).toContainText("Platform");
    await expect(page.getByTestId("observatory-cost-strip")).toBeVisible();
  });

  test("an overview cell opens the ledger filtered to exactly that cell", async ({
    page,
  }) => {
    const fx = loadM23();

    await page.goto("/observatory");

    // Scope to THIS fixture's row: the portfolio lists every visible project,
    // and `.first()` would read whichever row sorts first — a cell that may
    // legitimately hold 0 and prove nothing.
    const cell = page
      .getByTestId("observatory-overview")
      .locator("tr")
      .filter({ hasText: "MAIster E2E M23 Observatory" })
      .locator(
        `a[href*="project=${fx.projectSlug}"][href*="bucket=Delivered"]`,
      );
    const count = Number((await cell.innerText()).trim());

    expect(count).toBeGreaterThan(0);
    await cell.click();

    await expect(page).toHaveURL(/\/runs\?.*bucket=Delivered/);
    await expect(page).toHaveURL(/from=\d{4}-\d{2}-\d{2}/);
    await expect(page.getByLabel("Outcome")).toHaveValue("Delivered");
    // AC4: the cell's count IS the list it opened.
    await expect(page.locator("tbody tr")).toHaveCount(count);
  });

  test("quality view renders metrics, signals, filters, and node detail", async ({
    page,
  }) => {
    const fx = loadM23();

    await page.goto("/observatory?view=quality");

    // The Quality view renders each metric NAME twice — once on the tile/card
    // and once as a per-project column header — so a bare `getByText` is a
    // strict-mode violation. Address each surface on its own terms.
    await expect(page.getByText("Correction rate · Flow runs")).toBeVisible();
    await expect(
      page.getByRole("columnheader", { name: "Correction rate" }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Autonomy Score" }),
    ).toBeVisible();
    await expect(
      page.getByRole("columnheader", { name: "Autonomy Score" }),
    ).toBeVisible();
    await expect(page.getByText("Repeated unit gate failed")).toBeVisible();
    await expect(
      page.getByText("access_token=[redacted] failed"),
    ).toBeVisible();
    await expect(
      page.getByTestId("observatory-quality-projects"),
    ).toBeVisible();

    await page.goto(
      `/projects/${fx.projectSlug}/observatory?view=quality&flowId=${fx.flowId}&nodeId=${fx.nodeId}`,
    );

    await expect(
      page.getByRole("heading", { name: /Observatory/ }),
    ).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Flow" })).toHaveValue(
      fx.flowId,
    );
    await expect(page.getByRole("textbox", { name: "Node" })).toHaveValue(
      fx.nodeId,
    );
    await expect(page.getByText("Latest attempt by run")).toBeVisible();
    await expect(page.getByText("#2 · Succeeded").first()).toBeVisible();

    // A drill-down link that names no view still lands on Quality.
    await page.goto(`/projects/${fx.projectSlug}/observatory?nodeId=missing`);

    await expect(
      page.getByText("No node attempts in this window.").first(),
    ).toBeVisible();
  });

  test("harness view renders firing stats, never-fired badge, and coverage", async ({
    page,
  }) => {
    const fx = loadM23();

    await page.goto(`/projects/${fx.projectSlug}/observatory?view=harness`);

    await expect(
      page.getByRole("heading", { name: "Sensor firing" }),
    ).toBeVisible();
    // unit gate: 2 failed + 2 passed seeded executions
    await expect(page.getByText("50% (n=4)")).toBeVisible();
    // lint gate: 10 passed, zero failed/stale -> silent at the default
    // threshold (rendered in both the firing and effectiveness tables)
    await expect(page.getByText("0% (n=10)").first()).toBeVisible();
    await expect(page.getByText("never fired", { exact: true })).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Coverage map" }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "aif", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("guides without sensors", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Control effectiveness" }),
    ).toBeVisible();
  });

  test("the filter bar applies without an Apply button", async ({ page }) => {
    const fx = loadM23();

    await page.goto(`/projects/${fx.projectSlug}/observatory`);

    await expect(page.getByRole("button", { name: "Apply" })).toHaveCount(0);

    await page.getByLabel("Run kind").selectOption("scratch");

    await expect(page).toHaveURL(/runKind=scratch/);
    await expect(page.getByLabel("Run kind")).toHaveValue("scratch");
    await expect(
      page.getByRole("heading", { name: "Agentization" }),
    ).toBeVisible();
    await expect(page.getByTestId("observatory-agentization")).toContainText(
      "2 / 10",
    );
    await expect(page.getByTestId("observatory-agentization")).toContainText(
      "Scratch",
    );
    await expect(
      page.getByRole("heading", { name: "Run autonomy funnel" }),
    ).toBeVisible();

    // Quality is the whole not-applicable state for a non-flow kind.
    await page.getByRole("tab", { name: "Quality" }).click();
    await expect(page).toHaveURL(/view=quality/);
    await expect(
      page.getByText("Not applicable — flow ledger only.").first(),
    ).toBeVisible();
  });

  // ADR-177: the overview table is wider than a laptop viewport by design. The
  // contract is that ITS container scrolls, never the page — a table that
  // pushes the shell sideways is the defect that "no responsive column
  // dropping" was chosen to avoid, and it is invisible in a class assertion.
  test("the overview table carries its own horizontal scroll at xl and md", async ({
    page,
  }) => {
    for (const [label, width] of [
      ["xl", 1440],
      ["md", 768],
    ] as const) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/observatory");
      await expect(page.getByTestId("observatory-overview")).toBeVisible();

      // The STRICT check: the table's scroll container must fit inside its
      // own section. This is the containment the design turns on, it is local
      // to the component, and it carries no tolerance.
      expect(
        await page.getByTestId("observatory-overview").evaluate((section) => {
          const container = section.querySelector<HTMLElement>(
            "div.overflow-x-auto",
          );

          return container === null
            ? true
            : container.clientWidth <= section.clientWidth + 1;
        }),
        `${label}: the scroll container must fit its section`,
      ).toBe(true);

      // The page-level check keeps a one-scrollbar tolerance. Resizing an
      // already-rendered page makes Chromium report `scrollWidth` against a
      // layout viewport that still excludes the vertical scrollbar, which
      // shows up as a steady ~16px with no element actually out of bounds (a
      // DOM probe at a clean 768 load finds none). A real containment
      // failure is the table's ~1080px, not 16.
      await expect
        .poll(
          () =>
            page.evaluate(
              () =>
                document.documentElement.scrollWidth -
                document.documentElement.clientWidth,
            ),
          { message: `${label}: the page must not scroll horizontally` },
        )
        .toBeLessThanOrEqual(17);

      if (width < 1080) {
        const container = page
          .getByTestId("observatory-overview")
          .locator("div.overflow-x-auto");

        expect(
          await container.evaluate((el) => el.scrollWidth > el.clientWidth),
          `${label}: the table container must carry the scroll`,
        ).toBe(true);
      }
    }
  });

  test("an uncommitted draft survives a view switch", async ({ page }) => {
    await page.goto("/observatory?view=quality");

    const node = page.getByRole("textbox", { name: "Node" });

    // Typed, never committed: no blur, no Enter.
    await node.fill("draft-node");
    await expect(page).not.toHaveURL(/nodeId=/);

    await page.getByRole("tab", { name: "Harness" }).click();
    await expect(page).toHaveURL(/view=harness/);

    // The bar is mounted ONCE above the view switch, so the draft is still
    // there to commit.
    await expect(page.getByRole("textbox", { name: "Node" })).toHaveValue(
      "draft-node",
    );
  });

  test("a project with no cache and no usable repository renders read-only insufficient evidence", async ({
    page,
  }) => {
    const fx = loadM23();

    await page.goto(`/projects/${fx.noCacheProjectSlug}/observatory`);

    await expect(
      page.getByRole("heading", { name: "Agentization" }),
    ).toBeVisible();
    await expect(
      page.getByText("Insufficient delivery evidence"),
    ).toBeVisible();
  });

  test("RU locale renders Observatory labels per view", async ({
    page,
    context,
  }) => {
    const fx = loadM23();

    await context.addCookies([
      {
        name: "NEXT_LOCALE",
        value: "ru",
        url: process.env.E2E_BASE_URL ?? "http://localhost:3100",
      },
    ]);

    await page.goto("/observatory");

    await expect(
      page.getByRole("heading", { name: "Обсерватория" }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Запущенная работа" }),
    ).toBeVisible();
    await expect(page.getByRole("tab", { name: "Обзор" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    // `runBucket.*` is shared with the ledger, so the columns are localized.
    await expect(page.getByTestId("observatory-overview")).toContainText(
      "Доставлено",
    );

    // View-SPECIFIC strings: the page eyebrow renders on every view and would
    // pass this assertion without the view ever changing.
    await page.goto("/observatory?view=quality");
    await expect(
      page.getByText("Коэффициент исправлений").first(),
    ).toBeVisible();
    await expect(
      page.getByTestId("observatory-quality-projects"),
    ).toContainText("По проектам");

    await page.goto("/observatory?view=harness");
    await expect(
      page.getByRole("heading", { name: "Контур контроля" }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Карта покрытия" }),
    ).toBeVisible();

    await page.goto(`/projects/${fx.projectSlug}/observatory`);
    await expect(
      page.getByRole("heading", { name: "Агентизация" }),
    ).toBeVisible();
  });
});
