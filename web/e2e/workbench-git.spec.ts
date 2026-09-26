import { execFileSync } from "node:child_process";

import { test, expect, type Page, type Response } from "@playwright/test";

import { readFakeGhState } from "./_seed/fake-gh";
import { loadFixtures } from "./_seed/fixtures";

// ADR-181 T4.1 — the run git panel end to end against the seeded harness: a
// Failed run stays a reachable workbench, and its work goes commit → publish
// (under the public name) → open PR → finalize to Done without leaving the
// panel. The provider boundary is the fake `gh` the config puts on the dev
// server's PATH; every assertion waits on the specific response (no
// `networkidle`, which never settles against `next dev`).

// The run-detail route is among the heaviest to cold-compile under `next dev`.
test.describe.configure({ timeout: 120_000 });

function git(args: string[]): string {
  return execFileSync("git", args, {
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C" },
  }).trim();
}

function responseTo(page: Page, runId: string, path: string) {
  return page.waitForResponse(
    (r: Response) =>
      r.url().endsWith(`/api/runs/${runId}/${path}`) &&
      r.request().method() === "POST",
  );
}

test.describe("run git panel (ADR-181)", () => {
  test("a Failed run: commit, publish under its public name, open a PR, finalize to Done", async ({
    page,
  }) => {
    const fx = loadFixtures().byKey.workbenchGit;

    // (1) D14: a Failed run is a workbench — listed in the portfolio, and its
    // Backlog card keeps the git actions while the worktree is usable.
    await page.goto("/projects");
    await expect(
      page.locator(`a[href="/runs/${fx.runId}"]`).first(),
    ).toBeVisible();
    await page.goto(`/projects/${fx.projectSlug}`);
    await expect(
      page.getByTestId("task-card-latest-run-actions").first(),
    ).toBeVisible();

    // (2) The run's git panel, from the detail host.
    await page.goto(`/runs/${fx.runId}`);
    await expect(page.getByTestId("run-header-status")).toContainText("Failed");
    await page.getByTestId("workbench-git-open").click();
    await expect(page.getByTestId("git-panel")).toBeVisible();

    // (3) Commit the uncommitted change.
    await page.getByTestId("git-panel-action-snapshotCommit").click();
    await page
      .getByTestId("git-panel-commit-message")
      .fill("e2e: commit from the git panel");

    const committed = responseTo(page, fx.runId, "snapshot-commit");

    await page.getByTestId("git-panel-commit-submit").click();
    expect((await committed).status()).toBe(200);

    // (4) Publish under the template's public name, pre-filled by the server.
    await expect(page.getByTestId("git-panel-name")).toHaveValue(
      fx.publicBranch,
    );

    const published = responseTo(page, fx.runId, "export-branch");

    await page.getByTestId("git-panel-action-exportBranch").click();
    expect((await published).status()).toBe(200);
    expect(
      git([
        "--git-dir",
        fx.remotePath,
        "rev-parse",
        `refs/heads/${fx.publicBranch}`,
      ]),
    ).toBe(git(["-C", fx.worktreePath, "rev-parse", "HEAD"]));

    // (5) Open the PR as a draft, from the public name to the target.
    await expect(page.getByTestId("git-panel-pr-title")).toHaveValue(
      `${fx.taskKey}: Fix the widget`,
    );
    await page.getByTestId("git-panel-pr-draft").check();

    const opened = responseTo(page, fx.runId, "pr");

    await page.getByTestId("git-panel-action-openPr").click();
    expect((await opened).status()).toBe(200);
    await expect(page.getByTestId("git-panel-pr-chip")).toContainText("open");
    expect(readFakeGhState().creates).toEqual([
      {
        head: fx.publicBranch,
        base: "main",
        title: `${fx.taskKey}: Fix the widget`,
        draft: true,
      },
    ]);

    // (6) Finalize: outside Review the click is confirmed first (no readiness
    // is asserted), then the run is Done at the head the operator published.
    await page.getByTestId("git-panel-action-finalizePr").click();
    await expect(
      page.getByTestId("git-panel-pr-finalize-dialog"),
    ).toBeVisible();

    const finalized = responseTo(page, fx.runId, "pr/finalize");

    await page.getByTestId("git-panel-pr-finalize-confirm").click();
    expect((await finalized).status()).toBe(200);
    await expect(page.getByTestId("run-header-status")).toContainText("Done", {
      timeout: 30_000,
    });

    // The provider was asked to create exactly one PR — a finalize opens none.
    expect(readFakeGhState().creates).toHaveLength(1);

    // The board follows the run: a Done run whose worktree is still present is
    // in its shipping window, the In Delivery column (lib/board.ts).
    await page.goto(`/projects/${fx.projectSlug}`);
    await expect(
      page.locator('[data-stage="delivery"]').getByText("Fix the widget"),
    ).toBeVisible();
  });
});
