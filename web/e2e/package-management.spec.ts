import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { test, expect } from "@playwright/test";

import { loadFixtures } from "./_seed/fixtures";

// (ADR-088) End-to-end package management: add a platform source (local git
// monorepo fixture built by THIS spec), refresh discovery, install a tag,
// attach to a project, see member flows, detach. One serial test — the steps
// share state and the e2e DB is shared across worktrees (no parallel reruns
// of intermediate state). Package name is unique per run so a crashed prior
// run can never collide on (project, package_name).
const RUN_TAG = `e2epkg${Date.now().toString(36)}`;

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
  const repo = mkdtempSync(join(tmpdir(), "maister-e2e-pkg-"));

  git(repo, "init", "-b", "main");
  const pkgDir = join(repo, "packages", RUN_TAG);

  mkdirSync(join(pkgDir, "flows/e2e-flow"), { recursive: true });
  writeFileSync(
    join(pkgDir, "maister-package.yaml"),
    `schemaVersion: 1\nname: ${RUN_TAG}\nflows:\n  - { id: ${RUN_TAG}-flow, path: flows/e2e-flow }\n`,
  );
  writeFileSync(
    join(pkgDir, "flows/e2e-flow/flow.yaml"),
    `schemaVersion: 1\nname: ${RUN_TAG}-flow\ncompat:\n  engine_min: 1.1.0\nnodes:\n  - id: s1\n    type: cli\n    action:\n      command: echo hi\n    transitions:\n      success: done\n`,
  );
  git(repo, "add", "-A");
  git(repo, "commit", "-m", "init");
  git(repo, "tag", `${RUN_TAG}/v1.0.0`);

  return repo;
}

test("package source → discovery → install → attach → detach round-trip", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const fixtures = loadFixtures().byKey;
  const projectSlug = fixtures.board.projectSlug;
  const repo = buildPackageRepo();

  // 1. Add the source on /studio/sources (Sources relocated from /settings).
  await page.goto("/studio/sources");
  await expect(
    page.getByRole("heading", { name: "Package sources" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Add package source" }).click();
  const dialog = page.getByRole("dialog");

  // `file://` is REQUIRED, not cosmetic: `validateUrl` (`lib/repo-source.ts`)
  // admits only https/http/ssh/file plus scp-short `git@host:`, so a bare
  // absolute path is refused "repoUrl scheme not allowed" at the dialog. The
  // allow-list landed in `01c75594` (ADR-129 remediation) and these specs,
  // written before it, kept filling the raw temp path.
  await dialog.getByLabel("Git monorepo URL").fill(`file://${repo}`);
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText(repo)).toBeVisible();

  // 2. Refresh discovery → package + tag appear (scope to OUR source row —
  // other settings panels ship their own Refresh buttons).
  await page
    .locator("tr", { hasText: repo })
    .getByRole("button", { name: "Refresh", exact: true })
    .click();
  await expect(page.getByText(RUN_TAG, { exact: true })).toBeVisible({
    timeout: 30_000,
  });

  // 3. Install the discovered tag → installed revisions row.
  await page
    .getByRole("button", { name: `${RUN_TAG}/v1.0.0 · install` })
    .click();
  await expect(
    page.getByRole("button", { name: `${RUN_TAG}/v1.0.0 · installed` }),
  ).toBeVisible({ timeout: 30_000 });
  await expect(
    page.getByRole("heading", { name: "Installed package revisions" }),
  ).toBeVisible();

  // 4. Attach to the seeded project from the packages tab.
  await page.goto(`/projects/${projectSlug}?tab=packages`);
  await expect(
    page.getByRole("heading", { name: "Attached packages" }),
  ).toBeVisible();
  await page
    .getByLabel("Attach")
    .selectOption({ label: `${RUN_TAG}@${RUN_TAG}/v1.0.0` });
  await page.getByRole("button", { name: "Attach", exact: true }).click();
  await expect(
    page.getByRole("link", { name: RUN_TAG, exact: true }),
  ).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(`${RUN_TAG}-flow`).first()).toBeVisible();

  // 5. Detach → attachment gone (empty state or no link).
  // Scoped to THIS package's row. The bare `getByRole("button", …)` assumed
  // the project had exactly one attachment; the seed since gained another
  // (`e2e-mentions-pkg`), so the unscoped locator matched two Detach buttons
  // and died on strict mode. Row-scoping is also what the test means — it
  // detaches the package it attached, not whichever one renders first.
  await page
    .locator("tr", { hasText: RUN_TAG })
    .getByRole("button", { name: "Detach" })
    .click();
  await expect(
    page.getByRole("link", { name: RUN_TAG, exact: true }),
  ).toHaveCount(0, { timeout: 30_000 });
});
