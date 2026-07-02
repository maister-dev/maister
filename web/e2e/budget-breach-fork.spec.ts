import { test, expect } from "@playwright/test";

import { loadFixtures } from "./_seed/fixtures";

test.describe.configure({ mode: "serial" });

test.describe("Budget breach fork HITL surface", () => {
  test("inbox card renders progress and the four server-provided options", async ({
    page,
  }) => {
    const fx = loadFixtures().byKey.budgetFork;

    await page.goto("/inbox");

    const card = page
      .getByTestId("hitl-card")
      .filter({ hasText: fx.taskTitle });

    await expect(card).toBeVisible();

    await card.locator("button[aria-expanded]").first().click();

    await expect(card.getByTestId("budget-progress")).toBeVisible();
    await expect(card.getByTestId("budget-progress")).toContainText(
      "1200 / 1000",
    );
    await expect(card.getByTestId("budget-breach-raise")).toBeVisible();
    await expect(card.getByTestId("budget-breach-restart")).toBeVisible();
    await expect(card.getByTestId("budget-breach-park")).toBeVisible();
    await expect(card.getByTestId("budget-breach-abandon")).toBeVisible();
    await expect(card.getByTestId("budget-drop-workspace")).toBeVisible();
  });

  test("run detail mirrors the budget fork controls in Russian locale", async ({
    context,
    page,
  }) => {
    const fx = loadFixtures().byKey.budgetFork;

    await context.addCookies([
      {
        name: "NEXT_LOCALE",
        value: "ru",
        url: process.env.E2E_BASE_URL ?? "http://localhost:3100",
      },
    ]);

    await page.goto(`/runs/${fx.runId}`);

    const panel = page.getByTestId("budget-breach-card");

    await expect(panel).toBeVisible();
    await expect(panel).toContainText("Превышение бюджета");
    await expect(panel.getByTestId("budget-progress")).toContainText(
      "1200 / 1000",
    );
    await expect(panel.getByTestId("budget-breach-raise")).toBeVisible();
    await expect(panel.getByTestId("budget-breach-restart")).toBeVisible();
    await expect(panel.getByTestId("budget-breach-park")).toBeVisible();
    await expect(panel.getByTestId("budget-breach-abandon")).toBeVisible();
  });

  test("raise submits the existing resume path", async ({ context, page }) => {
    const fx = loadFixtures().byKey.budgetFork;

    await context.addCookies([
      {
        name: "NEXT_LOCALE",
        value: "en",
        url: process.env.E2E_BASE_URL ?? "http://localhost:3100",
      },
    ]);

    await page.goto(`/runs/${fx.runId}`);

    const panel = page.getByTestId("budget-breach-card");

    await expect(panel).toBeVisible();

    const responsePromise = page.waitForResponse(
      (response) =>
        response
          .url()
          .includes(`/api/runs/${fx.runId}/hitl/${fx.hitlRequestId}/respond`) &&
        response.request().method() === "POST",
    );

    await panel.getByTestId("budget-breach-raise").click();

    const response = await responsePromise;

    expect(response.status()).toBe(202);
    await expect(page.getByTestId("budget-breach-card")).toHaveCount(0);
  });
});
