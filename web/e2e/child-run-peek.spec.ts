import type { RunResultContract } from "@/lib/run-results/types";
import type { Locator, Page } from "@playwright/test";

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { test, expect } from "@playwright/test";

import { withE2EDb } from "./_seed/db";

// These journeys share the seeded main Run and deliberately change its state.
// Keep independent cases sequential; the two-window case owns connection concurrency.
test.describe.configure({ mode: "default" });

type PeekFixture = {
  anchor: string;
  child: string;
  sibling: string;
  grandchild: string;
};
let fixture: PeekFixture;

test.beforeEach(async () => {
  const all = JSON.parse(
    readFileSync(path.resolve("e2e/.auth/fixtures.json"), "utf8"),
  ) as { byKey: { m22: { runId: string } } };

  fixture = {
    anchor: all.byKey.m22.runId,
    child: randomUUID(),
    sibling: randomUUID(),
    grandchild: randomUUID(),
  };
  await withE2EDb(async (pool) => {
    for (const [id, parent, label] of [
      [fixture.child, fixture.anchor, "Researcher Alpha"],
      [fixture.sibling, fixture.anchor, "Researcher Beta"],
      [fixture.grandchild, fixture.child, "Analyst Gamma"],
    ]) {
      await pool.query(
        "INSERT INTO runs(id,project_id,run_kind,status,flow_version,flow_revision,parent_run_id,root_run_id,agent_workspace,delegation_snapshot) SELECT $1,project_id,'agent','Running','v1','peek',$2,$3,'none',$4 FROM runs WHERE id=$3",
        [id, parent, fixture.anchor, { kind: "runner", runnerId: label }],
      );
      await pool.query(
        "INSERT INTO run_messages(id,run_id,sequence,role,content) VALUES($1,$2,1,'assistant',$3)",
        [randomUUID(), id, `Conversation of ${label}`],
      );
    }
  });
});
test.afterEach(async () => {
  await withE2EDb((pool) =>
    pool.query("DELETE FROM runs WHERE id=ANY($1::text[])", [
      [fixture.child, fixture.sibling, fixture.grandchild],
    ]),
  );
});
function peek(page: Page) {
  return page.getByTestId("run-peek-panel");
}

async function scrollWithinPeek(
  message: Locator,
  viewportFraction: number,
): Promise<void> {
  await message.evaluate((element, fraction) => {
    const root = element.closest('[data-testid="run-peek-scroll"]');

    if (!(root instanceof HTMLElement))
      throw new Error("Transcript message has no peek scroll owner");
    const bounds = root.getBoundingClientRect();
    const top = Math.max(0, bounds.top);
    const height = Math.min(window.innerHeight, bounds.bottom) - top;

    root.scrollTop +=
      element.getBoundingClientRect().top - top - height * fraction;
  }, viewportFraction);
}

async function trackFetchSignals(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const requests: { url: string; signal: AbortSignal | null | undefined }[] =
      [];
    const fetch = window.fetch.bind(window);

    Object.assign(window, { peekRequestSignals: requests });
    window.fetch = (input, init) => {
      const url = String(input);

      if (url.includes("/children?") || url.includes("/transcript?"))
        requests.push({ url, signal: init?.signal });

      return fetch(input, init);
    };
  });
}

test("E2E-PKN-01 E2E-PKN-03 E2E-PKN-07: nested navigation keeps the original Run and browser history", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto(`/runs/${fixture.anchor}?wb=files&file=README.md#inspect`);
  await expect(page.getByTestId("orchestrator-run-subtree")).toHaveCount(0);
  const children = page.getByTestId("run-inspector-child-runs");

  await expect(children).toHaveCount(1);
  await expect(
    children.getByRole("navigation", { name: "Child Run pages" }),
  ).toHaveCount(0);
  const trigger = page
    .getByTestId("run-inspector-child-runs")
    .locator(`[data-child-run-id="${fixture.child}"] a`);

  await trigger.click();
  await expect(page).toHaveURL(
    new RegExp(`/runs/${fixture.anchor}\\?.*peek=${fixture.child}`),
  );
  await expect(peek(page)).toBeVisible();
  await expect(peek(page)).toContainText("Researcher Alpha");
  await peek(page)
    .getByRole("link", { name: /Analyst Gamma/ })
    .click();
  await expect(page).toHaveURL(new RegExp(`peek=${fixture.grandchild}`));
  await expect(
    peek(page)
      .getByRole("navigation", { name: "Run hierarchy" })
      .locator(`[data-peek-trigger="${fixture.grandchild}"]`),
  ).toHaveAttribute("aria-current", "page");
  await expect(peek(page)).toHaveAttribute(
    "data-selected-run",
    fixture.grandchild,
  );
  await peek(page).getByRole("button", { name: "Previous selection" }).click();
  await expect(peek(page)).toHaveAttribute("data-selected-run", fixture.child);
  await peek(page)
    .locator(`[data-child-run-id="${fixture.sibling}"] a`)
    .click();
  await expect(peek(page)).toHaveAttribute(
    "data-selected-run",
    fixture.sibling,
  );
  await page.goBack();
  await expect(peek(page)).toHaveAttribute("data-selected-run", fixture.child);
  await page.goForward();
  await expect(peek(page)).toHaveAttribute(
    "data-selected-run",
    fixture.sibling,
  );
  await expect(page).toHaveURL(/wb=files/);
  await expect(page).toHaveURL(/file=README.md/);
  await expect(page).toHaveURL(/#inspect$/);
});

test("E2E-PKD-07 E2E-PKN-06 E2E-PKN-12: selected content stays read-only and live after completion", async ({
  page,
}) => {
  await page.goto(`/runs/${fixture.anchor}?peek=${fixture.child}`);
  await expect(peek(page)).toContainText("Conversation of Researcher Alpha");
  await expect(peek(page).locator("textarea")).toHaveCount(0);
  await expect(
    peek(page).getByRole("link", { name: "Open full Run" }),
  ).toHaveAttribute("href", `/runs/${fixture.child}`);
  await withE2EDb((pool) =>
    pool.query("UPDATE runs SET status='Done' WHERE id=$1", [fixture.child]),
  );
  await expect(peek(page)).toHaveAttribute("data-selected-run", fixture.child);
  await expect(peek(page)).toContainText("Done");
  await expect(page.getByTestId("run-header-status")).toContainText("Running");
});

