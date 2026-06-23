import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { test, expect } from "@playwright/test";

// M36 Phase 4 — the git-backed diff + Commit/Discard walk: install a package,
// fork it to a local package, open the editor, make a working-tree edit (via the
// YAML drawer + Save), then drive the [Diff] drawer — assert the `⎇ N changed`
// count, Commit it back to 0. The git diff/commit/discard substrate is
// exhaustively integration-tested (lib/local-packages/__tests__/
// diff-commit-discard.integration.test.ts); this e2e covers the UI wiring the
// integration tests cannot. Install flow mirrors studio-local-edit.spec.ts.
const RUN_TAG = `e2ediff${Date.now().toString(36)}`;

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
  const repo = mkdtempSync(join(tmpdir(), "maister-e2e-diff-"));

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

test("edit a local package → diff shows the change → commit clears it", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const repo = buildPackageRepo();

  // Install the package (source → discovery → install).
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

  // Fork-to-local → land in the editor.
  await page.goto(`/studio/packages/${RUN_TAG}`);
  await page.getByTestId("package-fork").click();
  await page.waitForURL(/\/studio\/edit\//, { timeout: 30_000 });
  const pkgId = new URL(page.url()).pathname.split("/")[3];

  // A1 (ADR-105): the editor lands on the package-home overview, not a flow
  // canvas. Open the flow editor directly (full navigation) and wait for the
  // working-dir edit-lock to be (re-)acquired before editing — the editor renders
  // optimistically editable, so a save fired before that acquire round-trip lands
  // would 409 (a real user's edit delay hides this; the test is faster).
  const lockReacquired = page.waitForResponse(
    (r) =>
      new URL(r.url()).pathname.endsWith("/lock-refresh") &&
      r.request().method() === "POST" &&
      r.ok(),
  );

  await page.goto(`/studio/edit/${pkgId}/flows/e2e-flow/flow.yaml`);
  await lockReacquired;

  // Open the Diff drawer — a freshly-forked package is clean (0 changed).
  await page.getByTestId("flow-tab-diff").click();
  await expect(page.getByTestId("lp-diff-changed")).toContainText("0", {
    timeout: 15_000,
  });

  // Make a working-tree edit through the YAML drawer, then Save (a working-dir
  // PUT under the edit-lock). Saving bumps the diff drawer's refresh signal.
  await page.getByTestId("flow-tab-yaml").click();
  // The flow YAML editor is a CodeMirror surface (`.cm-content`), not a
  // <textarea> — drive it via the keyboard (mirrors replaceYamlEditor in
  // flow-studio-artifacts.spec.ts). Append a comment to dirty the working tree.
  const yaml = page
    .getByTestId("flow-yaml-editor")
    .locator(".cm-content")
    .first();

  await yaml.click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.insertText("\n# e2e edit\n");
  await page.getByTestId("topbar-save").click();
  await expect(page.getByTestId("local-editor-saved")).toBeVisible({
    timeout: 30_000,
  });

  // Back to the Diff drawer — the working-tree edit now shows (1+ changed).
  await page.getByTestId("flow-tab-diff").click();
  await expect(page.getByTestId("lp-diff-changed")).not.toContainText("0", {
    timeout: 15_000,
  });

  // Commit → the changed-count resets to 0.
  await page.getByTestId("lp-diff-commit").click();
  await expect(page.getByTestId("lp-diff-changed")).toContainText("0", {
    timeout: 30_000,
  });
});
