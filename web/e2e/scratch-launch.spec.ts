import { writeFileSync } from "node:fs";

import { test, expect } from "@playwright/test";

import { countRows } from "./_seed/db";
import { loadFixtures } from "./_seed/fixtures";

test("scratch launch controls render, while capacity guard fails without durable side effects", async ({
  page,
}, testInfo) => {
  const fixtures = loadFixtures().byKey;
  const fx = fixtures.scratch;
  const boardFx = fixtures.board;
  const branchName = `${fx.projectSlug}/scratch/unreachable-supervisor-${Date.now()}`;
  const uploadPath = testInfo.outputPath("scratch-upload.txt");

  writeFileSync(uploadPath, "hello from playwright");

  await page.goto("/");
  await page
    .getByRole("link", {
      name: "Start scratch workspace in E2E Acceptance Board",
    })
    .click();
  await expect(page).toHaveURL(
    new RegExp(`/scratch-runs/new\\?projectId=${boardFx.projectId}`),
  );

  await page.goto(`/scratch-runs/new?projectId=${fx.projectId}`);

  await expect(
    page.getByRole("heading", { name: "Start a scratch run." }),
  ).toBeVisible();
  await expect(page.getByLabel("Project")).toHaveValue(fx.projectId);
  await expect(page.getByLabel("Base branch")).toHaveValue("main");
  await expect(page.getByLabel("Branch name")).toHaveValue("");

  await expect(
    page.locator("details").filter({ hasText: "ACP profile" }),
  ).not.toHaveAttribute("open", "");
  await page.locator("summary").filter({ hasText: "ACP profile" }).click();
  await expect(page.getByLabel("ACP profile")).toHaveValue(fx.executorId);

  await page.locator("summary").filter({ hasText: "Work mode" }).click();
  await page.getByLabel("Work mode").selectOption("plan_first");
  await page.getByLabel("Reasoning effort").selectOption("extra");

  await page.getByLabel("Workspace name").fill("Unreachable supervisor");
  await page.getByLabel("Branch name").fill(branchName);
  await page
    .getByLabel("What do you want to do?")
    .fill("Try a deterministic scratch launch against an unavailable daemon.");

  await page.locator("summary").filter({ hasText: "Attachments" }).click();
  await page.getByLabel("Files").setInputFiles(uploadPath);

  const beforeRuns = await countRows("runs", "project_id = $1", [fx.projectId]);
  const beforeScratchRuns = await countRows("scratch_runs", "project_id = $1", [
    fx.projectId,
  ]);
  const beforeWorkspaces = await countRows("workspaces", "project_id = $1", [
    fx.projectId,
  ]);
  const launchResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/scratch-runs") &&
      response.request().method() === "POST",
  );

  await page.getByRole("button", { name: "Launch scratch run" }).click();

  expect((await launchResponse).status()).toBe(409);
  await expect(
    page.locator("form").getByText(/scratch run capacity is full/i),
  ).toBeVisible();

  const afterRuns = await countRows("runs", "project_id = $1", [fx.projectId]);
  const afterScratchRuns = await countRows("scratch_runs", "project_id = $1", [
    fx.projectId,
  ]);
  const afterWorkspaces = await countRows("workspaces", "project_id = $1", [
    fx.projectId,
  ]);

  expect(afterRuns).toBe(beforeRuns);
  expect(afterScratchRuns).toBe(beforeScratchRuns);
  expect(afterWorkspaces).toBe(beforeWorkspaces);
});