test("E2E-PKN-04 E2E-PKN-08 E2E-PKN-10: parent file, inspector and librarian draft survive keyboard peek and resize", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto(`/runs/${fixture.anchor}?wb=files&file=README.md`);
  await page
    .getByTestId("run-inspector")
    .getByRole("tab", { name: "Flow", exact: true })
    .click();
  await page.getByTestId("librarian-trigger").click();
  const librarian = page.getByTestId("librarian-panel");

  await librarian.locator("textarea").fill("Keep this unsubmitted draft");
  const main = page.getByTestId("run-shell-main");

  await main.evaluate((element) =>
    element.setAttribute("data-preservation-probe", "retained"),
  );
  const trigger = page
    .getByTestId("run-inspector-child-runs")
    .locator(`[data-child-run-id="${fixture.child}"] a`);

  await trigger.scrollIntoViewIfNeeded();
  await trigger.focus();
  const scroll = await page.evaluate(() => window.scrollY);

  await trigger.press("Enter");
  await expect(peek(page)).toContainText("Researcher Alpha");
  await expect(page.getByTestId("run-shell-inspector")).toBeHidden();
  await expect(librarian).toBeHidden();
  await expect(main).toHaveAttribute("data-preservation-probe", "retained");
  expect(await page.evaluate(() => window.scrollY)).toBe(scroll);
  await page.keyboard.press("Escape");
  await expect(peek(page)).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await expect(
    page
      .getByTestId("run-inspector")
      .getByRole("tab", { name: "Flow", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(librarian).toBeVisible();
  await expect(librarian.locator("textarea")).toHaveValue(
    "Keep this unsubmitted draft",
  );
  await trigger.click();
  await expect(peek(page)).toBeVisible();
  await page.setViewportSize({ width: 1024, height: 900 });
  await expect(peek(page)).toHaveAttribute("aria-modal", "true");
  await page.keyboard.press("Escape");
  await expect(peek(page)).toHaveCount(0);
  await expect(librarian).toBeHidden();
  await expect(trigger).toBeFocused();
  await page.getByTestId("librarian-trigger").click();
  await expect(librarian.locator("textarea")).toHaveValue(
    "Keep this unsubmitted draft",
  );
});

for (const width of [1536, 1024, 767, 320]) {
  test(`E2E-PKN-09 E2E-PKN-10: responsive panel and keyboard at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/runs/${fixture.anchor}?peek=${fixture.child}`);
    await expect(peek(page)).toContainText("Conversation of Researcher Alpha");
    await expect(peek(page)).toHaveAttribute(
      "data-modal",
      width < 1536 ? "true" : "false",
    );
    const box = await peek(page).boundingBox();

    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(width);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);
    for (const tab of await peek(page).getByRole("tab").all()) {
      const bounds = await tab.boundingBox();

      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
    }
    if (width < 1536) {
      const controls = peek(page).locator(
        "a[href],button:not([disabled]),select",
      );

      await peek(page).getByRole("heading", { level: 2 }).first().focus();
      await page.keyboard.press("Shift+Tab");
      await expect(controls.last()).toBeFocused();
      await controls.first().focus();
      await page.keyboard.press("Shift+Tab");
      await expect(controls.last()).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(controls.first()).toBeFocused();
    } else {
      await page
        .getByTestId("run-shell-main")
        .getByRole("tab", { name: "Timeline", exact: true })
        .focus();
      await page.keyboard.press("Escape");
      await expect(peek(page)).toBeVisible();
      await peek(page).getByRole("button", { name: "Close peek" }).focus();
    }
    await page.keyboard.press("Escape");
    await expect(peek(page)).toHaveCount(0);
    await expect(page.locator('[data-testid="run-shell"] h1')).toBeFocused();
  });
}

test("E2E-PKN-02 E2E-PKN-11: Russian entry labels, result availability and controls retain parity", async ({
  page,
  context,
}) => {
  await context.addCookies([
    { name: "NEXT_LOCALE", value: "ru", domain: "localhost", path: "/" },
  ]);
  await page.setViewportSize({ width: 767, height: 900 });
  await page.goto(`/runs/${fixture.anchor}`);
  const trigger = page
    .getByTestId("run-inspector-child-runs")
    .locator(`[data-child-run-id="${fixture.child}"] a`);

  await trigger.click();
  await expect(
    peek(page).getByRole("link", { name: "Открыть полный Run" }),
  ).toHaveAttribute("href", `/runs/${fixture.child}`);
  await expect(peek(page)).toContainText(fixture.child.slice(0, 8));
  await peek(page)
    .getByRole("tab", { name: "Публичный результат", exact: true })
    .click();
  await expect(peek(page)).toContainText("нет контракта публичного результата");
  await expect(page).toHaveURL(/peekView=result/);
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
});

test("E2E-PKD-07 E2E-PKD-12: two visible HTTP/1.1 workbenches keep independent streams and GET progress", async ({
  page,
  context,
}) => {
  await context.addInitScript(() => {
    const Original = window.EventSource;
    const sources: EventSource[] = [];

    (window as typeof window & { peekSources: EventSource[] }).peekSources =
      sources;
    window.EventSource = class extends Original {
      constructor(url: string | URL, init?: EventSourceInit) {
        super(url, init);
        sources.push(this);
      }
    };
  });
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto(`/runs/${fixture.anchor}?peek=${fixture.child}`);
  const other = await context.newPage();

  await other.setViewportSize({ width: 1600, height: 1000 });
  try {
    await other.goto(`/runs/${fixture.anchor}?peek=${fixture.sibling}`);
    await expect(peek(page)).toContainText("Conversation of Researcher Alpha");
    await expect(peek(other)).toContainText("Conversation of Researcher Beta");
    expect(await page.evaluate(() => document.visibilityState)).toBe("visible");
    expect(await other.evaluate(() => document.visibilityState)).toBe(
      "visible",
    );
    for (const tab of [page, other]) {
      const urls = await tab.evaluate(() =>
        (window as typeof window & { peekSources: EventSource[] }).peekSources
          .filter((source) => source.readyState !== EventSource.CLOSED)
          .map((source) => source.url),
      );

      expect(urls.filter((url) => url.includes("/peek/stream"))).toHaveLength(
        1,
      );
      expect(urls.some((url) => /\/runs\/[^/]+\/stream/.test(url))).toBe(false);
      expect(urls.some((url) => url.includes("/librarian/stream"))).toBe(false);
      expect(urls.length).toBeLessThanOrEqual(2);
    }
    for (const tab of [page, other]) {
      await expect
        .poll(() =>
          tab.evaluate(() =>
            (
              window as typeof window & { peekSources: EventSource[] }
            ).peekSources.some(
              (source) =>
                source.url.includes("/peek/stream") &&
                source.readyState === EventSource.OPEN,
            ),
          ),
        )
        .toBe(true);
    }
    await withE2EDb((pool) =>
      pool.query(
        "INSERT INTO run_messages(id,run_id,sequence,role,content) VALUES($1,$2,2,'assistant','Independent Alpha update'),($3,$4,2,'assistant','Independent Beta update')",
        [randomUUID(), fixture.child, randomUUID(), fixture.sibling],
      ),
    );
    await expect(peek(page)).toContainText("Independent Alpha update");
    await expect(peek(page)).not.toContainText("Independent Beta update");
    await expect(peek(other)).toContainText("Independent Beta update");
    const reads = await Promise.all(
      [page, other].map((tab) =>
        tab.request.get(`/api/runs/${fixture.anchor}/children`),
      ),
    );

    expect(reads.every((response) => response.ok())).toBe(true);
    for (let sequence = 3; sequence <= 6; sequence++) {
      await withE2EDb((pool) =>
        pool.query(
          "INSERT INTO run_messages(id,run_id,sequence,role,content) VALUES($1,$2,$3,'assistant',$4),($5,$6,$3,'assistant',$7)",
          [
            randomUUID(),
            fixture.child,
            sequence,
            `Sustained Alpha ${sequence}`,
            randomUUID(),
            fixture.sibling,
            `Sustained Beta ${sequence}`,
          ],
        ),
      );
      const progress = await Promise.all(
        [page, other].map((tab) =>
          tab.request.get(`/api/runs/${fixture.anchor}/children`),
        ),
      );

      expect(progress.every((response) => response.ok())).toBe(true);
      await expect(peek(page)).toContainText(`Sustained Alpha ${sequence}`);
      await expect(peek(other)).toContainText(`Sustained Beta ${sequence}`);
    }

    await peek(page)
      .locator(`[data-child-run-id="${fixture.sibling}"] a`)
      .click();
    await expect(peek(page)).toContainText("Independent Beta update");
    await peek(page).getByRole("button", { name: "Close peek" }).click();
    await page.getByTestId("librarian-trigger").click();
    await expect(page.getByTestId("librarian-panel")).toBeVisible();
    expect(
      (
        await other.request.get(
          `/api/runs/${fixture.anchor}/peek?selected=${fixture.sibling}`,
        )
      ).ok(),
    ).toBe(true);
  } finally {
    await other.close();
  }
});

