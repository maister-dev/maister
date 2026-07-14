import { expect, test } from "@playwright/test";

import { loadFixtures } from "./_seed/fixtures";

test.describe("Plan-review decision requests", () => {
  test("shows every blocking decision on run detail and removes only the answered child", async ({
    page,
  }) => {
    const fixture = loadFixtures().byKey.planReview;

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

    await expect(decisionCards).toHaveCount(2);
    await expect(databaseDecision).toHaveCount(1);
    await expect(resumeDecision).toHaveCount(1);
    await expect(
      databaseDecision.getByRole("button", { name: /Postgres/ }),
    ).toBeVisible();

    await databaseDecision.getByRole("button", { name: /Postgres/ }).click();

    await expect(page.getByTestId("plan-decision-card")).toHaveCount(1);
    await expect(resumeDecision).toHaveCount(1);
    await expect(page.getByTestId("pending-input-card").first()).toBeFocused();
  });
});
