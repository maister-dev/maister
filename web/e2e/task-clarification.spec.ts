import type { Browser, Page } from "@playwright/test";

import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import { withE2EDb } from "./_seed/db";
import { loadFixtures, type E2EUserFixture } from "./_seed/fixtures";

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

test("E2E-CLR-03: an addressed request appears in the recipient inbox and the recipient answers on the task", async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const fx = loadFixtures();
  const project = fx.byKey.board;
  const recipient = fx.byKey.workTable.member;
  const membershipId = randomUUID();
  const taskId = randomUUID();
  const clarificationId = randomUUID();
  const taskNumber = 100_000 + Math.floor(Math.random() * 100_000);
  const question = `Which region ${clarificationId.slice(0, 8)}?`;

  // The request route and its authority checks are exercised against Postgres
  // by IT-CLR-02/03/09. This browser test seeds its persisted result so the
  // UI path can run without starting a librarian ACP session.
  await withE2EDb(async (pool) => {
    await pool.query(
      `INSERT INTO project_members (id, project_id, user_id, role)
       VALUES ($1, $2, $3, 'member')`,
      [membershipId, project.projectId, recipient.id],
    );
    await pool.query(
      `INSERT INTO tasks (id, project_id, number, title, prompt, flow_id, status, stage)
       VALUES ($1, $2, $3, 'Addressed clarification E2E', 'Choose a region', $4, 'Backlog', 'Backlog')`,
      [taskId, project.projectId, taskNumber, project.flowId],
    );
    await pool.query(
      `INSERT INTO task_clarifications
         (id, task_id, seq, origin_kind, retrigger_mode, question, requester_user_id,
          recipient_user_id, reason, answer_format, blocking, status)
       VALUES ($1, $2, 1, 'user', 'none', $3, $4, $5,
               'The target is ambiguous', 'text', true, 'open')`,
      [clarificationId, taskId, question, fx.users.admin.id, recipient.id],
    );
  });

  const recipientPage = await pageAs(browser, recipient);

  try {
    await recipientPage.goto("/inbox");
    const decision = recipientPage.locator(
      '[data-decision-kind="clarification"]',
      { hasText: question },
    );

    await expect(decision).toBeVisible();
    await decision.getByRole("link").click();
    await recipientPage.waitForURL(
      `**/projects/${project.projectSlug}/tasks/${taskNumber}`,
      { timeout: 60_000 },
    );
    await expect(
      recipientPage.getByTestId("task-user-clarification").getByText(question),
    ).toBeVisible({ timeout: 20_000 });
    await recipientPage.getByRole("textbox", { name: "Answer" }).fill("EU");
    await recipientPage.getByRole("button", { name: "Send answer" }).click();
    await expect(
      recipientPage
        .getByTestId("task-user-clarification")
        .getByText("Answered"),
    ).toBeVisible();
    await expect(
      recipientPage.getByTestId("task-user-clarification").getByText("EU"),
    ).toBeVisible();

    await recipientPage.goto("/inbox");
    await expect(
      recipientPage.locator('[data-decision-kind="clarification"]', {
        hasText: question,
      }),
    ).toHaveCount(0);
    const answer = await withE2EDb(async (pool) => {
      const result = await pool.query<{ status: string; answer: string }>(
        "SELECT status, answer FROM task_clarifications WHERE id = $1",
        [clarificationId],
      );

      return result.rows[0];
    });

    expect(answer).toEqual({ status: "answered", answer: "EU" });
  } finally {
    await withE2EDb(async (pool) => {
      await pool.query("DELETE FROM tasks WHERE id = $1", [taskId]);
      await pool.query("DELETE FROM project_members WHERE id = $1", [
        membershipId,
      ]);
    });
    await recipientPage.context().close();
  }
});