test("E2E-PKD-07 E2E-PKD-09: child-list requests retire on switch and close while shared parent reads stay owned", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await trackFetchSignals(page);
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let holdChild = true;

  await page.route("**/children?*", async (route) => {
    const parent = new URL(route.request().url()).searchParams.get("parent");

    if (parent === fixture.anchor || (parent === fixture.child && holdChild)) {
      await held;
      await route.abort();

      return;
    }
    await route.continue();
  });
  const signals = (parent: string): Promise<boolean[]> =>
    page.evaluate((id) => {
      const state = window as typeof window & {
        peekRequestSignals: { url: string; signal?: AbortSignal | null }[];
      };

      return state.peekRequestSignals
        .filter(
          (item) =>
            new URL(item.url, location.href).searchParams.get("parent") === id,
        )
        .map((item) => item.signal?.aborted ?? false);
    }, parent);

  try {
    await page.goto(`/runs/${fixture.anchor}?peek=${fixture.child}`);
    await expect(peek(page)).toContainText("Conversation of Researcher Alpha");
    await expect
      .poll(async () => (await signals(fixture.child)).at(-1))
      .toBe(false);
    await peek(page)
      .getByRole("region", { name: "Siblings" })
      .getByRole("link", { name: /Researcher Beta/ })
      .click();
    await expect(peek(page)).toContainText("Conversation of Researcher Beta");
    await expect
      .poll(async () =>
        (await signals(fixture.child)).every((aborted) => aborted),
      )
      .toBe(true);
    await expect
      .poll(async () => (await signals(fixture.anchor)).at(-1))
      .toBe(false);
    holdChild = false;
    await peek(page)
      .getByRole("region", { name: "Siblings" })
      .getByRole("link", { name: /Researcher Alpha/ })
      .click();
    await expect(
      peek(page).getByRole("region", { name: "Children" }),
    ).toContainText("Analyst Gamma");
    const completedRequests = (await signals(fixture.child)).length;

    await peek(page)
      .getByRole("region", { name: "Siblings" })
      .getByRole("link", { name: /Researcher Beta/ })
      .click();
    await expect(peek(page)).toContainText("Conversation of Researcher Beta");
    holdChild = true;
    await peek(page)
      .getByRole("region", { name: "Siblings" })
      .getByRole("link", { name: /Researcher Alpha/ })
      .click();
    await expect
      .poll(async () => (await signals(fixture.child)).length)
      .toBeGreaterThan(completedRequests);
    await expect
      .poll(async () => (await signals(fixture.child)).at(-1))
      .toBe(false);
    await peek(page)
      .getByRole("button", { name: "Close peek", exact: true })
      .click();
    await expect(peek(page)).toHaveCount(0);
    await expect
      .poll(async () => (await signals(fixture.child)).at(-1))
      .toBe(true);
    await expect
      .poll(async () => (await signals(fixture.anchor)).at(-1))
      .toBe(false);
  } finally {
    release();
  }
});

test("E2E-PKD-07: late A responses cannot overwrite B or a newer A selection", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let intercepted = false;

  await page.route(`**/api/runs/${fixture.anchor}/peek?*`, async (route) => {
    if (
      new URL(route.request().url()).searchParams.get("selected") !==
        fixture.child ||
      intercepted
    ) {
      await route.continue();

      return;
    }
    intercepted = true;
    const response = await route.fetch();

    await held;
    await route.fulfill({ response });
  });
  try {
    await page.goto(`/runs/${fixture.anchor}`);
    const list = page.getByTestId("run-inspector-child-runs");

    await list.locator(`[data-child-run-id="${fixture.child}"] a`).click();
    await expect.poll(() => intercepted).toBe(true);
    await page.keyboard.press("Escape");
    await expect(peek(page)).toHaveCount(0);
    await list.locator(`[data-child-run-id="${fixture.sibling}"] a`).click();
    await expect(peek(page)).toContainText("Conversation of Researcher Beta");
    await withE2EDb((pool) =>
      pool.query("UPDATE runs SET status='Done' WHERE id=$1", [fixture.child]),
    );
    await peek(page)
      .locator(`[data-child-run-id="${fixture.child}"] a`)
      .click();
    await expect(peek(page)).toContainText("Done");
    release();
    await expect(peek(page)).toHaveAttribute(
      "data-selected-run",
      fixture.child,
    );
    await expect(peek(page)).toContainText("Done");
  } finally {
    release();
  }
});

test("E2E-PKN-06 E2E-PKN-07: full Run links and browser Back preserve a deep peek", async ({
  page,
}) => {
  await page.goto(
    `/runs/${fixture.anchor}?wb=files&file=README.md&peek=${fixture.grandchild}`,
  );
  await expect(peek(page)).toContainText("Analyst Gamma");
  await peek(page).getByRole("link", { name: "Open full Run" }).click();
  await expect(page).toHaveURL(new RegExp(`/runs/${fixture.grandchild}$`));
  await page.goBack();
  await expect(peek(page)).toHaveAttribute(
    "data-selected-run",
    fixture.grandchild,
  );
  await expect(page).toHaveURL(/file=README.md/);
  const opened = page.context().waitForEvent("page");

  await peek(page)
    .getByRole("link", { name: "Open full Run" })
    .click({ modifiers: ["Shift"] });
  const full = await opened;

  try {
    await expect(full).toHaveURL(new RegExp(`/runs/${fixture.grandchild}$`));
    await expect(peek(page)).toHaveAttribute(
      "data-selected-run",
      fixture.grandchild,
    );
  } finally {
    await full.close();
  }
});

test("E2E-PKN-12: transport failure and explicit reconnect retain selection and recover missed conversation", async ({
  page,
}) => {
  await page.route("**/peek/stream*", (route) => route.abort());
  await page.goto(`/runs/${fixture.anchor}?peek=${fixture.child}`);
  await expect(peek(page)).toContainText("Conversation of Researcher Alpha");
  await expect(peek(page)).toContainText("Live updates are disconnected");
  await withE2EDb((pool) =>
    pool.query(
      "INSERT INTO run_messages(id,run_id,sequence,role,content) VALUES($1,$2,2,'assistant','Recovered while disconnected')",
      [randomUUID(), fixture.child],
    ),
  );
  await page.unroute("**/peek/stream*");
  await peek(page).getByRole("button", { name: "Retry", exact: true }).click();
  await expect(peek(page)).toContainText("Recovered while disconnected");
  await expect(peek(page)).toHaveAttribute("data-selected-run", fixture.child);
});

test("E2E-PKN-01 E2E-PKN-07 E2E-PKN-09: nested main anchors and parent fullscreen keep one anchored panel", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto(`/runs/${fixture.child}?peek=${fixture.grandchild}`);
  await expect(peek(page)).toContainText("Conversation of Analyst Gamma");
  await expect(page).toHaveURL(new RegExp(`/runs/${fixture.child}\\?`));
  await page.goto(
    `/runs/${fixture.anchor}?flow=fullscreen&peek=${fixture.child}`,
  );
  await expect(peek(page)).toHaveAttribute("aria-modal", "true");
  await expect(peek(page)).toContainText("Conversation of Researcher Alpha");
  await peek(page).getByRole("button", { name: "Close peek" }).click();
  await expect(page).toHaveURL(/flow=fullscreen/);
});

