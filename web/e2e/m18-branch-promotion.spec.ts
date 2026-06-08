// M18 Phase 4 (T4.1): the base→run→target review surface + branch-targeted
// promotion + conflict handoff, end-to-end through the real UI + the shared
// promote route. ONE seeded project (`e2e-m18`) with a REAL parent git repo (a
// `release` target + a base commit) and THREE flow runs parked at
// `status='Review'`, each on its OWN run branch + worktree carrying a committed
// change (e2e/_seed/seed-e2e.ts seedM18Fixture):
//
//   • merge    — run branch off `release` with a non-conflicting commit. The
//     ReviewPanel shows the diff + "Promote to release"; clicking promote
//     (local_merge) runs the real `git merge --no-ff` and the run reaches `Done`.
//   • conflict — run branch + `release` edit the SAME line, so the `--no-ff`
//     merge aborts → the conflict/assignment card surfaces (parent repo path,
//     target, run branch, failing command). The run stays `Review`.
//   • pr       — promotion_mode `pull_request` with a PRE-SEEDED `pr_url`/
//     `pr_number`. PR exec is NOT run in CI — the panel renders the PR link /
//     `PR #N` for display only.
//
// RED until: (a) `getRunDetail` returns `runKind` + branch fields, (b) the
// run-detail page renders `components/runs/review-panel.tsx` for flow `Review`
// runs, and (c) `playwright.config.ts` AUTHED_SPEC matches `m18-.*` (the
// Implementor must add it — see the QA report).
import { readFileSync } from "node:fs";
import path from "node:path";

import { test, expect } from "@playwright/test";

type M18Fixture = {
  projectSlug: string;
  repoPath: string;
  targetBranch: string;
  mergeRunId: string;
  mergeBranch: string;
  conflictRunId: string;
  conflictBranch: string;
  prRunId: string;
  prBranch: string;
  prUrl: string;
  prNumber: number;
};

function loadFixture(): M18Fixture {
  const all = JSON.parse(
    readFileSync(path.resolve("e2e/.auth/fixtures.json"), "utf8"),
  ) as { byKey: { m18: M18Fixture } };

  return all.byKey.m18;
}

test("merge scenario — ReviewPanel shows the diff and promotes (local_merge) to Done", async ({
  page,
}) => {
  const fx = loadFixture();

  await page.goto(`/runs/${fx.mergeRunId}`);

  // The base→run→target review surface renders for the flow Review run: all
  // three branch names appear, and the diff is shown in the ADR-066 diff-view
  // (git-diff-view), not a raw <pre>.
  await expect(page.getByText(fx.mergeBranch, { exact: false }).first()).toBeVisible();
  await expect(page.getByText(fx.targetBranch, { exact: false }).first()).toBeVisible();
  const diffView = page.locator('[data-testid="diff-view"]');

  await expect(diffView).toBeVisible();
  await expect(diffView).toContainText("clean merge change");

  // The promote action NAMES the exact target branch.
  const promote = page.getByRole("button", { name: new RegExp(fx.targetBranch) });

  await expect(promote).toBeVisible();

  // Click promote: the shared route runs the real `git merge --no-ff` against
  // `release` and finalizes the run to `Done`.
  const promoteResponse = page.waitForResponse(
    (r) =>
      r.url().includes(`/api/runs/${fx.mergeRunId}/promote`) &&
      r.request().method() === "POST",
  );

  await promote.click();

  const res = await promoteResponse;

  expect(res.status()).toBe(200);

  // The run reaches `Done` — reload the run-detail page and assert the terminal
  // status badge.
  await page.goto(`/runs/${fx.mergeRunId}`);
  await expect(page.getByText("Done", { exact: true }).first()).toBeVisible();
});

test("conflict scenario — a failed local_merge surfaces the conflict/assignment card", async ({
  page,
}) => {
  const fx = loadFixture();

  await page.goto(`/runs/${fx.conflictRunId}`);

  const promote = page.getByRole("button", { name: new RegExp(fx.targetBranch) });

  await expect(promote).toBeVisible();

  const promoteResponse = page.waitForResponse(
    (r) =>
      r.url().includes(`/api/runs/${fx.conflictRunId}/promote`) &&
      r.request().method() === "POST",
  );

  await promote.click();

  const res = await promoteResponse;

  // The `--no-ff` merge aborts → CONFLICT (409); the run stays `Review`.
  expect(res.status()).toBe(409);

  const body = (await res.json()) as { code?: string };

  expect(body.code).toBe("CONFLICT");

  // The conflict handoff card surfaces the manual-resolution context: the
  // parent repo path, the run branch, and the target branch are named so the
  // operator can resolve by hand.
  await expect(page.getByText(fx.repoPath, { exact: false }).first()).toBeVisible();
  await expect(page.getByText(fx.conflictBranch, { exact: false }).first()).toBeVisible();

  // The run did NOT advance to Done.
  await expect(page.getByText("Done", { exact: true })).toHaveCount(0);
});

test("pr scenario — pull_request promotion mode renders the pre-seeded PR link (display only)", async ({
  page,
}) => {
  const fx = loadFixture();

  await page.goto(`/runs/${fx.prRunId}`);

  // The PR-mode run carries a pre-seeded pr_url/pr_number; the panel renders the
  // PR link / `PR #N`. No promote exec is performed in CI.
  await expect(page.getByText(`#${fx.prNumber}`, { exact: false }).first()).toBeVisible();
  await expect(page.locator(`a[href="${fx.prUrl}"]`)).toBeVisible();
});
