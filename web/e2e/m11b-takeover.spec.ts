// M11b (ADR-030): the full MANUAL-TAKEOVER loop, end-to-end through the real
// UI + takeover routes + graph runner — claim → board surface → local commits →
// return → returned diff in the timeline → downstream gates staled then rerun →
// fresh review gate.
//
// PREREQUISITES (wired by the AS-BUILT harness, no manual setup needed):
//   • A running web tier — Playwright's `webServer` block boots `next dev` on
//     E2E_PORT against the DEDICATED e2e Postgres (E2E_DB_URL). `pnpm
//     --filter maister-web test:e2e` (or `cd web && pnpm test:e2e`) launches it.
//   • A migrated + seeded e2e DB — `e2e/global-setup.ts` provisions the
//     disposable `maister_e2e` DB, applies ALL migrations (incl. 0011), and
//     runs `e2e/_seed/seed-e2e.ts`.
//   • A REAL on-disk git worktree for THIS spec — the m11b fixture `git init`s a
//     parent repo with a base commit and `git worktree add`s the run branch at
//     `<repo>/.worktrees/e2e-takeover`, so the return route's
//     resolveBaseRef/logRange/diffRange and this spec's `git commit` operate on
//     real git state. The fixture is per-spec (its OWN project/run/worktree),
//     so it never races the m11a fixture under `fullyParallel`.
//   • NO supervisor — the takeover re-entry path is `checks` (a `check` node +
//     a `command_check` gate, both local `true`) → `review` (a human node that
//     parks). None of those spawn an agent, so the resume completes against the
//     deliberately-unreachable MAISTER_SUPERVISOR_URL.
//
// Steps (a)-(h) and the assertion proving each are annotated inline below.
import type { Page } from "@playwright/test";

import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import { test, expect } from "@playwright/test";

const execFileAsync = promisify(execFile);

type FixtureRecord = {
  runId: string;
  hitlRequestId: string;
  projectSlug: string;
  branch: string;
  worktreePath: string;
};

function loadM11bFixture(): FixtureRecord {
  const all = JSON.parse(
    readFileSync(path.resolve("e2e/.auth/fixtures.json"), "utf8"),
  ) as { byKey: { m11b: FixtureRecord } };

  return all.byKey.m11b;
}

// Poll the run-detail page (server-rendered) until it settles back to the
// pending-review state, refreshing between checks. Web-first: the predicate is
// the page reaching `NeedsInput` with the Take over button re-rendered.
async function reloadUntilPendingReview(
  page: Page,
  runId: string,
): Promise<void> {
  await expect(async () => {
    await page.goto(`/runs/${runId}`);
    await expect(
      page.getByRole("button", { name: "Take over", exact: true }),
    ).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 25_000 });
}

