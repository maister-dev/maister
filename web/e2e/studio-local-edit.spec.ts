import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { test, expect } from "@playwright/test";

// M36 Phase 2 — the editable-local-package walk: install a package, FORK it to a
// local package from the viewer, and land in the /studio/edit editor. The fork
// API + cut-version + the working-dir save/lock are exhaustively integration-
// tested (lib/local-packages/__tests__/{fork-cut,working-dir-files,service}.
// integration.test.ts); this e2e covers the UI navigation the integration tests
// cannot — viewer → Fork-to-local → editor route. The install flow mirrors
// package-management.spec.ts.
const RUN_TAG = `e2elocal${Date.now().toString(36)}`;

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
  const repo = mkdtempSync(join(tmpdir(), "maister-e2e-local-"));

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

test("fork an installed package to local → land in the /studio/edit editor", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const repo = buildPackageRepo();

  // Install the package (source → discovery → install), mirroring package-management.
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

  // Fork-to-local from the package viewer → clone into a local package + open
  // the editor (the route changes to /studio/edit/{localPackageId}).
  await page.goto(`/studio/packages/${RUN_TAG}`);
  await page.getByTestId("package-fork").click();
  await page.waitForURL(/\/studio\/edit\//, { timeout: 30_000 });
  expect(page.url()).toMatch(/\/studio\/edit\//);

  // M39 (ADR-105): the no-path editor lands on the package HOME (overview +
  // manifest form), NOT an empty flow canvas — so there is no spurious
  // "YAML is invalid" sync banner. End-edit releases the lock and returns to the
  // local list.
  const editId = page.url().match(/\/studio\/edit\/([^/?#]+)/)?.[1];

  expect(editId).toBeTruthy();
  await page.goto(`/studio/edit/${editId}`);
  await expect(page.getByTestId("package-home")).toBeVisible();
  await expect(page.getByTestId("package-manifest-form")).toBeVisible();
  await expect(page.getByTestId("flow-yaml-sync-error")).toHaveCount(0);
  await page.getByTestId("local-editor-end-edit").click();
  await page.waitForURL(/\/studio\/local$/, { timeout: 15_000 });
});
