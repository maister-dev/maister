import { test, expect } from "@playwright/test";

import { loadFixtures } from "./_seed/fixtures";

test("portfolio and project board expose seeded acceptance work", async ({
  page,
}) => {
  const fx = loadFixtures().byKey.board;

  await page.goto("/");

  await expect(page.getByRole("heading", { name: "Projects." })).toBeVisible();
  // exact:true targets the main-grid project link. The left rail (rendered at
  // md+) carries a "Start scratch workspace in E2E Acceptance Board" link whose
  // name contains this string, so a substring match resolves to two elements.
  await expect(
    page.getByRole("link", { name: "E2E Acceptance Board", exact: true }),
  ).toBeVisible();
  // The home "needs review" strip was removed in the project-grouped
  // active-workspaces redesign; home now exposes the seeded NeedsInput
  // workspace as a run row inside the project group.
  await expect(
    page.getByRole("link", { name: /acceptance-needs-input/ }).first(),
  ).toBeVisible();
  // WI-1: home collapses the cross-project HITL + social inbox into one compact
  // "Needs you" summary card (the full surfaces moved to /inbox).
  await expect(page.getByTestId("needs-you-summary")).toBeVisible();

  await page.goto(`/projects/${fx.projectSlug}`);

  await expect(
    page.getByRole("heading", { name: "E2E Acceptance Board" }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "HITL inbox" })).toBeVisible();
  // The seeded HITL question surfaces in the board's inbox (the home strip
  // that used to carry it is gone).
  await expect(
    page.getByText("Acceptance review is waiting on you.").first(),
  ).toBeVisible();
  await expect(page.getByText("Acceptance backlog launch")).toBeVisible();
  await expect(page.locator("[data-board]")).toBeVisible();
  await expect(page.locator('[data-stage="backlog"]')).toContainText(
    "Acceptance backlog launch",
  );
  await expect(page.locator('[data-stage="production"]')).toContainText(
    "Acceptance review pending",
  );

  await page.getByRole("tab", { name: /Activity/i }).click();
  await expect(page).toHaveURL(/tab=activity/);
  await expect(page.getByText("Activity").first()).toBeVisible();

  await page.getByRole("tab", { name: /PRs/i }).click();
  await expect(page).toHaveURL(/tab=prs/);
  await expect(
    page.getByText("Pull-request sync isn't wired up on this POC yet."),
  ).toBeVisible();

  await page.getByRole("tab", { name: /MCPs/i }).click();
  await expect(page).toHaveURL(/tab=mcps/);
  // The MCPs tab is the real project MCP catalog since M27 (ADR-070), not a
  // POC placeholder.
  await expect(
    page.getByRole("heading", { name: "Project MCP servers" }),
  ).toBeVisible();

  await page.getByRole("tab", { name: /Packages/i }).click();
  await expect(page).toHaveURL(/tab=packages/);
  await expect(page.getByText("acceptance").first()).toBeVisible();
});