test("E2E-PKN-04 E2E-PKN-10: an unsent parent HITL draft survives child navigation and missing-trigger closure", async ({
  page,
}) => {
  const all = JSON.parse(
    readFileSync(path.resolve("e2e/.auth/fixtures.json"), "utf8"),
  ) as { runId: string };
  const child = randomUUID();

  await withE2EDb((pool) =>
    pool.query(
      "INSERT INTO runs(id,project_id,run_kind,status,flow_version,flow_revision,parent_run_id,root_run_id,agent_workspace) SELECT $1,project_id,'agent','Done','v1','peek',$2,$2,'none' FROM runs WHERE id=$2",
      [child, all.runId],
    ),
  );
  try {
    await page.setViewportSize({ width: 1600, height: 1000 });
    await page.goto(`/runs/${all.runId}`);
    const draft = page.getByRole("textbox", {
      name: "Review comments",
      exact: true,
    });

    await expect(draft).toBeVisible();
    await draft.fill("Unsent parent instruction");
    const trigger = page
      .getByTestId("run-inspector-child-runs")
      .locator(`[data-child-run-id="${child}"] a`);

    await trigger.click();
    await expect(peek(page)).toHaveAttribute("data-selected-run", child);
    await expect(draft).toHaveValue("Unsent parent instruction");
    await withE2EDb((pool) =>
      pool.query("DELETE FROM runs WHERE id=$1", [child]),
    );
    await expect(peek(page)).toContainText("This Run is unavailable");
    await expect(trigger).toHaveCount(0);
    await peek(page).getByRole("button", { name: "Close peek" }).click();
    await expect(page.locator('[data-testid="run-shell"] h1')).toBeFocused();
    await expect(draft).toHaveValue("Unsent parent instruction");
  } finally {
    await withE2EDb((pool) =>
      pool.query("DELETE FROM runs WHERE id=$1", [child]),
    );
  }
});

test("E2E-PKD-07: nested history preserves scroll, bounds retained pages and downloads oversized tools", async ({
  page,
}) => {
  const tool = {
    v: 1,
    kind: "tool",
    name: "Read",
    toolKind: "read",
    status: "completed",
    arg: "oversized.txt",
    rawInput: { file_path: "oversized.txt" },
    result: "界".repeat(200_000),
  };

  await withE2EDb(async (pool) => {
    await pool.query(
      "UPDATE run_messages SET created_at='2026-01-01T00:00:00.000123Z' WHERE run_id=$1",
      [fixture.child],
    );
    await pool.query(
      "INSERT INTO run_messages(id,run_id,sequence,role,content,created_at) SELECT gen_random_uuid()::text,$1,n,'assistant','History ' || n::text,'2026-01-01T00:00:00.000123Z' FROM generate_series(2,650)n",
      [fixture.child],
    );
    await pool.query(
      "UPDATE run_messages SET role='tool',content=$1 WHERE run_id=$2 AND sequence=650",
      [JSON.stringify(tool), fixture.child],
    );
  });
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto(`/runs/${fixture.anchor}?peek=${fixture.child}`);
  const transcript = peek(page).getByTestId("run-transcript-history");
  const scroller = peek(page).getByTestId("run-peek-scroll");
  const messages = transcript.getByText(/^History \d+$/);

  const toolButton = transcript.getByRole("button", {
    name: /Read.*oversized.txt/,
  });

  await expect(toolButton).toBeInViewport();
  await toolButton.click();
  await expect(transcript.getByTestId("peek-bounded-preview")).toBeVisible();
  await expect(messages).toHaveCount(99);
  const full = transcript.getByRole("link", {
    name: "Download complete content",
    exact: true,
  });
  const downloading = page.waitForEvent("download");

  await full.click();
  const download = await downloading;
  const content = await download.createReadStream();
  const chunks: Buffer[] = [];

  for await (const chunk of content) chunks.push(Buffer.from(chunk));
  expect(Buffer.concat(chunks).toString("utf8")).toBe(JSON.stringify(tool));
  const parentScroll = await page.evaluate(() => window.scrollY);
  const initialReading = transcript.getByText("History 551", { exact: true });

  await scrollWithinPeek(initialReading, 0);
  const initialTop = (await initialReading.boundingBox())!.y;

  await expect(messages).toHaveCount(199);
  await expect
    .poll(async () =>
      Math.abs((await initialReading.boundingBox())!.y - initialTop),
    )
    .toBeLessThan(2);
  expect(await page.evaluate(() => window.scrollY)).toBe(parentScroll);
  const readingText = transcript.getByText("History 500", { exact: true });

  await scrollWithinPeek(readingText, 0);
  const readingId = await readingText.evaluate((element) =>
    element
      .closest("[data-transcript-message-id]")
      ?.getAttribute("data-transcript-message-id"),
  );

  if (!readingId) throw new Error("Reading message has no transcript anchor");
  const reading = transcript.locator(
    `[data-transcript-message-id="${readingId}"]`,
  );
  const readingTop = (await reading.boundingBox())!.y;

  await withE2EDb((pool) =>
    pool.query(
      "UPDATE run_messages SET content=$1 WHERE run_id=$2 AND sequence=500",
      ["Expanded earlier detail\n".repeat(50), fixture.child],
    ),
  );
  await expect(transcript).toContainText("Expanded earlier detail");
  await expect
    .poll(async () => Math.abs((await reading.boundingBox())!.y - readingTop))
    .toBeLessThan(2);
  await withE2EDb((pool) =>
    pool.query(
      "INSERT INTO run_messages(id,run_id,sequence,role,content,created_at) SELECT gen_random_uuid()::text,$1,n,'assistant','History ' || n::text,'2026-01-01T00:00:00.000123Z' FROM generate_series(651,850)n",
      [fixture.child],
    ),
  );
  await expect(transcript).toContainText("Newer messages are available");
  await expect(
    transcript.getByTestId("transcript-jump-latest"),
  ).toHaveAttribute("data-new-messages", "true");
  await expect
    .poll(async () => Math.abs((await reading.boundingBox())!.y - readingTop))
    .toBeLessThan(2);
  await expect(
    transcript.getByText("History 850", { exact: true }),
  ).toHaveCount(1);
  // Read progressively toward the beginning so the opposite end can be evicted.
  for (let boundary = 451; boundary >= 151; boundary -= 100) {
    const first = transcript.locator("[data-transcript-message-id]").first();

    await scrollWithinPeek(first, 0);
    await expect(
      transcript.getByText(`History ${boundary - 100}`, { exact: true }),
    ).toHaveCount(1);
    expect(
      await transcript.locator("[data-transcript-message-id]").count(),
    ).toBeLessThanOrEqual(500);
  }
  await expect(
    transcript.getByRole("button", { name: "Load later messages" }),
  ).toHaveCount(1);
  const oldestReading = transcript.getByText("History 100", { exact: true });

  await scrollWithinPeek(oldestReading, 0.5);
  const oldestTop = (await oldestReading.boundingBox())!.y;

  await transcript
    .getByRole("button", { name: "Load earlier messages" })
    .evaluate((element: HTMLButtonElement) => element.click());
  await expect(
    transcript.getByText("Conversation of Researcher Alpha", { exact: true }),
  ).toHaveCount(1);
  await expect(
    transcript.getByRole("button", { name: "Load earlier messages" }),
  ).toHaveCount(0);
  await expect
    .poll(async () =>
      Math.abs((await oldestReading.boundingBox())!.y - oldestTop),
    )
    .toBeLessThan(2);
  await scrollWithinPeek(
    transcript.getByText("History 450", { exact: true }),
    0.5,
  );
  await expect(
    transcript.getByText("History 550", { exact: true }),
  ).toHaveCount(1);
  await transcript
    .getByRole("button", { name: "Load later messages" })
    .evaluate((element: HTMLButtonElement) => element.click());
  await expect(
    transcript.getByText("History 649", { exact: true }),
  ).toHaveCount(1);
  expect(
    await transcript.locator("[data-transcript-message-id]").count(),
  ).toBeLessThanOrEqual(500);
  await transcript
    .getByRole("button", { name: "Jump to latest", exact: true })
    .click();
  await expect(messages).toHaveCount(100);
  await expect(
    transcript.getByText("History 850", { exact: true }),
  ).toBeInViewport();
  await expect
    .poll(() =>
      scroller.evaluate((element) => {
        const tail = element.querySelector('[data-testid="transcript-tail"]');

        if (!tail) throw new Error("Transcript tail is missing");

        return Math.abs(
          tail.getBoundingClientRect().bottom -
            Math.min(
              element.getBoundingClientRect().bottom,
              window.innerHeight,
            ),
        );
      }),
    )
    .toBeLessThan(10);
  await withE2EDb((pool) =>
    pool.query(
      "INSERT INTO run_messages(id,run_id,sequence,role,content,created_at) VALUES($1,$2,851,'assistant','History 851','2026-01-01T00:00:00.000123Z')",
      [randomUUID(), fixture.child],
    ),
  );
  await expect(
    transcript.getByText("History 851", { exact: true }),
  ).toBeInViewport();
});

