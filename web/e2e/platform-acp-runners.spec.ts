import { test, expect } from "@playwright/test";

import { loadFixtures } from "./_seed/fixtures";

test("platform ACP runners drive admin settings, task launch, and scratch launch", async ({
  page,
}) => {
  const fixtures = loadFixtures().byKey;
  const board = fixtures.board;
  const scratch = fixtures.scratch;

  await page.goto("/settings");

  const platformDefault = page.getByLabel("Platform default runner");

  await expect(platformDefault).toHaveValue("claude-code");
  await expect(page.getByText("Router sidecars")).toBeVisible();
  await expect(page.getByText("Adapter support")).toBeVisible();
  await expect(page.getByText("claude-agent-acp")).toBeVisible();
  await expect(page.getByText("codex-acp")).toBeVisible();
  await expect(page.getByText("ccr-default").first()).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "codex-zai-glm" }),
  ).toBeVisible();
  await expect(page.getByText("NotReady").first()).toBeVisible();
  await expect(
    platformDefault.locator('option[value="codex-zai-glm"]'),
  ).toHaveAttribute("disabled", "");

  await page.goto(`/projects/${board.projectSlug}`);
  await page
    .locator("[data-board]")
    .getByText("Acceptance backlog launch")
    .locator("xpath=ancestor::article")
    .getByRole("button", { name: "launch" })
    .click();

  const taskRunner = page.getByLabel("Runner");

  await expect(taskRunner).toHaveValue("claude-code");
  await expect(page.getByText("platformDefault")).toBeVisible();
  await expect(page.getByText("Ready").last()).toBeVisible();
  await expect(
    taskRunner.locator('option[value="codex-zai-glm"]'),
  ).toHaveAttribute("disabled", "");

  await taskRunner.selectOption("codex-openai");
  await expect(taskRunner).toHaveValue("codex-openai");
  await page.getByRole("button", { name: "Cancel" }).click();

  await page.goto(`/scratch-runs/new?projectId=${scratch.projectId}`);

  const scratchRunner = page.getByLabel("Runner");

  await expect(scratchRunner).toHaveValue(scratch.runnerId);
  await expect(scratchRunner).toHaveValue("codex-openai");
  await expect(
    scratchRunner.locator('option[value="codex-zai-glm"]'),
  ).toHaveAttribute("disabled", "");
});
