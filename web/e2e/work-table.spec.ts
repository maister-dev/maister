// E2E-STG-09 — `/work` lists tasks only from the projects the reader can see,
// and its filters, grouping and saved views survive the round trip through the
// URL.
//
// The scope half is asserted in both directions on purpose: an admin sees rows
// from two projects, and a member of one of them sees the first and not the
// second. A deny-only assertion cannot tell a working scope from an empty page.

import type { Browser, Page } from "@playwright/test";

import { test, expect } from "@playwright/test";

import {
  buildCompiledMcp,
  connectCompiledMcp,
} from "../../mcp/test-support/compiled-client";

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

test("Work, Board, and task detail show the same task status and tone", async ({
  page,
}) => {
  const { alphaSlug, alphaExecutingKeyRef } = loadFixtures().byKey.workTable;
  const status = (scope: ReturnType<Page["getByRole"]>) =>
    scope.locator('[data-task-status="in_progress"]');
  const expectInProgress = async (chip: ReturnType<Page["locator"]>) => {
    await expect(chip).toHaveText("In progress");
    await expect(chip).toHaveAttribute("data-tone", "accent");
  };

  await page.goto(`/work?project=${alphaSlug}`);
  const row = work(page).getByRole("row").filter({
    has: keyCell(page, alphaExecutingKeyRef),
  });

  await expectInProgress(status(row));
  await keyCell(page, alphaExecutingKeyRef).click();
  await page.waitForURL((url) =>
    url.pathname.startsWith(`/projects/${alphaSlug}/tasks/`),
  );
  await expectInProgress(status(work(page)));

  await page.goto(`/projects/${alphaSlug}`);
  const card = page.getByTestId("flight-card").filter({
    has: keyCell(page, alphaExecutingKeyRef),
  });

  await expectInProgress(status(card));
});