test("E2E-PKD-07: delayed history cannot override Latest messages or a newer Flow attempt", async ({
  page,
}) => {
  const flow = randomUUID();
  const firstAttempt = randomUUID();
  const secondAttempt = randomUUID();

  await withE2EDb(async (pool) => {
    await pool.query(
      "INSERT INTO flows(id,project_id,flow_ref_id,source,version,installed_path,manifest,schema_version) SELECT $1,project_id,'peek-attempt','test','v1','/tmp/peek-attempt',$2,1 FROM runs WHERE id=$3",
      [
        flow,
        {
          schemaVersion: 1,
          name: "peek-attempt",
          nodes: [
            {
              id: "work",
              type: "ai_coding",
              action: { prompt: "Work" },
              transitions: { success: "done" },
            },
          ],
        },
        fixture.anchor,
      ],
    );
    await pool.query("UPDATE runs SET run_kind='flow',flow_id=$1 WHERE id=$2", [
      flow,
      fixture.child,
    ]);
    await pool.query(
      "INSERT INTO node_attempts(id,run_id,node_id,node_type,attempt,status) VALUES($1,$2,'work','ai_coding',1,'Running')",
      [firstAttempt, fixture.child],
    );
    await pool.query(
      "INSERT INTO run_messages(id,run_id,node_attempt_id,sequence,role,content,supervisor_event_id) SELECT gen_random_uuid()::text,$1,$2,n,'assistant','Prior attempt ' || n::text,n::text FROM generate_series(1,220)n",
      [fixture.child, firstAttempt],
    );
  });
  await trackFetchSignals(page);
  let release: () => void = () => {};
  let captured: () => void = () => {};
  let delivered: () => void = () => {};
  let hold = false;
  let held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let ready = new Promise<void>((resolve) => {
    captured = resolve;
  });
  let done = new Promise<void>((resolve) => {
    delivered = resolve;
  });

  await page.route(
    `**/api/runs/${fixture.child}/transcript?*`,
    async (route) => {
      if (!hold || !new URL(route.request().url()).searchParams.has("before")) {
        await route.continue();

        return;
      }
      const response = await route.fetch();

      captured();
      await held;
      await route.fulfill({ response });
      delivered();
    },
  );
  try {
    await page.goto(
      `/runs/${fixture.anchor}?peek=${fixture.child}&peekView=conversation&peekNode=work`,
    );
    await expect(
      peek(page).getByText("Prior attempt 220", { exact: true }),
    ).toHaveCount(1);
    await peek(page)
      .getByRole("button", { name: "Load earlier messages" })
      .evaluate((element: HTMLButtonElement) => element.click());
    await expect(
      peek(page).getByText("Prior attempt 21", { exact: true }),
    ).toHaveCount(1);
    hold = true;
    await peek(page)
      .getByRole("button", { name: "Load earlier messages" })
      .evaluate((element: HTMLButtonElement) => element.click());
    await ready;
    await peek(page).getByRole("button", { name: "Jump to latest" }).click();
    const lastEarlierAborted = (): Promise<boolean> =>
      page.evaluate((id) => {
        const state = window as typeof window & {
          peekRequestSignals: { url: string; signal: AbortSignal }[];
        };

        return (
          state.peekRequestSignals
            .filter((item) =>
              item.url.startsWith(`/api/runs/${id}/transcript?before=`),
            )
            .at(-1)?.signal.aborted ?? false
        );
      }, fixture.child);

    await expect.poll(lastEarlierAborted).toBe(true);
    release();
    await done;
    await expect(
      peek(page).getByText("Prior attempt 21", { exact: true }),
    ).toHaveCount(0);
    held = new Promise<void>((resolve) => {
      release = resolve;
    });
    ready = new Promise<void>((resolve) => {
      captured = resolve;
    });
    done = new Promise<void>((resolve) => {
      delivered = resolve;
    });
    await peek(page)
      .getByRole("button", { name: "Load earlier messages" })
      .evaluate((element: HTMLButtonElement) => element.click());
    await ready;
    await withE2EDb(async (pool) => {
      await pool.query(
        "UPDATE node_attempts SET status='Succeeded',ended_at=now() WHERE id=$1",
        [firstAttempt],
      );
      await pool.query(
        "INSERT INTO node_attempts(id,run_id,node_id,node_type,attempt,status) VALUES($1,$2,'work','ai_coding',2,'Running')",
        [secondAttempt, fixture.child],
      );
      await pool.query(
        "INSERT INTO run_messages(id,run_id,node_attempt_id,sequence,role,content,supervisor_event_id) VALUES($1,$2,$3,1,'assistant','Current attempt only','221')",
        [randomUUID(), fixture.child, secondAttempt],
      );
    });
    await expect(peek(page)).toContainText("Current attempt only");
    await expect(peek(page)).toContainText("The node attempt changed");
    await expect.poll(lastEarlierAborted).toBe(true);
    release();
    await done;
    await expect(peek(page).getByText(/^Prior attempt \d+$/)).toHaveCount(0);
    await expect(
      peek(page).getByText("Current attempt only", { exact: true }),
    ).toHaveCount(1);
  } finally {
    release();
    await page.unrouteAll({ behavior: "wait" });
    await withE2EDb(async (pool) => {
      await pool.query(
        "UPDATE runs SET flow_id=NULL,run_kind='agent' WHERE id=$1",
        [fixture.child],
      );
      await pool.query("DELETE FROM flows WHERE id=$1", [flow]);
    });
  }
});

