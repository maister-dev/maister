import { test, expect } from "@playwright/test";

import { countRows } from "./_seed/db";
import { loadFixtures } from "./_seed/fixtures";

test("scratch launch options render, while unavailable supervisor fails without durable side effects", async ({
  page,
}) => {
  const fx = loadFixtures().byKey.scratch;
  const branchName = `${fx.projectSlug}/scratch/unreachable-supervisor-${Date.now()}`;

  await page.goto(`/scratch-runs/new?projectId=${fx.projectId}`);

  await expect(
    page.getByRole("heading", { name: "Start a scratch run." }),
  ).toBeVisible();
  await expect(page.getByLabel("Project")).toHaveValue(fx.projectId);
  await expect(page.getByLabel("Agent")).toHaveValue(fx.executorId);
  await expect(page.getByLabel("Parent branch")).toHaveValue("main");
  await expect(page.getByLabel("Worktree branch")).toHaveValue(/scratch/);

  await page.getByLabel("Workspace name").fill("Unreachable supervisor");
  await page.getByLabel("Worktree branch").fill(branchName);
  await page
    .getByLabel("What do you want to do?")
    .fill("Try a deterministic scratch launch against an unavailable daemon.");

  const beforeRuns = await countRows("runs", "project_id = $1", [fx.projectId]);
  const beforeScratchRuns = await countRows(
    "scratch_runs",
    "project_id = $1",
    [fx.projectId],
  );
  const beforeWorkspaces = await countRows("workspaces", "project_id = $1", [
    fx.projectId,
  ]);
  const launchResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/scratch-runs") &&
      response.request().method() === "POST",
  );

  await page.getByRole("button", { name: "Launch scratch run" }).click();

  expect((await launchResponse).status()).toBe(503);
  await expect(
    page.locator("form").getByText(/supervisor unavailable/i),
  ).toBeVisible();

  const afterRuns = await countRows("runs", "project_id = $1", [fx.projectId]);
  const afterScratchRuns = await countRows(
    "scratch_runs",
    "project_id = $1",
    [fx.projectId],
  );
  const afterWorkspaces = await countRows("workspaces", "project_id = $1", [
    fx.projectId,
  ]);

  expect(afterRuns).toBe(beforeRuns);
  expect(afterScratchRuns).toBe(beforeScratchRuns);
  expect(afterWorkspaces).toBe(beforeWorkspaces);
});
