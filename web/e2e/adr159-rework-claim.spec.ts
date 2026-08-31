// ADR-159 (T-A19): the full REWORK-CLAIM loop end-to-end through the real UI +
// rework-claim routes + graph runner — a finished `Review` run is taken back for
// rework, the human commits locally, the run is returned into the graph at the
// server-resolved re-entry node, the staled gate reruns, and the run comes back
// to a fresh review.
//
// This is the ADR-159 counterpart to `m11b-takeover.spec.ts`, and the contrast
// is the point: M11b enters from `NeedsInput` at a parked human_review node,
// this enters from `Review` after the graph has already FINISHED. There is no
// open HITL and `current_step_id` is NULL, so both the claim anchor and the
// re-entry node are derived from the ledger rather than from a cursor.
//
// PREREQUISITES (wired by the AS-BUILT harness, no manual setup):
//   • The `adr159` fixture in `e2e/_seed/seed-e2e.ts` — its OWN project, flow,
//     task, run, and real on-disk git worktree, so it never races m11a/m11b
//     under `fullyParallel`.
//   • NO supervisor — the re-entry node is `checks` (a `check` node + a
//     `command_check` gate, both local `true`) followed by the `review` human
//     node, so the resume completes without spawning an agent.
import type { Page } from "@playwright/test";

import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import { test, expect } from "@playwright/test";

const execFileAsync = promisify(execFile);

type FixtureRecord = {
  runId: string;
  projectSlug: string;
  branch: string;
  worktreePath: string;
};

function loadFixture(): FixtureRecord {
  const all = JSON.parse(
    readFileSync(path.resolve("e2e/.auth/fixtures.json"), "utf8"),
  ) as { byKey: { adr159: FixtureRecord } };

  return all.byKey.adr159;
}

// Web-first: poll the server-rendered run-detail page until the run has come
// back through the graph and is offering the claim again.
async function reloadUntilClaimable(page: Page, runId: string): Promise<void> {
  await expect(async () => {
    await page.goto(`/runs/${runId}`);
    await expect(
      page.getByRole("button", { name: "Take for rework", exact: true }),
    ).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 25_000 });
}

test("rework claim loop: Review → claim → commit → return → staled gate reruns → fresh review", async ({
  page,
}) => {
  const fx = loadFixture();

  // (a) A FINISHED run in Review offers the claim. Availability is server-owned
  // — the button is rendered from the `continuation` block, not re-derived.
  await page.goto(`/runs/${fx.runId}`);

  const takeForRework = page.getByRole("button", {
    name: "Take for rework",
    exact: true,
  });

  await expect(takeForRework).toBeVisible();
  // The server resolved the re-entry node and says where the run will come back
  // in, before the operator commits to anything.
  await expect(page.getByText("checks", { exact: false })).toBeVisible();

  // (b) Claim → Review transitions to HumanWorking and the run ACQUIRES a slot.
  const claimResponse = page.waitForResponse(
    (r) =>
      r.url().endsWith(`/api/runs/${fx.runId}/rework-claim/claim`) &&
      r.request().method() === "POST",
  );

  await takeForRework.click();
  expect((await claimResponse).status()).toBe(200);

  const returnBtn = page.getByRole("button", {
    name: "Return to flow",
    exact: true,
  });

  await expect(returnBtn).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Release", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("HumanWorking", { exact: true })).toBeVisible();

  // (c) The human edits locally and commits — this is the work the return must
  // capture and the flow's own gates must re-validate.
  await execFileAsync("git", [
    "-C",
    fx.worktreePath,
    "config",
    "user.email",
    "e2e@maister.local",
  ]);
  await execFileAsync("git", [
    "-C",
    fx.worktreePath,
    "config",
    "user.name",
    "MAIster E2E",
  ]);
  await execFileAsync("bash", [
    "-c",
    `printf 'operator fix\\n' > ${JSON.stringify(`${fx.worktreePath}/FIX.md`)}`,
  ]);
  await execFileAsync("git", ["-C", fx.worktreePath, "add", "."]);
  await execFileAsync("git", [
    "-C",
    fx.worktreePath,
    "commit",
    "-m",
    "operator fix during rework claim",
  ]);

  // (d) Return → the run re-enters the graph at the server-resolved node. The
  // ingest is a no-op success here (no remote configured), which is exactly the
  // purely-local loop the FF-only design must still support.
  const returnResponse = page.waitForResponse(
    (r) =>
      r.url().endsWith(`/api/runs/${fx.runId}/rework-claim/return`) &&
      r.request().method() === "POST",
  );

  await returnBtn.click();

  const returned = await returnResponse;

  expect(returned.status()).toBe(200);

  const body = (await returned.json()) as {
    runStatus: string;
    returnedCommitCount: number;
    fastForwarded: boolean;
  };

  expect(body.runStatus).toBe("Running");
  expect(body.returnedCommitCount).toBeGreaterThanOrEqual(1);
  expect(body.fastForwarded).toBe(false);

  // (e) The staled `lint` gate reruns and the run settles back into a fresh
  // review — the whole point of returning it to the graph rather than promoting
  // it by hand.
  await reloadUntilClaimable(page, fx.runId);

  // Back in Review and claimable again: the loop is repeatable, and the run was
  // never taken out of its own graph to get there.
  await expect(
    page.getByRole("button", { name: "Take for rework", exact: true }),
  ).toBeVisible();
});
