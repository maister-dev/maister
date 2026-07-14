import { test, expect } from "@playwright/test";

import { loadFixtures } from "./_seed/fixtures";

test.describe("M17 HITL hybrid-surface: cross-project inbox + review handoff", () => {
  test("inbox groups pending human reviews from both projects", async ({
    page,
  }) => {
    await page.goto("/inbox");

    await expect(page.getByRole("heading", { name: /Inbox/i })).toBeVisible();

    const project1Section = page.getByRole("region", {
      name: "MAIster E2E M17 Project 1",
    });
    const project2Section = page.getByRole("region", {
      name: "MAIster E2E M17 Project 2",
    });

    await expect(project1Section).toBeVisible();
    await expect(project2Section).toBeVisible();
    await expect(project1Section.getByTestId("hitl-card")).toHaveCount(1);
    await expect(project2Section.getByTestId("hitl-card")).toHaveCount(1);
  });

  test("inbox cards preserve branch and criticality context", async ({
    page,
  }) => {
    const fx = loadFixtures().byKey.m17;

    await page.goto("/inbox");

    const project1Card = page
      .getByTestId("hitl-card")
      .filter({ hasText: "M17 Project 1 Review" });
    const project2Card = page
      .getByTestId("hitl-card")
      .filter({ hasText: "M17 Project 2 Review" });

    await expect(project1Card).toContainText(fx.project1Branch);
    await expect(project2Card).toContainText(fx.project2Branch);
    await expect(project1Card).toHaveAttribute("data-criticality", "high");
    await expect(project2Card).toHaveAttribute("data-criticality", "medium");
  });

  test("review cards hand off to the code workspace without inline decisions", async ({
    page,
  }) => {
    const fx = loadFixtures().byKey.m17;

    await page.goto("/inbox");

    const project1Card = page
      .getByTestId("hitl-card")
      .filter({ hasText: "M17 Project 1 Review" });
    const project2Card = page
      .getByTestId("hitl-card")
      .filter({ hasText: "M17 Project 2 Review" });

    await expect(
      project1Card.getByRole("link", { name: "Review code" }),
    ).toHaveAttribute(
      "href",
      `/runs/${fx.project1RunId}?wb=review&scope=review`,
    );
    await expect(
      project2Card.getByRole("link", { name: "Review code" }),
    ).toHaveAttribute(
      "href",
      `/runs/${fx.project2RunId}?wb=review&scope=review`,
    );

    await expect(page.locator('input[id="hitl-confidence"]')).toHaveCount(0);
    await expect(
      project1Card.getByRole("button", {
        name: /approve|request rework|send back/i,
      }),
    ).toHaveCount(0);
    await expect(
      project2Card.getByRole("button", {
        name: /approve|request rework|send back/i,
      }),
    ).toHaveCount(0);
  });

  test("criticality badges retain distinct visual hierarchy", async ({
    page,
  }) => {
    await page.goto("/inbox");

    const project1Card = page
      .getByTestId("hitl-card")
      .filter({ hasText: "M17 Project 1 Review" });
    const project2Card = page
      .getByTestId("hitl-card")
      .filter({ hasText: "M17 Project 2 Review" });
    const project1Styles = await project1Card.getAttribute("class");
    const project2Styles = await project2Card.getAttribute("class");

    expect(project1Styles).toBeTruthy();
    expect(project2Styles).toBeTruthy();
    expect(project1Styles).not.toEqual(project2Styles);
  });
});
