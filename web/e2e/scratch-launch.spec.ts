import { writeFileSync } from "node:fs";

import { test, expect } from "@playwright/test";

import { countRows } from "./_seed/db";
import { loadFixtures } from "./_seed/fixtures";

test("scratch launch controls render, while capacity guard fails without durable side effects", async ({
  page,
}, testInfo) => {
  const fixtures = loadFixtures().byKey;
  const fx = fixtures.scratch;
  const branchName = `${fx.projectSlug}/scratch/unreachable-supervisor-${Date.now()}`;
  const uploadPath = testInfo.outputPath("scratch-upload.txt");

  writeFileSync(uploadPath, "hello from playwright");

  await page.goto("/");
  await page
    .getByRole("button", {
      name: "Start scratch workspace in E2E Acceptance Board",
    })
    .click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(
    page.getByRole("heading", {
      name: "Start scratch workspace in E2E Acceptance Board",
    }),
  ).toBeVisible();

  await page.goto(`/scratch-runs/new?projectId=${fx.projectId}`);

  await expect(
    page.getByRole("heading", { name: "Start a scratch run." }),
  ).toBeVisible();

  // Scope to the composer: the left rail's per-project "Start scratch
  // workspace in …" buttons substring-match getByLabel("Project"). The first
  // assertion also rides out the async "Loading launch options…" phase.
  const form = page.locator("main");

  await expect(form.getByLabel("Project")).toHaveValue(fx.projectId, {
    timeout: 15_000,
  });
  await expect(form.getByLabel("Base branch")).toHaveValue("main");
  await expect(form.getByLabel("Branch name")).toHaveValue("");

  await expect(form.getByLabel("Runner")).toHaveValue(fx.runnerId);

  await form.getByLabel("Work mode").selectOption("plan_first");
  await form.getByLabel("Reasoning effort").selectOption("extra");

  await form.getByLabel("Workspace name").fill("Unreachable supervisor");
  await form.getByLabel("Branch name").fill(branchName);
  await form
    .getByLabel("What do you want to do?")
    .fill("Try a deterministic scratch launch against an unavailable daemon.");

  await form.getByLabel("Files").setInputFiles(uploadPath);

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

// WI-5: the global Cmd/Ctrl+K shortcut opens the primary launch dialog.
test("Cmd/Ctrl+K opens the primary launch dialog", async ({ page }) => {
  const mod = process.platform === "darwin" ? "Meta" : "Control";

  await page.goto("/");

  // Open + close via the button first: a successful click proves the primary
  // launcher is hydrated, so its global keydown listener is attached before we
  // exercise the shortcut (otherwise the key press can race hydration).
  const launchButton = page.getByRole("button", { name: "Launch run" });

  await launchButton.click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);

  await page.keyboard.press(`${mod}+KeyK`);
  await expect(page.getByRole("dialog")).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
});
