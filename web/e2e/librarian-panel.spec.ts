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

test("B3 keeps history and attention scrollable without displacing the composer", async ({
  page,
  context,
  baseURL,
}) => {
  const response = await page.request.get("/api/librarian/conversation");
  const view = await response.json();

  await withE2EDb((pool) =>
    pool.query(
      `INSERT INTO librarian_operations(id,conversation_id,segment_id,idempotency_key,kind,request_digest,target,status,error_code,created_at)
     SELECT $1 || '-browser-' || i,$1,$2,'browser-' || i,'task_create','browser-' || i,'{}',
      (ARRAY['succeeded','admitted','unknown','refused','failed'])[i%5+1],
      'PRECONDITION',now() + i * interval '1 second' FROM generate_series(1,30) i`,
      [view.conversation.id, view.segment.id],
    ),
  );

  for (const [width, height, locale, theme] of [
    [390, 844, "en", "light"],
    [390, 844, "ru", "dark"],
    [1366, 768, "en", "light"],
    [1366, 768, "ru", "dark"],
    [1440, 1000, "en", "dark"],
    [1440, 1000, "ru", "light"],
  ] as const) {
    await context.addCookies([
      { name: "NEXT_LOCALE", value: locale, url: baseURL! },
      { name: "theme", value: theme, url: baseURL! },
    ]);
    await page.setViewportSize({ width, height });
    await page.goto("/");
    await expect(page.locator("html")).toHaveClass(
      new RegExp(`\\b${theme}\\b`),
    );
    await openPanel(page);
    const composer = panel(page).locator("textarea");
    const opener = panel(page).getByRole("button", {
      name: locale === "ru" ? "История действий" : "Action history",
    });

    await expect(opener).toBeVisible();
    const before = await composer.boundingBox();

    await opener.focus();
    await page.keyboard.press("Enter");
    const history = page.getByTestId("librarian-action-history");
    const statuses =
      locale === "ru"
        ? ["Результат неизвестен", "Готово", "Отказано", "Ошибка"]
        : ["Outcome uncertain", "Done", "Refused", "Failed"];

    await expect(history).toBeInViewport();
    for (const status of statuses) {
      await expect(
        history.getByText(status, { exact: true }).first(),
      ).toBeVisible();
    }
    expect((await history.boundingBox())?.height).toBeLessThanOrEqual(
      Math.min(height * 0.55, 440),
    );
    expect((await composer.boundingBox())?.y).toBe(before?.y);
    await page.keyboard.press("Escape");
    await expect(history).toHaveCount(0);
    await expect(opener).toBeFocused();
  }
});

test("E2E-ASK-02 owner answers a private question from the transcript with the keyboard", async ({
  page,
}) => {
  await page.goto("/inbox");
  const res = await page.request.get("/api/librarian/conversation");

  expect(res.ok()).toBe(true);
  const { conversation, segment } = (await res.json()) as {
    conversation: { id: string };
    segment: { id: string };
  };
  const cardId = randomUUID(),
    turnId = randomUUID(),
    messageId = randomUUID();

  await withE2EDb(async (pool) => {
    await pool.query(
      `WITH t AS (
      INSERT INTO librarian_turns (id,conversation_id,segment_id,variant,status)
      VALUES ($1,$2,$3,'owner_message','awaiting_answer') RETURNING id
    ), card AS (
      INSERT INTO librarian_cards (id,conversation_id,segment_id,kind,status,target,payload,payload_digest,requires_owner,expires_at,question_turn_id,question_key,question_checkpoint_at)
      SELECT $4,$2,$3,'question','pending','{}',$5,'fixture',true,now()+interval '1 day',t.id,'journey',now() FROM t RETURNING id
    ), seq AS (
      UPDATE librarian_conversations SET last_seq=last_seq+1 WHERE id=$2 RETURNING last_seq
    ) INSERT INTO librarian_messages (id,conversation_id,segment_id,turn_id,card_id,author_kind,seq,body,delivery_state)
      SELECT $6,$2,$3,$1,card.id,'librarian',seq.last_seq,'Which customer journey?','processed' FROM card,seq`,
      [
        turnId,
        conversation.id,
        segment.id,
        cardId,
        JSON.stringify({
          requestKey: "journey",
          question: "Which customer journey?",
          schema: {
            schemaVersion: 1,
            fields: [
              {
                name: "journey",
                type: "string",
                required: true,
                label: "Journey",
                options: ["Checkout", "Browse"],
              },
            ],
          },
        }),
        messageId,
      ],
    );
  });
  try {
    await openPanel(page);
    const question = page
      .getByTestId("librarian-private-question")
      .filter({ hasText: "Which customer journey?" });

    await expect(question).toBeVisible();
    await page.getByTestId("librarian-composer").fill("Checkout draft");
    await expect(page.getByTestId("librarian-send")).toBeDisabled();
    await expect(page.getByTestId("librarian-send-reason")).toHaveText(
      "Answer the open question above or stop the response.",
    );
    await expect(page.getByTestId("librarian-stop-response")).toBeEnabled();
    await question.getByRole("button", { name: "Checkout" }).focus();
    await page.keyboard.press("Enter");
    const input = question.getByRole("textbox", { name: /Journey/ });

    await expect(input).toHaveValue("Checkout");
    await input.fill("Custom mobile checkout");
    await page.route(
      `**/api/librarian/cards/${cardId}/answer`,
      (route) =>
        route.fulfill({
          status: 503,
          json: {
            code: "EXECUTOR_UNAVAILABLE",
            message: "Private runner diagnostic",
          },
        }),
      { times: 1 },
    );
    await question.getByRole("button", { name: "Send answer" }).focus();
    await page.keyboard.press("Enter");
    await expect(question.getByRole("alert")).toHaveText(
      "Executor unavailable",
    );
    await expect(input).toHaveValue("Custom mobile checkout");
    const conversationRefresh = (url: URL): boolean =>
      url.pathname === "/api/librarian/conversation" &&
      url.searchParams.get("view") === "work";

    await page.route(conversationRefresh, (route) =>
      route.fulfill({ status: 503 }),
    );
    await question.getByRole("button", { name: "Send answer" }).focus();
    await page.keyboard.press("Enter");
    await expect(question).toContainText("Answer queued");
    await expect(question).toContainText("Custom mobile checkout");
    await expect(
      question.getByRole("button", { name: "Send answer" }),
    ).toHaveCount(0);
    await page.unroute(conversationRefresh);
    await page.reload();
    await openPanel(page);
    await expect(question).toContainText("Custom mobile checkout");
    await expect(
      question.getByRole("button", { name: "Send answer" }),
    ).toHaveCount(0);
  } finally {
    await withE2EDb(async (pool) => {
      await pool.query("DELETE FROM librarian_messages WHERE turn_id=$1", [
        turnId,
      ]);
      await pool.query("DELETE FROM librarian_turns WHERE id=$1", [turnId]);
    });
  }
});
