// ADR-151 agent mentions — the UI contract only: the composer popover offers
// summonable agents, selecting one inserts the canonical id, the stored body
// renders a non-navigating chip, and a resolved-but-not-summonable mention
// draws its footnote. Launch behavior (the decision table) is owned by
// lib/agents/__tests__/triggers.integration.test.ts — no overlap here.
//
// Fixture: the e2e-acceptance-board project with `e2e-mentions-pkg:summoner` (mention
// binding) and `e2e-mentions-pkg:bystander` (attached, no binding) — seed-e2e.ts.

import { expect, test } from "@playwright/test";

const SLUG = "e2e-acceptance-board";

test("composer autocompletes a summonable agent and renders it as a chip", async ({
  page,
}) => {
  await page.goto(`/projects/${SLUG}/tasks/1`);

  const composer = page.locator("#task-comment-body");

  await composer.fill("");
  await composer.pressSequentially("@summ");

  // Only summonable agents are offered — the bystander must never appear.
  const listbox = page.getByRole("listbox");

  await expect(listbox).toBeVisible();
  await expect(listbox.getByText("e2e-mentions-pkg:summoner")).toBeVisible();
  await expect(listbox.getByText("e2e-mentions-pkg:bystander")).toHaveCount(0);

  // Enter selects the active option and inserts the CANONICAL id.
  await composer.press("Enter");
  await expect(composer).toHaveValue("@e2e-mentions-pkg:summoner ");
  await expect(page.getByRole("listbox")).toHaveCount(0);

  await composer.pressSequentially("please take a look at MARKER-CHIP");
  await page
    .getByRole("button", { name: /^(Comment|Комментировать)$/ })
    .click();

  // The stored body renders a chip — deliberately NOT a link (there is no
  // /agents/<id> route and /agents is admin-only). Located by its own marker:
  // the suite runs 3 workers against this one task, so `.last()` would race.
  const comment = page
    .locator('[data-timeline-kind="comment"]')
    .filter({ hasText: "MARKER-CHIP" });

  await expect(comment).toContainText("@e2e-mentions-pkg:summoner");
  await expect(
    comment.locator('a[href="/agents/e2e-mentions-pkg:summoner"]'),
  ).toHaveCount(0);
  await expect(
    comment.locator('[title="e2e-mentions-pkg:summoner"]'),
  ).toBeVisible();
});

test("a resolved but non-summonable mention renders a chip plus its footnote", async ({
  page,
}) => {
  await page.goto(`/projects/${SLUG}/tasks/1`);

  const composer = page.locator("#task-comment-body");

  // Hand-typed: the bystander is attached, so the handle RESOLVES, but it has
  // no mention binding, so nothing will launch.
  await composer.fill("@e2e-mentions-pkg:bystander fyi MARKER-FOOTNOTE");
  await page
    .getByRole("button", { name: /^(Comment|Комментировать)$/ })
    .click();

  const comment = page
    .locator('[data-timeline-kind="comment"]')
    .filter({ hasText: "MARKER-FOOTNOTE" });

  await expect(
    comment.locator('[title="e2e-mentions-pkg:bystander"]'),
  ).toBeVisible();
  await expect(comment).toContainText(/will not run|не будет вызван/);
});

test("an unknown handle stays literal text with no chip", async ({ page }) => {
  await page.goto(`/projects/${SLUG}/tasks/1`);

  const composer = page.locator("#task-comment-body");

  await composer.fill(
    "@e2e-mentions-pkg:nobody and `@e2e-mentions-pkg:summoner` in code MARKER-LITERAL",
  );
  await page
    .getByRole("button", { name: /^(Comment|Комментировать)$/ })
    .click();

  const comment = page
    .locator('[data-timeline-kind="comment"]')
    .filter({ hasText: "MARKER-LITERAL" });

  await expect(comment).toContainText("@e2e-mentions-pkg:nobody");
  // The inline-code occurrence is inert — no chip for it either.
  await expect(
    comment.locator('[title="e2e-mentions-pkg:summoner"]'),
  ).toHaveCount(0);
});
