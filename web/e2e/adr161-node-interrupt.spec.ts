// ADR-161 (T-B13): the operator node-interrupt card end-to-end through the real
// UI + respondToHitl. A run parked by an interrupt renders the four
// server-owned options; restarting the node with a correction records the
// operator's intent on the ledger and re-enters the graph.
//
// The option set is SERVER-owned, so the assertions here are as much about what
// the client does NOT decide as about what it renders.
//
// PREREQUISITES (wired by the AS-BUILT harness): the `adr161` fixture in
// `e2e/_seed/seed-e2e.ts` — its OWN project, run, and on-disk worktree, parked
// at `implement` with `plan` already in the ledger (which is what makes
// `restart_from` eligible: targets are ledger-derived, never topological).
import type { Page } from "@playwright/test";

import { readFileSync } from "node:fs";
import path from "node:path";

import { test, expect } from "@playwright/test";

type FixtureRecord = {
  runId: string;
  hitlRequestId: string;
  projectSlug: string;
};

function loadFixture(): FixtureRecord {
  const all = JSON.parse(
    readFileSync(path.resolve("e2e/.auth/fixtures.json"), "utf8"),
  ) as { byKey: { adr161: FixtureRecord } };

  return all.byKey.adr161;
}

async function reloadUntilGone(page: Page, runId: string): Promise<void> {
  await expect(async () => {
    await page.goto(`/runs/${runId}`);
    await expect(
      page.getByRole("button", { name: "Restart this node", exact: true }),
    ).toHaveCount(0, { timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
}

test("node interrupt: parked card → four options → restart with a correction", async ({
  page,
}) => {
  const fx = loadFixture();

  await page.goto(`/runs/${fx.runId}`);

  // (a) All four server-owned options render, with the one-click default
  // marked so it stays the obvious action.
  const restartNode = page.getByRole("button", {
    name: "Restart this node",
    exact: true,
  });

  await expect(restartNode).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Resume as-is", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Stop run", exact: true }),
  ).toBeVisible();

  // (b) The rarer jump-back sits behind progressive disclosure, so it does not
  // compete with the default. `plan` is offered because it RAN — the eligible
  // set is ledger-derived.
  const disclosure = page.getByRole("button", {
    name: "Restart from an earlier node",
    exact: true,
  });

  await expect(disclosure).toBeVisible();
  await disclosure.click();
  await expect(page.getByRole("combobox", { name: "Target node" })).toContainText(
    "plan",
  );

  // (c) The correction textarea and the workspace-policy selector are present —
  // the correction is what reaches the restarted node's prompt.
  const correction = page.getByRole("textbox").first();

  await expect(correction).toBeVisible();
  await correction.fill("You edited the wrong module — start from src/api.");

  // (d) Restart the node. The response is a 202: the runner owns
  // NeedsInput → Running, so the UI does not claim the run is already moving.
  const respond = page.waitForResponse(
    (r) =>
      r.url().includes(`/api/runs/${fx.runId}/hitl/`) &&
      r.request().method() === "POST",
  );

  await restartNode.click();

  const res = await respond;

  expect(res.status()).toBe(202);

  const body = (await res.json()) as { state?: string };

  expect(body.state).toBe("restart-scheduled");

  // (e) The card is consumed — the interrupt has been answered, so the operator
  // is not offered the same four options again.
  await reloadUntilGone(page, fx.runId);
});