for (const appearance of [
  { locale: "en", theme: "light", incoming: "Incoming", ready: "Ready", abandoned: "Abandoned", launch: "Launch", incomingTab: "Incoming", nextLaunch: "Launch a run" },
  { locale: "ru", theme: "dark", incoming: "Входящая", ready: "Готова к запуску", abandoned: "Оставлена", launch: "Запустить", incomingTab: "Входящие", nextLaunch: "Запустить" },
]) {
  test(`task status matches across authorized surfaces in ${appearance.locale} and ${appearance.theme}`, async ({
    page,
    context,
    baseURL,
  }) => {
    const fx = loadFixtures().byKey.workTable;

    await context.addCookies([
      { name: "NEXT_LOCALE", value: appearance.locale, url: baseURL! },
      { name: "theme", value: appearance.theme, url: baseURL! },
    ]);

    await page.goto(`/work?project=${fx.alphaSlug}`);
    await expect(page.locator("html")).toHaveAttribute("lang", appearance.locale);
    await expect(page.locator("html")).toHaveClass(new RegExp(`\\b${appearance.theme}\\b`));
    for (const [key, status, label, tone] of [
      [fx.alphaIncomingKeyRef, "incoming", appearance.incoming, "neutral"],
      [fx.alphaNullTriageKeyRef, "ready", appearance.ready, "success"],
      [fx.alphaAbandonedKeyRef, "abandoned", appearance.abandoned, "neutral"],
    ] as const) {
      const row = work(page).getByRole("row").filter({ has: keyCell(page, key) });
      const chip = row.locator(`[data-task-status="${status}"]`);

      await expect(row.locator("[data-task-status]")).toHaveCount(1);
      await expect(chip).toHaveText(label);
      await expect(chip).toHaveAttribute("data-tone", tone);
      if (status === "ready") {
        await expect(row.getByText(appearance.nextLaunch, { exact: true })).toBeVisible();
      }
    }

    const task = keyCell(page, fx.alphaIncomingKeyRef);
    const taskPath = `/projects/${fx.alphaSlug}/tasks/${fx.alphaIncomingKeyRef.split("-").at(-1)}`;

    await task.focus();
    await expect(task).toBeFocused();
    await task.press("Enter");
    await page.waitForURL((url) => url.pathname === taskPath);
    const headerChip = work(page).locator('[data-task-status="incoming"]');

    await expect(headerChip).toHaveText(appearance.incoming);
    await expect(work(page).locator("[data-task-status]")).toHaveCount(1);
    await expect(headerChip).toHaveAttribute("data-tone", "neutral");
    const color = await headerChip.evaluate((chip) => getComputedStyle(chip).color);

    await page.goto(`/projects/${fx.alphaSlug}`);
    const board = work(page).locator("[data-board]");

    await expect(board.getByText(fx.alphaIncomingKeyRef, { exact: true })).toHaveCount(0);
    const abandoned = board.locator('[data-stage="abandoned"]');

    await expect(abandoned.getByText(fx.alphaAbandonedKeyRef, { exact: true })).toBeVisible();
    await expect(abandoned.getByRole("button", { name: appearance.launch, exact: true })).toHaveCount(0);
    const ready = board.locator('[data-stage="ready"]');

    await expect(ready.getByText(fx.alphaNullTriageKeyRef, { exact: true })).toBeVisible();
    await expect(work(page).getByRole("tab", { name: new RegExp(`${appearance.incomingTab}.*1`) })).toBeVisible();

    await page.goto(`/projects/${fx.alphaSlug}?tab=incoming`);
    const incoming = page.getByTestId("incoming-request")
      .filter({ hasText: fx.alphaIncomingKeyRef })
      .locator('[data-task-status="incoming"]');

    await expect(incoming).toHaveText(appearance.incoming);
    await expect(incoming).toHaveAttribute("data-tone", "neutral");
    await expect(incoming).toHaveCSS("color", color);

    for (const path of ["/", "/inbox"]) {
      await page.goto(path);
      const card = page.getByTestId("decision-card").filter({ hasText: fx.alphaIncomingKeyRef });
      const chip = card.locator('[data-task-status="incoming"]');

      await expect(chip).toHaveText(appearance.incoming);
      await expect(chip).toHaveCSS("color", color);
      await expect(chip).toHaveAttribute("data-tone", "neutral");
    }

    if (appearance.locale === "en") {
      // Use native fetch to keep the disposable bearer out of Playwright traces.
      const origin = new URL(page.url()).origin;
      const cookie = (await context.cookies(origin))
        .map(({ name, value }) => `${name}=${value}`)
        .join("; ");
      const issued = await fetch(`${origin}/api/projects/${fx.alphaSlug}/tokens`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json", origin },
        body: JSON.stringify({
          name: "Work status parity",
          scopes: ["tasks:read"],
          expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
        }),
      });

      expect(issued.status).toBe(201);
      const { token }: { token: string } = await issued.json();
      const response = await fetch(`${origin}/api/v1/ext/projects/${fx.alphaSlug}/tasks`, {
        headers: { authorization: `Bearer ${token}` },
      });

      expect(response.status).toBe(200);
      const { tasks }: { tasks: Array<{ id: string; number: number; displayStatus: unknown }> } =
        await response.json();
      const taskNumber = Number(fx.alphaIncomingKeyRef.split("-").at(-1));
      const task = tasks.find(({ number }) => number === taskNumber);
      const expected = { key: "incoming", label: appearance.incoming, tone: "neutral" };

      if (!task) throw new Error(`Task list did not include fixture ${fx.alphaIncomingKeyRef}`);
      expect(task.displayStatus).toEqual(expected);
      await buildCompiledMcp();
      const mcp = await connectCompiledMcp({ baseUrl: origin, token });

      try {
        const result = await mcp.client.callTool({
          name: "task_get",
          arguments: { slug: fx.alphaSlug, taskId: task.id },
        });
        const content = result.content as Array<{ type: string; text?: string }>;
        const text = content.find(({ type }) => type === "text")?.text;

        expect(result.isError).not.toBe(true);
        if (!text) throw new Error("task_get did not return a text result");
        expect(JSON.parse(text).displayStatus).toEqual(expected);
      } finally {
        await mcp.close();
      }
    }
  });
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
  await work(page).locator('select[name="status"]').selectOption("ready");
  await page.getByRole("button", { name: "Apply" }).click();

  await page.waitForURL(/\/work\?.*project=/);
  expect(new URL(page.url()).searchParams.get("project")).toBe(fx.alphaSlug);
  expect(new URL(page.url()).searchParams.get("status")).toBe("ready");

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
