import { test, expect } from "@playwright/test";

import { loadFixtures } from "./_seed/fixtures";

test("portfolio and project board expose seeded acceptance work", async ({
  page,
}) => {
  const fx = loadFixtures().byKey.board;

  await page.goto("/");

  await expect(page.getByRole("heading", { name: "Projects." })).toBeVisible();
  await expect(
    page.getByRole("link", { name: "E2E Acceptance Board" }),
  ).toBeVisible();
  await expect(page.getByText("things need your review")).toBeVisible();
  await expect(
    page.getByText("Acceptance review is waiting on you.").first(),
  ).toBeVisible();

  await page.goto(`/projects/${fx.projectSlug}`);

  await expect(
    page.getByRole("heading", { name: "E2E Acceptance Board" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "HITL inbox" }),
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
  await expect(
    page.getByText("MCP server management isn't wired up on this POC yet."),
  ).toBeVisible();

  await page.getByRole("tab", { name: /Packages/i }).click();
  await expect(page).toHaveURL(/tab=packages/);
  await expect(page.getByText("acceptance").first()).toBeVisible();
});
