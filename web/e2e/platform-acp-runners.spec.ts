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
  // The compact adapter cards (ADR-094) show a per-adapter setup hint for
  // adapters the stub diagnostics does not report available; the binary moved
  // into a collapsed <details>, so it is no longer asserted here.
  await expect(page.getByText(/Install the .gemini. CLI/i)).toBeVisible();
  await expect(page.getByText("ccr-default").first()).toBeVisible();
  await expect(page.getByRole("cell", { name: "codex-zai-glm" })).toBeVisible();
  // codex-zai-glm is NotReady (openai_compatible) → its default-runner option is
  // disabled. Readiness now renders as a color dot, not a "NotReady" label.
  await expect(
    platformDefault.locator('option[value="codex-zai-glm"]'),
  ).toHaveAttribute("disabled", "");

  await page.goto(`/projects/${board.projectSlug}`);
  await expect(page.getByText("claude-code").first()).toBeVisible();

  const backlogCard = page
    .locator("[data-board]")
    .getByText("Acceptance backlog launch")
    .locator("xpath=ancestor::article");

  await backlogCard
    .getByRole("button", { name: "Advanced launch options" })
    .click();
  await expect(
    backlogCard.getByRole("region", { name: "Advanced launch options" }),
  ).toBeVisible();

  await page.goto(`/scratch-runs/new?projectId=${scratch.projectId}`);

  const scratchRunner = page.getByLabel("Runner");

  // Generous first wait: the composer shows "Loading launch options…" until
  // the async options fetch resolves.
  await expect(scratchRunner).toHaveValue(scratch.runnerId, {
    timeout: 15_000,
  });
  await expect(scratchRunner).toHaveValue("codex-openai");
  await expect(
    scratchRunner.locator('option[value="codex-zai-glm"]'),
  ).toHaveAttribute("disabled", "");
});

test("admin can create, edit, and delete a platform ACP runner via the settings UI", async ({
  page,
}) => {
  const runnerId = "e2e-temp-runner";

  await page.goto("/settings");

  // --- Create: open the modal, fill a valid claude/anthropic_compatible runner.
  await page.getByRole("button", { name: "Add runner" }).click();

  const modal = page.getByRole("dialog");

  await expect(modal).toBeVisible();

  await modal.getByLabel("Runner id").fill(runnerId);
  await modal.getByLabel("Model").fill("glm-5.1");
  // The provider-kind select is labelled "Provider"; switching to the
  // anthropic-compatible kind reveals the Base URL + Auth token fields.
  await modal.getByLabel("Provider").selectOption("anthropic_compatible");
  await modal.getByLabel("Base URL").fill("https://api.z.ai/api/anthropic");
  await modal.getByLabel("Auth token (env:NAME)").fill("env:ZAI_API_KEY");
  await modal.getByRole("button", { name: "Save" }).click();

  await expect(page.getByRole("cell", { name: runnerId })).toBeVisible();

  // --- Edit: reopen the runner, change its model, expect the new model in-row.
  const createdRow = page
    .getByRole("row")
    .filter({ has: page.getByRole("cell", { name: runnerId }) });

  await createdRow.getByRole("button", { name: "Edit" }).click();

  const editModal = page.getByRole("dialog");

  await expect(editModal).toBeVisible();
  await editModal.getByLabel("Model").fill("glm-5.1-edited");
  await editModal.getByRole("button", { name: "Save" }).click();

  await expect(
    page
      .getByRole("row")
      .filter({ has: page.getByRole("cell", { name: runnerId }) })
      .getByRole("cell", { name: "glm-5.1-edited" }),
  ).toBeVisible();

  // --- Delete: it is NOT the platform default → the 204 path removes the row.
  await page
    .getByRole("row")
    .filter({ has: page.getByRole("cell", { name: runnerId }) })
    .getByRole("button", { name: "Edit" })
    .click();

  const deleteModal = page.getByRole("dialog");

  await expect(deleteModal).toBeVisible();
  // First click arms the confirm gate, second click sends the DELETE.
  await deleteModal.getByRole("button", { name: "Delete" }).click();
  await deleteModal.getByRole("button", { name: /Delete this runner/ }).click();

  await expect(page.getByRole("cell", { name: runnerId })).toHaveCount(0);

  // --- Block path: deleting the seeded platform default ("claude-code") is
  // refused with 409 CONFLICT → the modal surfaces the blocked message.
  await page
    .getByRole("row")
    .filter({
      has: page.getByRole("cell", { name: "claude-code", exact: true }),
    })
    .getByRole("button", { name: "Edit" })
    .click();

  const blockModal = page.getByRole("dialog");

  await expect(blockModal).toBeVisible();
  await blockModal.getByRole("button", { name: "Delete" }).click();
  await blockModal.getByRole("button", { name: /Delete this runner/ }).click();

  await expect(blockModal.getByText("Cannot delete runner")).toBeVisible();
  await expect(
    page.getByRole("cell", { name: "claude-code", exact: true }),
  ).toBeVisible();
});