test("E2E-PKN-02 E2E-PKN-12: result-only publication keeps the selected completed Run and valid payload", async ({
  page,
}) => {
  const contract = {
    kind: "agent_profile",
    profileName: "research",
    schemaRef: "fixture@abcdef123456:research-result.v1",
    schemaVersion: 1,
    sha256: "a".repeat(64),
    required: true,
    schema: {
      schemaVersion: 1,
      fields: [{ name: "summary", type: "string", required: true }],
    },
    sourceFlowRevisionId: "peek",
  };

  await withE2EDb((pool) =>
    pool.query("UPDATE runs SET status='Done',result_contract=$1 WHERE id=$2", [
      contract,
      fixture.child,
    ]),
  );
  await page.goto(
    `/runs/${fixture.anchor}?peek=${fixture.child}&peekView=result`,
  );
  await expect(peek(page).getByTestId("run-public-result")).toHaveAttribute(
    "data-result-status",
    "missing",
  );
  await withE2EDb((pool) =>
    pool.query(
      "INSERT INTO run_results(id,run_id,revision,validity,schema_ref,schema_version,schema_sha256,value,value_bytes,producer_kind,producer_ref,engine_version) VALUES($1,$2,1,'valid',$3,1,$4,'{\"summary\":\"Published after completion\"}',40,'agent_session','default','3.10.0')",
      [randomUUID(), fixture.child, contract.schemaRef, contract.sha256],
    ),
  );
  await expect(peek(page).getByTestId("run-public-result")).toHaveAttribute(
    "data-result-status",
    "valid",
  );
  await peek(page).getByText("Value", { exact: true }).click();
  await expect(peek(page)).toContainText("Published after completion");
  await expect(peek(page)).toHaveAttribute("data-selected-run", fixture.child);
  await expect(
    peek(page).getByRole("button", { name: /promote|collect|review/i }),
  ).toHaveCount(0);
});

test("E2E-PKN-12 E2E-PKD-07: malformed child URLs do not disconnect the readable main Run", async ({
  page,
}) => {
  await page.goto(`/runs/${fixture.anchor}?peek=invalid`);
  await expect(peek(page)).toContainText("This Run is unavailable");
  try {
    await withE2EDb((pool) =>
      pool.query("UPDATE runs SET status='Review' WHERE id=$1", [
        fixture.anchor,
      ]),
    );
    await expect(page.getByTestId("run-header-status")).toContainText("Review");
    await expect(peek(page)).toHaveAttribute("data-selected-run", "invalid");
  } finally {
    await withE2EDb((pool) =>
      pool.query("UPDATE runs SET status='Running' WHERE id=$1", [
        fixture.anchor,
      ]),
    );
  }
});

test("E2E-PKD-07 E2E-PKN-12: post-completion parent publication refreshes independently of the child", async ({
  page,
}) => {
  const contract = {
    kind: "flow_export",
    schemaRef: "fixture@abcdef123456:research-result.v1",
    schemaVersion: 1,
    sha256: "a".repeat(64),
    required: true,
    producerNodeIds: ["implement"],
    schema: {
      schemaVersion: 1,
      fields: [{ name: "summary", type: "string", required: true }],
    },
    flowRevisionId: "peek",
  } satisfies RunResultContract;

  await withE2EDb((pool) =>
    pool.query("UPDATE runs SET status='Done',result_contract=$1 WHERE id=$2", [
      contract,
      fixture.anchor,
    ]),
  );
  try {
    await page.goto(`/runs/${fixture.anchor}?peek=${fixture.child}`);
    await expect(peek(page)).toContainText("Conversation of Researcher Alpha");
    const result = page
      .locator('[data-testid="run-shell"]:visible')
      .getByTestId("run-shell-inspector")
      .getByTestId("run-public-result");

    await expect(result).toHaveAttribute("data-result-status", "missing");
    await withE2EDb((pool) =>
      pool.query(
        "INSERT INTO run_results(id,run_id,revision,validity,schema_ref,schema_version,schema_sha256,value,value_bytes,producer_kind,producer_ref,engine_version) VALUES($1,$2,1,'valid',$3,1,$4,'{\"summary\":\"Parent published later\"}',40,'flow_node','implement','3.10.0')",
        [randomUUID(), fixture.anchor, contract.schemaRef, contract.sha256],
      ),
    );
    await expect(result).toHaveAttribute("data-result-status", "valid");
    await expect(peek(page)).toHaveAttribute(
      "data-selected-run",
      fixture.child,
    );
  } finally {
    await withE2EDb(async (pool) => {
      await pool.query("DELETE FROM run_results WHERE run_id=$1", [
        fixture.anchor,
      ]);
      await pool.query(
        "UPDATE runs SET status='Running',result_contract=NULL WHERE id=$1",
        [fixture.anchor],
      );
    });
  }
});