test("manual takeover loop: claim → board → commit → return → diff → stale+rerun → fresh review", async ({
  page,
}) => {
  const fx = loadM11bFixture();

  // (a) The seeded graph run is paused at the `aif` human_review node offering
  // the `takeover` decision. The run-detail page renders the Take over button.
  await page.goto(`/runs/${fx.runId}`);

  const takeOver = page.getByRole("button", { name: "Take over", exact: true });

  await expect(takeOver).toBeVisible();

  // (b) Claim via the UI → the run becomes HumanWorking. Intercept the claim
  // POST to confirm the server accepted it (200), then the page refreshes into
  // the HumanWorking handoff surface (the Return button is owner-gated and only
  // renders for the claimant).
  const claimResponse = page.waitForResponse(
    (r) =>
      r.url().endsWith(`/api/runs/${fx.runId}/takeover/claim`) &&
      r.request().method() === "POST",
  );

  await takeOver.click();
  expect((await claimResponse).status()).toBe(200);

  const returnBtn = page.getByRole("button", { name: "Return", exact: true });

  await expect(returnBtn).toBeVisible();
  // The run status pill now reads HumanWorking (run-detail header).
  await expect(page.getByText("HumanWorking", { exact: true })).toBeVisible();

  // (c) The BOARD card surfaces owner + branch + elapsed + the pending Return
  // action and is visually distinct (humanworking variant). The card is the
  // link to this run; scope all card assertions to it.
  await page.goto(`/projects/${fx.projectSlug}`);

  // Scope to the board section: the HITL inbox also links to this run, so use
  // the `data-board` wrapper to pick the flight card unambiguously. The compact
  // card no longer renders the worktree branch, so locate it by the run link
  // the stretched overlay wraps.
  const card = page
    .locator('[data-board] [data-testid="flight-card"]')
    .filter({ has: page.locator(`a[href="/runs/${fx.runId}"]`) });

  await expect(card).toBeVisible();
  await expect(
    card.locator(`a[href="/runs/${fx.runId}"]`).first(),
  ).toBeVisible();
  await expect(card.getByText("claimed by")).toBeVisible(); // owner label
  await expect(card.getByText("E2E Admin")).toBeVisible(); // owner name
  // The compact card no longer renders the worktree branch anywhere.
  await expect(card.getByText(fx.branch, { exact: true })).toHaveCount(0);
  await expect(card.getByText("Return", { exact: false })).toBeVisible(); // pending Return action
  // Visual distinction: the humanworking card carries the accent-3 stripe
  // (a claimed-takeover surface, not a normal running task).
  await expect(card.locator("span.bg-accent-3").first()).toBeVisible();

  // (d) Simulate the human editing locally: a real `git commit` in the exposed
  // worktree (no remote). This is the diff the Return must capture.
  await execFileAsync("git", [
    "-C",
    fx.worktreePath,
    "config",
    "user.email",
    "human@maister.local",
  ]);
  await execFileAsync("git", [
    "-C",
    fx.worktreePath,
    "config",
    "user.name",
    "Human Reviewer",
  ]);
  const { writeFileSync } = await import("node:fs");

  writeFileSync(
    path.join(fx.worktreePath, "takeover-fix.txt"),
    "manual edit during takeover\n",
  );
  await execFileAsync("git", ["-C", fx.worktreePath, "add", "."]);
  await execFileAsync("git", [
    "-C",
    fx.worktreePath,
    "commit",
    "-m",
    "fix: manual takeover edit",
  ]);

  // (e) Return via the UI. Go back to the run-detail page (the board card is a
  // link, no inline Return), then click Return and confirm the server recorded
  // the return (200, runStatus Running, the commit captured).
  await page.goto(`/runs/${fx.runId}`);

  const returnFromDetail = page.getByRole("button", {
    name: "Return",
    exact: true,
  });

  await expect(returnFromDetail).toBeVisible();

  const returnResponse = page.waitForResponse(
    (r) =>
      r.url().endsWith(`/api/runs/${fx.runId}/takeover/return`) &&
      r.request().method() === "POST",
  );

  await returnFromDetail.click();

  const returned = await returnResponse;

  expect(returned.status()).toBe(200);
  const returnBody = (await returned.json()) as {
    ok?: boolean;
    runStatus?: string;
    returnedCommitCount?: number;
  };

  expect(returnBody.ok).toBe(true);
  expect(returnBody.runStatus).toBe("Running");
  expect(returnBody.returnedCommitCount).toBeGreaterThanOrEqual(1);

  // The async runner resume drives `checks` (local `true`) → fresh review HITL.
  // (h) The run reaches a FRESH review gate: it settles back to NeedsInput with
  // a new human_review HITL, so the Take over button renders again.
  await reloadUntilPendingReview(page, fx.runId);

  // (f) The RETURNED DIFF appears in the run-detail timeline (the handoff block
  // renders the captured `git diff`, including the human's committed file).
  await expect(page.getByText("Returned diff", { exact: true })).toBeVisible();
  await expect(page.getByText("takeover-fix.txt").first()).toBeVisible();

  // (g) Downstream gates are marked STALE then RERUN. At steady state the
  // timeline shows BOTH: the prior `checks`/`lint` gate flipped stale (the
  // "rerun required" badge), and a FRESH passed `lint` gate from the resume.
  await expect(page.getByText("rerun required").first()).toBeVisible(); // staled gate

  const passedGates = page.locator("span.text-accent-4", { hasText: "passed" });

  await expect(passedGates.first()).toBeVisible(); // fresh passed gate verdict

  // (h, continued) The fresh review HITL is the live pending input — the
  // "Waiting on you" review panel is back, confirming a new review gate.
  await expect(page.getByText("Waiting on you", { exact: true })).toBeVisible();
});
