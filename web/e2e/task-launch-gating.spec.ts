import { test, expect } from "@playwright/test";

import { countRows, singleValue } from "./_seed/db";
import { loadFixtures } from "./_seed/fixtures";

test("task creation works, while launch is gated before side effects when supervisor is unavailable", async ({
  page,
}) => {
  const fx = loadFixtures().byKey.board;
  const title = `Acceptance created task ${Date.now()}`;

  await page.goto(`/projects/${fx.projectSlug}`);
  await page.getByRole("button", { name: "New task" }).click();
  await page
    .locator('input[placeholder="Short summary of the task"]')
    .fill(title);
  await page
    .locator('textarea[placeholder="What should the agent do?"]')
    .fill("Create a deterministic e2e backlog task.");

  const createResponse = page.waitForResponse(
    (response) =>
      response.url().includes(`/api/projects/${fx.projectSlug}/tasks`) &&
      response.request().method() === "POST",
  );

  await page.getByRole("button", { name: "Create task" }).click();
  expect((await createResponse).status()).toBe(201);
  await expect(page.getByText(title)).toBeVisible();

  const createdTaskId = await singleValue<string>(
    "SELECT id AS value FROM tasks WHERE project_id = $1 AND title = $2",
    [fx.projectId, title],
  );

  expect(createdTaskId).toBeTruthy();

  const launchControl = page
    .locator("[data-board]")
    .getByText(title)
    .locator("xpath=ancestor::article")
    .getByRole("button", { name: "paused" });

  await expect(launchControl).toBeDisabled();
  await expect(launchControl).toHaveAttribute(
    "title",
    /Supervisor unavailable/,
  );

  const beforeRuns = await countRows("runs", "task_id = $1", [createdTaskId]);
  const beforeWorkspaces = await countRows(
    "workspaces",
    "run_id IN (SELECT id FROM runs WHERE task_id = $1)",
    [createdTaskId],
  );

  const apiResult = await page.evaluate(async (taskId) => {
    const response = await fetch("/api/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ taskId }),
    });

    return {
      status: response.status,
      body: (await response.json()) as { code?: string },
    };
  }, createdTaskId);

  expect(apiResult.status).toBe(503);
  expect(apiResult.body.code).toBe("EXECUTOR_UNAVAILABLE");

  const afterRuns = await countRows("runs", "task_id = $1", [createdTaskId]);
  const afterWorkspaces = await countRows(
    "workspaces",
    "run_id IN (SELECT id FROM runs WHERE task_id = $1)",
    [createdTaskId],
  );
  const taskStatus = await singleValue<string>(
    "SELECT status AS value FROM tasks WHERE id = $1",
    [createdTaskId],
  );

  expect(afterRuns).toBe(beforeRuns);
  expect(afterWorkspaces).toBe(beforeWorkspaces);
  expect(taskStatus).toBe("Backlog");
});
