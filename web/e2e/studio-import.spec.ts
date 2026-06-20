import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { test, expect } from "@playwright/test";

// M36 Phase 3 — the batch-import walk: install a package, FORK it to a local
// package (lands in /studio/edit), then Import a small folder via the import
// dialog and confirm the commit succeeds. The confine/cap/zip-slip security
// surface is exhaustively integration-tested (lib/local-packages/__tests__/
// import.integration.test.ts); this e2e covers the UI round-trip the
// integration tests cannot — picker → preview → commit through the real route.
// The install + fork flow mirrors studio-local-edit.spec.ts.
const RUN_TAG = `e2eimport${Date.now().toString(36)}`;

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "e2e",
      GIT_AUTHOR_EMAIL: "e2e@test",
      GIT_COMMITTER_NAME: "e2e",
      GIT_COMMITTER_EMAIL: "e2e@test",
    },
  });
}

function buildPackageRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "maister-e2e-import-"));

  git(repo, "init", "-b", "main");
  const pkgDir = join(repo, "packages", RUN_TAG);

  mkdirSync(join(pkgDir, "flows/e2e-flow"), { recursive: true });
  writeFileSync(
    join(pkgDir, "maister-package.yaml"),
    `schemaVersion: 1\nname: ${RUN_TAG}\nflows:\n  - { id: ${RUN_TAG}-flow, path: flows/e2e-flow }\n`,
  );
  writeFileSync(
    join(pkgDir, "flows/e2e-flow/flow.yaml"),
    `schemaVersion: 1\nname: ${RUN_TAG}-flow\nsteps:\n  - id: s1\n    type: cli\n    command: echo hi\n`,
  );
  git(repo, "add", "-A");
  git(repo, "commit", "-m", "init");
  git(repo, "tag", `${RUN_TAG}/v1.0.0`);

  return repo;
}

// A small on-disk file to feed the (folder) file input. Playwright's
// setInputFiles sets file.name only (webkitRelativePath is empty), so the
// import lands it by basename — sufficient to prove the round-trip commits.
function importableFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "maister-e2e-import-src-"));
  const file = join(dir, "imported-readme.md");

  writeFileSync(file, "# imported by e2e\n");

  return file;
}

test("install → fork → import a folder → commit succeeds", async ({ page }) => {
  test.setTimeout(180_000);
  const repo = buildPackageRepo();

  await page.goto("/studio/sources");
  await page.getByRole("button", { name: "Add package source" }).click();
  const dialog = page.getByRole("dialog");

  await dialog.getByLabel("Git monorepo URL").fill(repo);
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText(repo)).toBeVisible();
  await page
    .locator("tr", { hasText: repo })
    .getByRole("button", { name: "Refresh", exact: true })
    .click();
  await expect(page.getByText(RUN_TAG, { exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await page
    .getByRole("button", { name: `${RUN_TAG}/v1.0.0 · install` })
    .click();
  await expect(
    page.getByRole("button", { name: `${RUN_TAG}/v1.0.0 · installed` }),
  ).toBeVisible({ timeout: 30_000 });

  // Fork-to-local → editor (route changes to /studio/edit/{localPackageId}).
  await page.goto(`/studio/packages/${RUN_TAG}`);
  await page.getByTestId("package-fork").click();
  await page.waitForURL(/\/studio\/edit\//, { timeout: 30_000 });

  // Open the import dialog, pick a file, preview, then commit.
  await page.getByTestId("local-editor-import").click();
  await expect(page.getByTestId("import-folder-input")).toBeVisible();
  await page.getByTestId("import-folder-input").setInputFiles(importableFile());
  await page.getByTestId("import-preview").click();
  await expect(page.getByTestId("import-tree")).toBeVisible({
    timeout: 30_000,
  });
  await page.getByTestId("import-commit").click();
  await expect(page.getByTestId("import-done")).toBeVisible({
    timeout: 30_000,
  });
});
