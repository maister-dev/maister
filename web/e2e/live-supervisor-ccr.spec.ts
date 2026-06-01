import { test, expect } from "@playwright/test";

import { loadFixtures } from "./_seed/fixtures";

const requiredEnv = [
  "MAISTER_CCR_CONFIG_PATH",
  "MAISTER_CCR_AUTH_TOKEN",
  "E2E_CCR_EXECUTOR_MODEL",
] as const;

test.skip(
  process.env.E2E_LIVE_SUPERVISOR !== "1",
  "live supervisor lane is opt-in; set E2E_LIVE_SUPERVISOR=1",
);

for (const name of requiredEnv) {
  test.skip(!process.env[name], `live supervisor lane requires ${name}`);
}

test("live CCR scratch run creates a supervisor session and visible dialog state", async ({
  page,
}) => {
  const fx = loadFixtures().byKey.liveCcr;
  const branchName = `${fx.projectSlug}/scratch/live-ccr-${Date.now()}`;

  await page.goto(`/scratch-runs/new?projectId=${fx.projectId}`);
  await expect(
    page.getByRole("heading", { name: "Start a scratch run." }),
  ).toBeVisible();
  await expect(page.getByLabel("Project")).toHaveValue(fx.projectId);
  await expect(page.getByLabel("Agent")).toHaveValue(fx.executorId);

  await page.getByLabel("Workspace name").fill("Live CCR smoke");
  await page.getByLabel("Worktree branch").fill(branchName);
  await page
    .getByLabel("What do you want to do?")
    .fill(
      "Reply with one short sentence confirming the live MAIster CCR smoke test.",
    );

  const launchResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/scratch-runs") &&
      response.request().method() === "POST",
  );

  await page.getByRole("button", { name: "Launch scratch run" }).click();

  const response = await launchResponse;

  expect([201, 202]).toContain(response.status());
  await page.waitForURL(/\/scratch-runs\/[0-9a-f-]+/, { timeout: 120_000 });
  await expect(page.getByText("Live CCR smoke")).toBeVisible({
    timeout: 120_000,
  });
  await expect(
    page.getByText(/Running|Waiting for you|Review|Starting/i),
  ).toBeVisible({ timeout: 120_000 });
  await expect(
    page.getByText(/live MAIster CCR smoke test|Reply with/i),
  ).toBeVisible();
});
