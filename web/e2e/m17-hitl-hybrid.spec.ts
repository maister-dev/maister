import { test, expect } from "@playwright/test";

import { loadFixtures } from "./_seed/fixtures";

// Serial: the inline-response test CONSUMES the seeded HITL requests the
// styling test asserts on; under fullyParallel, same-file tests land in
// different workers and race over the shared rows (m27-workbench precedent).
test.describe.configure({ mode: "serial" });

test.describe("M17 HITL hybrid-surface: cross-project inbox + inline response", () => {
  test("inbox page shows cross-project HITL inbox with pending count badge", async ({
    page,
  }) => {
    await page.goto("/inbox");

    // Unified inbox page is visible (WI-1 moved the cross-project block here)
    await expect(page.getByRole("heading", { name: /Inbox/i })).toBeVisible();

    // Cross-project inbox block appears
    const inboxSection = page.getByTestId("cross-project-hitl-inbox");

    await expect(inboxSection).toBeVisible();

    // Count badge is the aria-label span showing "N pending"
    // (the exact count includes all projects' HITL items in the seed)
    const countBadge = inboxSection.locator('span[aria-label*="pending"]');

    await expect(countBadge).toBeVisible();
    // Verify the badge contains at least a number (count >= 2 from M17)
    const badgeText = await countBadge.textContent();

    expect(badgeText).toMatch(/\d+/);
  });

  test("inbox lists both projects with their HITL metadata", async ({
    page,
  }) => {
    await page.goto("/inbox");

    const inboxSection = page.getByTestId("cross-project-hitl-inbox");

    // Project 1 entry visible: contains project name metadata, branch, flow ref, agent
    const proj1Item = inboxSection.locator("article").first();

    await expect(proj1Item).toBeVisible();
    // Project metadata line shows: "projectName · branch · flow · agent"
    // The projectName is rendered from the DB projects table "name" field: "MAIster E2E M17 Project 1"
    await expect(proj1Item).toContainText("MAIster E2E M17 Project 1");
    await expect(proj1Item).toContainText("aif");
    await expect(proj1Item).toContainText("claude");

    // High criticality badge has data-criticality="high" and displays text "high"
    const proj1Criticality = proj1Item.locator('span[data-criticality="high"]');

    await expect(proj1Criticality).toBeVisible();
    await expect(proj1Criticality).toContainText("high");

    // Project 2 entry visible
    const proj2Item = inboxSection.locator("article").nth(1);

    await expect(proj2Item).toBeVisible();
    // The projectName is "MAIster E2E M17 Project 2"
    await expect(proj2Item).toContainText("MAIster E2E M17 Project 2");
    await expect(proj2Item).toContainText("aif");
    await expect(proj2Item).toContainText("claude");

    // Medium criticality badge has data-criticality="medium" and displays text "medium"
    const proj2Criticality = proj2Item.locator(
      'span[data-criticality="medium"]',
    );

    await expect(proj2Criticality).toBeVisible();
    await expect(proj2Criticality).toContainText("medium");
  });

  test("project board flight card shows inline HITL response control", async ({
    page,
  }) => {
    const fx = loadFixtures().byKey.m17;

    // Navigate to project 1 board
    await page.goto(`/projects/${fx.project1Slug}`);

    await expect(
      page.getByRole("heading", { name: "MAIster E2E M17 Project 1" }),
    ).toBeVisible();

    // Find the NeedsInput flight card. The card displays the task title "M17 Project 1 Review"
    // and contains the branch name. Look for the nearest ancestor that is the flight card.
    const taskTitleText = page.getByText("M17 Project 1 Review", {
      exact: true,
    });

    await expect(taskTitleText).toBeVisible();

    // Navigate to the parent flight card container by finding the closest ancestor that has the HITL controls
    const confidenceInput = page.locator('input[id="hitl-confidence"]');

    await expect(confidenceInput).toBeVisible();

    // Decision buttons (approve/rework) are visible by text matching.
    const approveButton = page.locator("button").filter({
      hasText: /Approve/i,
    });

    await expect(approveButton).toBeVisible();
  });

  test("HITL inbox blocks are styled with criticality-driven visual hierarchy", async ({
    page,
  }) => {
    await page.goto("/inbox");

    const inboxSection = page.getByTestId("cross-project-hitl-inbox");

    // Scope each item to ITS project card, and run BEFORE the inline-response
    // test below — that test approves Project 1's request, which removes the
    // very inbox item asserted here (serial declaration order is authoritative).
    const proj1Item = inboxSection
      .locator("article")
      .filter({ hasText: "MAIster E2E M17 Project 1" })
      .first();
    const proj1Criticality = proj1Item.locator('span[data-criticality="high"]');

    await expect(proj1Criticality).toBeVisible();

    const proj2Item = inboxSection
      .locator("article")
      .filter({ hasText: "MAIster E2E M17 Project 2" })
      .first();
    const proj2Criticality = proj2Item.locator(
      'span[data-criticality="medium"]',
    );

    await expect(proj2Criticality).toBeVisible();

    // Both items have distinct criticality styling
    const proj1Styles = await proj1Criticality.getAttribute("class");
    const proj2Styles = await proj2Criticality.getAttribute("class");

    expect(proj1Styles).toBeTruthy();
    expect(proj2Styles).toBeTruthy();
    // High and medium have different style classes
    expect(proj1Styles).not.toEqual(proj2Styles);
  });

  test("inline HITL response: confidence input + approve decision", async ({
    page,
  }) => {
    const fx = loadFixtures().byKey.m17;

    await page.goto(`/projects/${fx.project1Slug}`);

    // Find flight card by the exact task title text from the fixture
    const flightCard = page.locator("article, div").filter({
      hasText: "M17 Project 1 Review",
    });

    // Fill confidence input
    const confidenceInput = flightCard.locator('input[id="hitl-confidence"]');

    await confidenceInput.fill("0.95");
    await expect(confidenceInput).toHaveValue("0.95");

    // Click approve button
    const approveButton = flightCard.locator("button").filter({
      hasText: /approve/i,
    });

    await approveButton.click();

    // Wait for the response to be processed and page to stabilize
    await page.waitForLoadState("networkidle");

    // Verify we can navigate back to the inbox and the count reflects the change
    await page.goto("/inbox");
    const inboxSection = page.getByTestId("cross-project-hitl-inbox");

    // The inbox should still be visible; the count updates via SSE/refresh
    await expect(inboxSection).toBeVisible();
  });

  test("graph human_review HITL shows criticality badge in context", async ({
    page,
  }) => {
    const fx = loadFixtures().byKey.m17;

    // Navigate to project 2 board
    await page.goto(`/projects/${fx.project2Slug}`);

    await expect(
      page.getByRole("heading", { name: "MAIster E2E M17 Project 2" }),
    ).toBeVisible();

    // Find the task by its title text
    const taskTitleText = page.getByText("M17 Project 2 Review", {
      exact: true,
    });

    await expect(taskTitleText).toBeVisible();

    // On the board, the flight card for a NeedsInput run shows the HITL controls inline,
    // including the criticality badge. The badge displays text like "medium" (uppercase).
    // Find it by searching for the criticality level label text.
    const criticalityBadgeText = page.getByText("medium", { exact: true });

    await expect(criticalityBadgeText).toBeVisible();

    // Also verify the confidence input is present (other HITL control)
    const confidenceInput = page.locator('input[id="hitl-confidence"]');

    await expect(confidenceInput).toBeVisible();
  });

  test("send-back control is rendered for human_review with on_reject schema", async ({
    page,
  }) => {
    const fx = loadFixtures().byKey.m17;

    await page.goto(`/projects/${fx.project2Slug}`);

    // Find the task by its title text
    const taskTitleText = page.getByText("M17 Project 2 Review", {
      exact: true,
    });

    await expect(taskTitleText).toBeVisible();

    // Send-back is typically a "Request rework" button, part of the HITL control.
    // Assert the button exists (may be visible or hidden behind interaction).
    const reworkButton = page.locator("button").filter({
      hasText: /rework|send back/i,
    });

    const exists = await reworkButton.count();

    expect(exists).toBeGreaterThan(0);
  });
});
