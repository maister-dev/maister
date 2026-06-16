// M35 (T3.5): the scratch run detail on the shared run shell — conversation
// center, composer enablement, the toggleable inspector with change size +
// actions, and the Files/Diff workbench — end-to-end through the real UI + the
// real scratch/diff/file APIs, against the seeded `scratchDetail` fixture
// (e2e/_seed/seed-e2e.ts → seedScratchDetailFixture). ONE scratch run parked at
// dialog_status WaitingForUser with a committed branch diff (README.md), tracked
// files, and a two-message transcript.
import { readFileSync } from "node:fs";
import path from "node:path";

import { test, expect } from "@playwright/test";

type ScratchDetailFixture = {
  projectSlug: string;
  repoPath: string;
  scratchRunId: string;
  branch: string;
};

function loadScratchDetailFixture(): ScratchDetailFixture {
  const all = JSON.parse(
    readFileSync(path.resolve("e2e/.auth/fixtures.json"), "utf8"),
  ) as { byKey: { scratchDetail: ScratchDetailFixture } };

  return all.byKey.scratchDetail;
}

test("scratch detail lands on the conversation with an enabled composer", async ({
  page,
}) => {
  const fx = loadScratchDetailFixture();

  await page.goto(`/scratch-runs/${fx.scratchRunId}`);

  // The conversation is the primary center; the seeded transcript renders.
  const conversation = page.locator('[data-testid="scratch-conversation"]');

  await expect(conversation).toBeVisible();
  await expect(conversation).toContainText("Please tweak the README.");

  // WaitingForUser → the composer is primary and enabled.
  const composer = page.locator('[data-testid="scratch-composer-input"]');

  await expect(composer).toBeVisible();
  await expect(composer).toBeEnabled();
});

test("scratch inspector toggles and surfaces change size + actions", async ({
  page,
}) => {
  const fx = loadScratchDetailFixture();

  await page.goto(`/scratch-runs/${fx.scratchRunId}`);

  await expect(page.locator('[data-testid="run-shell"]')).toBeVisible();
  await expect(
    page.locator('[data-testid="run-shell-inspector"]'),
  ).toBeVisible();
  await expect(page.locator('[data-testid="run-inspector"]')).toBeVisible();

  // The committed branch diff (README.md) gives a non-empty change size in the
  // always-visible header summary.
  await expect(
    page.locator('[data-testid="run-header-change-summary"]'),
  ).toContainText("+");

  // The inspector action group: lifecycle actions + promote (existing routes).
  await expect(
    page.locator('[data-testid="scratch-inspector-actions"]'),
  ).toBeVisible();
  await expect(page.locator('[data-testid="scratch-promote"]')).toBeVisible();

  // The inspector toggles closed and back open.
  await page.getByRole("button", { name: "Close inspector" }).click();
  await expect(page.locator('[data-testid="run-shell-inspector"]')).toHaveCount(
    0,
  );
  await page.getByRole("button", { name: "Open inspector" }).click();
  await expect(
    page.locator('[data-testid="run-shell-inspector"]'),
  ).toBeVisible();
});

test("scratch workbench exposes the shared Diff renderer and a readable file tree", async ({
  page,
}) => {
  const fx = loadScratchDetailFixture();

  await page.goto(`/scratch-runs/${fx.scratchRunId}`);

  // Diff tab → the shared ADR-066 diff renderer (NOT the old raw <pre>).
  await page.getByRole("tab", { name: "Diff" }).click();
  await page.waitForURL(/[?&]wb=diff/);
  await expect(page.locator('[data-testid="run-diff"]')).toBeVisible();
  await expect(page.locator('[data-testid="diff-view"]')).toBeVisible();

  // Files tab → the tracked file tree; a member can open a file into the pane.
  await page.getByRole("tab", { name: "Files" }).click();
  await page.waitForURL(/[?&]wb=files/);
  await expect(page.locator('[data-testid="file-tree"]')).toBeVisible();
  await expect(
    page.locator('[data-testid="file-tree-entry"]', { hasText: "README.md" }),
  ).toBeVisible();

  // Open the tracked Markdown file → the shared file pane renders the rich
  // Markdown view inside the copy-to-clipboard header (M35 T4.2), reusing the
  // same readRepoFiles + repoRelPathSchema path as flow runs.
  await page
    .locator('[data-testid="file-tree-entry"][data-entry-type="file"]', {
      hasText: "README.md",
    })
    .click();
  await page.waitForURL(/[?&]file=README\.md/);
  await expect(page.locator('[data-testid="file-pane-shell"]')).toBeVisible();
  await expect(page.locator('[data-testid="file-copy-button"]')).toBeVisible();
  await expect(
    page.locator('[data-testid="markdown-rich-view"]'),
  ).toBeVisible();
});
