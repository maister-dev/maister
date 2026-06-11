import { expect, test } from "@playwright/test";

// T5.2 — model discovery in the runner modal. The e2e stub-supervisor
// (e2e/_seed/stub-supervisor.ts) answers POST /model-catalog/resolve with a
// fixed catalog (acp_probe→glm-5.1, curated→glm-5); the admin proxy groups it
// by source. Opening the Add-runner modal resolves suggestions and renders
// them grouped with origin badges; a custom (free-text) value is always valid.
test("runner modal surfaces grouped model-discovery suggestions + accepts a custom value", async ({
  page,
}) => {
  await page.goto("/settings");
  await page.getByRole("button", { name: "Add runner" }).click();

  const modal = page.getByRole("dialog");

  await expect(modal).toBeVisible();

  // The model field is a free-text input named "Model".
  await expect(modal.getByRole("textbox", { name: "Model" })).toBeVisible();

  // Discovery resolves on open → grouped suggestions render with origin labels
  // (Chip) and clickable model chips ("<id> · <displayName>"). Generous timeout
  // absorbs the next-dev cold-compile of the proxy route on the first hit.
  await expect(modal.getByText("Agent", { exact: true })).toBeVisible({
    timeout: 15_000,
  });
  await expect(modal.getByText("Curated", { exact: true })).toBeVisible();
  await expect(
    modal.getByRole("button", { name: /glm-5\.1/ }).first(),
  ).toBeVisible();

  // Clicking a suggestion chip fills the model input.
  await modal
    .getByRole("button", { name: /glm-5\.1/ })
    .first()
    .click();
  await expect(modal.getByLabel("Model")).toHaveValue("glm-5.1");

  // Free text is always valid — unknown model is an advisory hint, not an error.
  await modal.getByLabel("Model").fill("my-custom-model");
  await expect(modal.getByLabel("Model")).toHaveValue("my-custom-model");
  await expect(
    modal.getByText("Not in the discovered list", { exact: false }),
  ).toBeVisible();
});
