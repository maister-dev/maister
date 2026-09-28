// The librarian's entry and panel, end to end (ADR-191, T2.15):
// `E2E-LUI-01` entry on every route · `E2E-LUI-02` the panel survives
// navigation, collapse and reload · `E2E-LUI-03` presentation by viewport ·
// `E2E-LUI-05` focus · `E2E-LUI-09` no Cmd/Ctrl+K of its own.
//
// The e2e platform leaves the librarian disabled, so nothing here starts a
// turn: the history the panel restores is seeded straight into the tables.

import type { Page } from "@playwright/test";

import { randomUUID } from "node:crypto";

import { test, expect } from "@playwright/test";

import { withE2EDb } from "./_seed/db";

function trigger(page: Page) {
  return page.getByTestId("librarian-trigger");
}

function panel(page: Page) {
  return page.getByTestId("librarian-panel");
}

async function openPanel(page: Page): Promise<void> {
  await expect(trigger(page)).toBeVisible();
  await trigger(page).click();
  await expect(panel(page)).toBeVisible();
}

/** A reply the panel must restore after a reload — written as the owner's
 * conversation would hold it, at the next durable seq. */
async function seedReply(page: Page, body: string): Promise<void> {
  // The first read creates the conversation for the session user.
  const response = await page.request.get("/api/librarian/conversation");

  expect(response.ok()).toBe(true);
  const view = (await response.json()) as {
    conversation: { id: string };
    segment: { id: string };
  };

  await withE2EDb(async (pool) => {
    const client = await pool.connect();

    try {
      await client.query("BEGIN");
      const {
        rows: [{ seq }],
      } = await client.query<{ seq: string }>(
        `UPDATE librarian_conversations SET last_seq = last_seq + 1
          WHERE id = $1 RETURNING last_seq::text AS seq`,
        [view.conversation.id],
      );

      await client.query(
        `INSERT INTO librarian_messages
           (id, conversation_id, segment_id, seq, author_kind, body, delivery_state)
         VALUES ($1, $2, $3, $4, 'librarian', $5, 'accepted')`,
        [randomUUID(), view.conversation.id, view.segment.id, seq, body],
      );
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  });
}

test.describe("E2E-LUI-01: the entry on every (app) route", () => {
  for (const route of ["/", "/projects", "/inbox", "/activity"]) {
    test(`renders on ${route} with a name and no number`, async ({ page }) => {
      await page.goto(route);
      const entry = trigger(page);

      await expect(entry).toBeVisible();
      await expect(entry).toHaveAccessibleName(/^Librarian/);
      expect(await entry.innerText()).not.toMatch(/\d/);
      expect(
        ["none", "running", "unread", "action_required"].includes(
          (await entry.getAttribute("data-indicator")) ?? "",
        ),
      ).toBe(true);
    });
  }
});

test("E2E-LUI-02: navigation, collapse and reload keep the conversation and the draft", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  const reply = `seeded reply ${randomUUID().slice(0, 8)}`;

  await seedReply(page, reply);
  await openPanel(page);
  await expect(panel(page).getByText(reply)).toBeVisible();
  const composer = page.getByTestId("librarian-composer");

  await composer.fill("a draft that must survive");

  // A client-side route change: the layout, and so the panel, stay mounted.
  await page.locator('a[href="/projects"]').first().click();
  await page.waitForURL("**/projects");
  await expect(panel(page)).toBeVisible();
  await expect(composer).toHaveValue("a draft that must survive");
  await expect(panel(page).getByText(reply)).toBeVisible();

  // Collapse, reopen.
  await page.getByTestId("librarian-close").click();
  await expect(panel(page)).toBeHidden();
  await openPanel(page);
  await expect(composer).toHaveValue("a draft that must survive");

  // Reload: messages from the server, the draft from browser storage.
  await page.reload();
  await openPanel(page);
  await expect(panel(page).getByText(reply)).toBeVisible();
  await expect(page.getByTestId("librarian-composer")).toHaveValue(
    "a draft that must survive",
  );
});

test.describe("E2E-LUI-03: one panel, three presentations", () => {
  for (const [width, mode, role] of [
    [1440, "docked", "complementary"],
    [1280, "docked", "complementary"],
    [1024, "sheet", "dialog"],
    [390, "fullscreen", "dialog"],
  ] as const) {
    test(`${width} px → ${mode}`, async ({ page }) => {
      const overflow = () =>
        page.evaluate(
          () =>
            document.documentElement.scrollWidth -
            document.documentElement.clientWidth,
        );

      await page.setViewportSize({ width, height: 844 });
      // `/inbox`, not the Desk: the Desk's work table is wider than 1024px on
      // its own, and this measures what the librarian adds.
      await page.goto("/inbox");
      await expect(trigger(page)).toBeVisible();
      const before = await overflow();

      await openPanel(page);
      await expect(panel(page)).toHaveAttribute("data-mode", mode);
      await expect(panel(page)).toHaveAttribute("role", role);
      await expect(page.getByTestId("librarian-send")).toBeInViewport();
      expect(await overflow()).toBeLessThanOrEqual(Math.max(0, before));
      if (width === 390) expect(await overflow()).toBeLessThanOrEqual(0);
    });
  }
});

test("E2E-LUI-05: opening focuses the composer, closing returns focus, the sheet traps it", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await expect(trigger(page)).toBeVisible();
  await trigger(page).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("librarian-composer")).toBeFocused();
  // Docked Escape is bound on the panel itself.
  await page.keyboard.press("Escape");
  await expect(panel(page)).toBeHidden();
  await expect(trigger(page)).toBeFocused();

  await page.setViewportSize({ width: 1024, height: 800 });
  await trigger(page).focus();
  await page.keyboard.press("Enter");
  await expect(panel(page)).toHaveAttribute("aria-modal", "true");
  await expect(page.getByTestId("librarian-composer")).toBeFocused();
  for (let i = 0; i < 12; i += 1) {
    await page.keyboard.press("Tab");
    expect(
      await page.evaluate(() =>
        Boolean(
          document.activeElement?.closest('[data-testid="librarian-panel"]'),
        ),
      ),
    ).toBe(true);
  }
  await page.keyboard.press("Escape");
  await expect(panel(page)).toBeHidden();
  await expect(trigger(page)).toBeFocused();
});

test("E2E-LUI-09: the scratch launcher's Cmd/Ctrl+K still works beside the docked panel", async ({
  page,
}) => {
  const mod = process.platform === "darwin" ? "Meta" : "Control";

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  // Hydration proof for the launcher's listener, as scratch-launch.spec does.
  const launchButton = page.getByRole("button", { name: "Launch run" });

  await launchButton.click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);

  await openPanel(page);
  await expect(panel(page)).toHaveAttribute("data-mode", "docked");
  // Focus outside any editable field, the panel still open beside the page.
  await page.getByRole("main").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press(`${mod}+KeyK`);
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(panel(page)).toBeVisible();
});
