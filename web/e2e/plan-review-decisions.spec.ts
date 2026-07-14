import { expect, test } from "@playwright/test";

import { loadFixtures } from "./_seed/fixtures";

test.describe("Plan-review decision requests", () => {
  test("answers a blocking decision from Inbox, keeps its parent chat, and schedules rework after the final answer", async ({
    page,
  }) => {
    const fixture = loadFixtures().byKey.planReview;
    const inboxProject = page.locator(
      'section[aria-label="MAIster E2E Plan Review"]',
    );

    await page.goto("/inbox");

    await expect(inboxProject.getByTestId("hitl-card")).toHaveCount(3);
    const inboxDatabaseDecision = inboxProject
      .getByTestId("hitl-card")
      .filter({ hasText: "Choose a database" });

    await inboxDatabaseDecision
      .getByRole("button", { name: "Respond" })
      .click();
    await expect(
      inboxDatabaseDecision.getByTestId("plan-decision-card"),
    ).toBeVisible();
    await inboxDatabaseDecision
      .getByRole("button", { name: /Postgres/ })
      .click();
    await expect(
      inboxProject
        .getByTestId("hitl-card")
        .filter({ hasText: "Choose a database" }),
    ).toHaveCount(0);

    await page.goto(`/runs/${fixture.runId}`);

    await expect(
      page.getByText(fixture.taskTitle, { exact: true }),
    ).toBeVisible();
    const decisionCards = page.getByTestId("plan-decision-card");
    const databaseDecision = decisionCards.filter({
      hasText: "Choose a database",
    });
    const resumeDecision = decisionCards.filter({
      hasText: "Choose a resume mode",
    });

    await expect(page.locator("#agent-chat")).toBeVisible();
    await expect(decisionCards).toHaveCount(1);
    await expect(databaseDecision).toHaveCount(0);
    await expect(resumeDecision).toHaveCount(1);

    await resumeDecision.getByRole("button", { name: /Graph/ }).click();

    await expect(page.getByTestId("plan-decision-card")).toHaveCount(0);
    await expect(page.locator("#agent-chat")).toHaveCount(0);
  });
});