test("E2E-PKN-03 E2E-PKN-07: Previous restores two prior visits and their views without oscillation after browser history", async ({
  page,
}) => {
  await withE2EDb((pool) =>
    pool.query("UPDATE runs SET parent_run_id=$1 WHERE id=$2", [
      fixture.child,
      fixture.sibling,
    ]),
  );
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto(`/runs/${fixture.anchor}?peek=${fixture.child}`);
  await peek(page).getByRole("tab", { name: "Execution", exact: true }).click();
  await peek(page)
    .getByRole("link", { name: /Analyst Gamma/ })
    .click();
  await peek(page)
    .getByRole("tab", { name: "Public result", exact: true })
    .click();
  await peek(page)
    .locator(`[data-child-run-id="${fixture.sibling}"] a`)
    .click();
  await expect(peek(page)).toHaveAttribute(
    "data-selected-run",
    fixture.sibling,
  );
  await peek(page).getByRole("button", { name: "Previous selection" }).click();
  await expect(peek(page)).toHaveAttribute(
    "data-selected-run",
    fixture.grandchild,
  );
  await expect(
    peek(page).getByRole("tab", { name: "Public result", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await peek(page).getByRole("button", { name: "Previous selection" }).click();
  await expect(peek(page)).toHaveAttribute("data-selected-run", fixture.child);
  await expect(
    peek(page).getByRole("tab", { name: "Execution", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(
    peek(page).getByRole("button", { name: "Previous selection" }),
  ).toBeDisabled();
  await page.goBack();
  await expect(peek(page)).toHaveAttribute(
    "data-selected-run",
    fixture.grandchild,
  );
  await peek(page).getByRole("button", { name: "Previous selection" }).click();
  await expect(peek(page)).toHaveAttribute("data-selected-run", fixture.child);
  await expect(
    peek(page).getByRole("button", { name: "Previous selection" }),
  ).toBeDisabled();
});

test("E2E-PKN-09 E2E-PKN-10: modal background is inert and handled inner Escape preserves the selected Flow node", async ({
  page,
}) => {
  const flow = randomUUID();

  await withE2EDb(async (pool) => {
    await pool.query(
      "INSERT INTO flows(id,project_id,flow_ref_id,source,version,installed_path,manifest,schema_version) SELECT $1,project_id,'peek-browser','test','v1','/tmp/peek-browser',$2,1 FROM runs WHERE id=$3",
      [
        flow,
        {
          schemaVersion: 1,
          name: "peek-browser",
          nodes: [
            {
              id: "work",
              type: "ai_coding",
              action: { prompt: "Work" },
              transitions: { success: "done" },
            },
            {
              id: "other",
              type: "ai_coding",
              action: { prompt: "Other" },
              transitions: { success: "done" },
            },
          ],
        },
        fixture.anchor,
      ],
    );
    await pool.query("UPDATE runs SET run_kind='flow',flow_id=$1 WHERE id=$2", [
      flow,
      fixture.child,
    ]);
  });
  try {
    await page.setViewportSize({ width: 1024, height: 900 });
    await page.goto(
      `/runs/${fixture.anchor}?peek=${fixture.child}&peekView=execution&peekNode=other`,
    );
    const picker = peek(page).getByRole("combobox", { name: "Node" });

    await expect(picker).toHaveValue("other");
    const main = await peek(page)
      .locator("..")
      .locator(':scope > [data-testid="run-shell-main"]')
      .elementHandle();

    expect(main).not.toBeNull();
    expect(
      await main!.evaluate((element) => !!element.closest("[inert]")),
    ).toBe(true);
    await expect(peek(page)).toContainText(
      "No conversation has been recorded.",
    );
    await picker.selectOption("work");
    await expect(page).toHaveURL(/peekNode=work/);
    await picker.focus();
    await page.setViewportSize({ width: 1600, height: 1000 });
    await expect(peek(page)).toHaveAttribute("data-modal", "false");
    await expect(picker).toBeFocused();
    await expect(picker).toHaveValue("work");
    await page.setViewportSize({ width: 1024, height: 900 });
    await expect(peek(page)).toHaveAttribute("aria-modal", "true");
    await picker.evaluate((element) =>
      element.addEventListener(
        "keydown",
        (event) => {
          if (event instanceof KeyboardEvent && event.key === "Escape")
            event.preventDefault();
        },
        { once: true },
      ),
    );
    await picker.press("Escape");
    await expect(peek(page)).toBeVisible();
    await picker.press("Escape");
    await expect(peek(page)).toHaveCount(0);
    expect(await main!.evaluate((element) => element.isConnected)).toBe(true);
    expect(
      await main!.evaluate((element) => !!element.closest("[inert]")),
    ).toBe(false);
  } finally {
    await withE2EDb(async (pool) => {
      await pool.query(
        "UPDATE runs SET flow_id=NULL,run_kind='agent' WHERE id=$1",
        [fixture.child],
      );
      await pool.query("DELETE FROM flows WHERE id=$1", [flow]);
    });
  }
});

test("E2E-PKN-02 E2E-PKN-06: viewer keeps metadata and public-result state with an explicitly forbidden conversation", async ({
  browser,
}) => {
  const all = JSON.parse(
    readFileSync(path.resolve("e2e/.auth/fixtures.json"), "utf8"),
  ) as { byKey: { m22: { viewerEmail: string; viewerPassword: string } } };
  const context = await browser.newContext({
    storageState: { cookies: [], origins: [] },
  });
  const page = await context.newPage();

  try {
    await page.goto("/login");
    await page.locator('input[name="email"]').fill(all.byKey.m22.viewerEmail);
    await page
      .locator('input[name="password"]')
      .fill(all.byKey.m22.viewerPassword);
    await page.locator('form button[type="submit"]').click();
    await page.waitForURL((url) => !url.pathname.startsWith("/login"));
    await page.goto(`/runs/${fixture.anchor}?peek=${fixture.child}`);
    await expect(peek(page)).toContainText("Researcher Alpha");
    await expect(peek(page)).toContainText(
      "You do not have permission to read this content.",
    );
    await expect(peek(page)).not.toContainText(
      "Conversation of Researcher Alpha",
    );
    await expect(
      peek(page).getByRole("link", { name: "Open full Run" }),
    ).toHaveAttribute("href", `/runs/${fixture.child}`);
    await peek(page)
      .getByRole("tab", { name: "Public result", exact: true })
      .click();
    await expect(peek(page)).toContainText(
      "no public-result contract or recorded result",
    );
  } finally {
    await context.close();
  }
});

test("E2E-PKN-02 E2E-PKD-07: paged siblings pin an off-page selection and discover a new descendant without eager transcripts", async ({
  page,
}) => {
  const ids = Array.from({ length: 60 }, () => randomUUID());
  const descendant = randomUUID();
  const newSibling = randomUUID();

  await withE2EDb(async (pool) => {
    for (const [index, id] of ids.entries())
      await pool.query(
        "INSERT INTO runs(id,project_id,run_kind,status,flow_version,flow_revision,parent_run_id,root_run_id,agent_workspace,delegation_snapshot,launched_at) SELECT $1,project_id,'agent','Failed','v1','peek',$2,$2,'none',$3,$4 FROM runs WHERE id=$2",
        [
          id,
          fixture.anchor,
          { kind: "runner", runnerId: `Paged researcher ${index}` },
          index < 35 ? new Date(1700000000000 + index) : null,
        ],
      );
  });
  await withE2EDb((pool) =>
    pool.query(
      "INSERT INTO domain_events(kind,project_id,run_id,payload,occurred_at) SELECT 'run.failed',project_id,id,$2,now() FROM runs WHERE id=$1",
      [
        ids[34],
        {
          cause: {
            code: "BUDGET_EXCEEDED",
            reason: "budget_breach",
            source: "sweeper",
          },
        },
      ],
    ),
  );
  const transcripts: string[] = [];

  page.on("request", (request) => {
    if (request.url().includes("/transcript?"))
      transcripts.push(new URL(request.url()).pathname);
  });
  try {
    const selected = ids[34];

    await page.setViewportSize({ width: 1600, height: 1000 });
    await page.goto(`/runs/${fixture.anchor}?peek=${selected}`);
    await expect(peek(page).getByRole("heading", { level: 2 })).toContainText(
      "Paged researcher 34",
    );
    await expect(peek(page).getByTestId("terminal-cause-notice")).toContainText(
      /budget/i,
    );
    const siblings = peek(page).getByRole("region", { name: "Siblings" });
    const pagination = siblings.getByRole("navigation", {
      name: "Child Run pages",
    });

    await expect(pagination.getByRole("button")).toHaveCount(3);
    await expect(pagination).toHaveText("");
    await expect(pagination.locator("svg")).toHaveCount(3);
    await expect(siblings.locator("[data-child-run-id]")).toHaveCount(25);
    await expect(
      siblings.locator(`[data-child-run-id="${selected}"]`),
    ).toHaveCount(0);
    await siblings
      .getByRole("button", { name: "Next page", exact: true })
      .click();
    await expect(
      siblings.locator(`[data-child-run-id="${selected}"]`),
    ).toContainText("Failed");
    await siblings
      .getByRole("button", { name: "Next page", exact: true })
      .click();
    await expect(
      siblings.getByRole("button", { name: "Next page", exact: true }),
    ).toBeDisabled();
    await withE2EDb((pool) =>
      pool.query(
        "INSERT INTO runs(id,project_id,run_kind,status,flow_version,flow_revision,parent_run_id,root_run_id,agent_workspace,delegation_snapshot,launched_at) SELECT $1,project_id,'agent','Running','v1','peek',$2,$2,'none',$3,now() FROM runs WHERE id=$2",
        [
          newSibling,
          fixture.anchor,
          { kind: "runner", runnerId: "New off-page sibling" },
        ],
      ),
    );
    await expect(siblings).toContainText("New children available");
    await siblings
      .getByRole("button", { name: "Show new children", exact: true })
      .click();
    await expect(siblings.locator("[data-child-run-id]")).toHaveCount(25);
    await siblings
      .getByRole("button", { name: "Next page", exact: true })
      .click();
    await expect(
      siblings.locator(`[data-child-run-id="${newSibling}"]`),
    ).toBeVisible();
    await withE2EDb((pool) =>
      pool.query(
        "INSERT INTO runs(id,project_id,run_kind,status,flow_version,flow_revision,parent_run_id,root_run_id,agent_workspace,delegation_snapshot) SELECT $1,project_id,'agent','Done','v1','peek',$2,$3,'none',$4 FROM runs WHERE id=$2",
        [
          descendant,
          selected,
          fixture.anchor,
          { kind: "runner", runnerId: "Newly delegated analyst" },
        ],
      ),
    );
    await expect(
      peek(page).getByRole("region", { name: "Children" }),
    ).toContainText("Newly delegated analyst");
    expect(
      transcripts
        .filter((url) => !url.includes(fixture.anchor))
        .every((url) => url === `/api/runs/${selected}/transcript`),
    ).toBe(true);
    await peek(page)
      .getByRole("link", { name: /Newly delegated analyst/ })
      .click();
    await expect(peek(page)).toHaveAttribute("data-selected-run", descendant);
    await expect(peek(page)).toContainText(
      "No conversation has been recorded.",
    );
  } finally {
    await withE2EDb((pool) =>
      pool.query("DELETE FROM runs WHERE id=ANY($1::text[])", [
        [...ids, descendant, newSibling],
      ]),
    );
  }
});

test("E2E-PKN-06 E2E-PKN-12: hierarchy errors retain an authorized full-Run escape and an explicit retry recovers", async ({
  page,
}) => {
  await withE2EDb((pool) =>
    pool.query("UPDATE runs SET parent_run_id=$1 WHERE id=$2", [
      fixture.grandchild,
      fixture.child,
    ]),
  );
  await page.goto(`/runs/${fixture.anchor}?peek=${fixture.child}`);
  await expect(peek(page)).toContainText(
    "This Run hierarchy cannot be displayed.",
  );
  await expect(
    peek(page).getByRole("link", { name: "Open full Run" }),
  ).toHaveAttribute("href", `/runs/${fixture.child}`);
  await withE2EDb((pool) =>
    pool.query("UPDATE runs SET parent_run_id=$1 WHERE id=$2", [
      fixture.anchor,
      fixture.child,
    ]),
  );
  await peek(page).getByRole("button", { name: "Retry", exact: true }).click();
  await expect(peek(page)).toContainText("Conversation of Researcher Alpha");
});

test("E2E-PKD-07 E2E-PKN-12: an agent main Run receives a post-terminal result without a Flow manifest", async ({
  page,
}) => {
  const contract = {
    kind: "agent_profile",
    profileName: "research",
    schemaRef: "fixture@abcdef123456:research-result.v1",
    schemaVersion: 1,
    sha256: "a".repeat(64),
    required: true,
    schema: {
      schemaVersion: 1,
      fields: [{ name: "summary", type: "string", required: true }],
    },
    sourceFlowRevisionId: "peek",
  } satisfies RunResultContract;

  await withE2EDb((pool) =>
    pool.query("UPDATE runs SET status='Done',result_contract=$1 WHERE id=$2", [
      contract,
      fixture.child,
    ]),
  );
  await page.goto(`/runs/${fixture.child}?peek=${fixture.grandchild}`);
  await expect(peek(page)).toContainText("Conversation of Analyst Gamma");
  const result = page
    .locator('[data-testid="run-shell"]:visible')
    .getByTestId("run-shell-inspector")
    .getByTestId("run-public-result");

  await expect(result).toHaveAttribute("data-result-status", "missing");
  await withE2EDb((pool) =>
    pool.query(
      "INSERT INTO run_results(id,run_id,revision,validity,schema_ref,schema_version,schema_sha256,value,value_bytes,producer_kind,producer_ref,engine_version) VALUES($1,$2,1,'valid',$3,1,$4,'{\"summary\":\"Agent parent published later\"}',40,'agent_session','default','3.10.0')",
      [randomUUID(), fixture.child, contract.schemaRef, contract.sha256],
    ),
  );
  await expect(result).toHaveAttribute("data-result-status", "valid");
  await expect(peek(page)).toHaveAttribute(
    "data-selected-run",
    fixture.grandchild,
  );
  await expect(peek(page)).toContainText("Conversation of Analyst Gamma");
});

test("E2E-PKD-07 E2E-PKN-04 E2E-PKN-07: a delayed parent refresh cannot replace a newer child URL or its visit history", async ({
  page,
}) => {
  let holdNext = false,
    intercepted = false;
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });

  await page.route(`**/runs/${fixture.anchor}?*`, async (route) => {
    if (!holdNext || intercepted || route.request().headers().rsc !== "1") {
      await route.continue();

      return;
    }
    intercepted = true;
    const response = await route.fetch();

    await held;
    await route.fulfill({ response });
  });
  try {
    await page.setViewportSize({ width: 1600, height: 1000 });
    await page.goto(
      `/runs/${fixture.anchor}?wb=files&file=README.md&peek=${fixture.child}`,
    );
    await expect(peek(page)).toContainText("Conversation of Researcher Alpha");
    holdNext = true;
    await withE2EDb((pool) =>
      pool.query("UPDATE runs SET status='Review' WHERE id=$1", [
        fixture.anchor,
      ]),
    );
    await expect.poll(() => intercepted).toBe(true);
    await peek(page)
      .locator(`[data-child-run-id="${fixture.sibling}"] a`)
      .click();
    await expect(peek(page)).toContainText("Conversation of Researcher Beta");
    release();
    await expect(
      page
        .locator('[data-testid="run-shell"]:visible')
        .getByTestId("run-header-status"),
    ).toContainText("Review");
    await expect(page).toHaveURL(new RegExp(`peek=${fixture.sibling}`));
    await expect(peek(page)).toHaveAttribute(
      "data-selected-run",
      fixture.sibling,
    );
    await page.goBack();
    await expect(peek(page)).toHaveAttribute(
      "data-selected-run",
      fixture.child,
    );
    await page.goForward();
    await expect(peek(page)).toHaveAttribute(
      "data-selected-run",
      fixture.sibling,
    );
    await peek(page)
      .getByRole("button", { name: "Previous selection" })
      .click();
    await expect(peek(page)).toHaveAttribute(
      "data-selected-run",
      fixture.child,
    );
    await expect(page).toHaveURL(/file=README.md/);
  } finally {
    release();
    await withE2EDb((pool) =>
      pool.query("UPDATE runs SET status='Running' WHERE id=$1", [
        fixture.anchor,
      ]),
    );
  }
});

test("E2E-PKN-04 E2E-PKN-10: a tall inspector cannot clamp the parent scroll when peek hides it", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.goto(`/runs/${fixture.anchor}`);
  const list = page
    .locator('[data-testid="run-shell"]:visible')
    .getByTestId("run-inspector-child-runs");

  await list.evaluate((element) => {
    element.style.marginTop = "3500px";
  });
  const trigger = list.locator(`[data-child-run-id="${fixture.child}"] a`);

  await trigger.scrollIntoViewIfNeeded();
  const before = await page.evaluate(() => window.scrollY);

  expect(before).toBeGreaterThan(2000);
  await trigger.click();
  await expect(peek(page)).toContainText("Conversation of Researcher Alpha");
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(before);
  await expect(peek(page).getByRole("heading", { level: 2 })).toBeInViewport();
  await page.evaluate(() => window.scrollBy(0, -120));
  const latest = await page.evaluate(() => window.scrollY);

  await peek(page).getByRole("button", { name: "Close peek" }).focus();
  await page.keyboard.press("Escape");
  await expect(peek(page)).toHaveCount(0);
  await expect(trigger).toBeFocused();
  expect(await page.evaluate(() => window.scrollY)).toBe(latest);
});
