// T8.2 (e2e): the M12 typed-artifact evidence surface, end-to-end through the
// real UI + the real artifact-payload API, against the seeded `m12` fixture
// (e2e/_seed/seed-e2e.ts → seedM12EvidenceFixture). A run parked at the aif
// `review` node with a full evidence trail (plan/implement/checks/judge
// node-attempts + plan-summary/impl-diff/lint-report/judge-verdict artifacts +
// a PASSED blocking artifact_required gate).
//
// Asserted, deterministic, supervisor-independent outcomes:
//   1. /runs/<id> renders the evidence explorer with node-attempt + artifact
//      nodes; impl-diff shows state `current`.
//   2. clicking the impl-diff artifact node opens the payload drawer and the
//      REAL payload API returns the inline diff text.
//   3. flipping impl-diff → stale + the gate → failed in-DB surfaces `stale` on
//      the node and the unified readiness badge (T15: "Failed" — the failed
//      blocking gate dominates) on the board card; re-producing (current /
//      passed) clears the badge.
//
// (4) The runner-side approve→done REFUSAL (blocking pre_finish gate prevents
//     Done while impl-diff is not current) is NOT e2e-drivable here: the m12
//     fixture has no on-disk worktree and the respond route resumes the graph
//     runner in a background microtask, so there is no deterministic UI signal.
//     That mechanism is integration-proven in
//     web/lib/flows/graph/__tests__/review-refusal.integration.test.ts (T4.4,
//     real worktree: gate fails → review refused → run Failed (≠ Done); artifact
//     current → approve → run reaches Review — Done is the M18 promotion path,
//     not the graph terminal).
import { readFileSync } from "node:fs";
import path from "node:path";

import { Pool } from "pg";
import { test, expect } from "@playwright/test";

import { createE2EDbPool } from "./_seed/db";

import { resolvePostgresDbUrl } from "@/lib/db/postgres-url";

type M12Fixture = {
  runId: string;
  hitlRequestId: string;
  projectSlug: string;
  branch: string;
  worktreePath: string;
  implDiffArtifactId: string;
  gateResultId: string;
};

function loadM12Fixture(): M12Fixture {
  const all = JSON.parse(
    readFileSync(path.resolve("e2e/.auth/fixtures.json"), "utf8"),
  ) as { byKey: { m12: M12Fixture } };

  return all.byKey.m12;
}

// A short-lived pool to flip evidence state in-DB (simulating rework → stale,
// then re-produce). The route reads the live row, so a plain UPDATE is enough.
async function withDb<T>(fn: (pool: Pool) => Promise<T>): Promise<T> {
  const pool = createE2EDbPool(resolvePostgresDbUrl());

  try {
    return await fn(pool);
  } finally {
    await pool.end();
  }
}

test("UX-03C/D evidence filters fit artifacts and the board readiness badge tracks stale/merge-blocked", async ({
  page,
}) => {
  const fx = loadM12Fixture();

  // (1) The evidence explorer renders with the seeded node-attempt + artifact
  // nodes. React Flow only mounts nodes inside the fitView viewport, so assert
  // on the container + the impl-diff artifact node (which carries its state).
  //
  // `?wb=evidence` is REQUIRED, not decoration: the workbench renders every
  // regular pane and hides the inactive ones (`hidden={activeRegular !==
  // "evidence"}`), and the default regular tab is the FIRST of
  // `WORKBENCH_TABS` — `timeline`. A bare `/runs/:id` therefore resolves the
  // evidence container and finds it hidden, which is what this spec had been
  // failing on. Clicking the tab is what a reader does; this is the URL that
  // tab links to.
  await page.goto(`/runs/${fx.runId}`);
  await page.getByRole("tab", { name: "Evidence", exact: true }).click();

  await expect(page.locator('[data-testid="evidence-graph"]')).toBeVisible();

  const implDiff = page.locator(
    `[data-testid="evidence-node"][data-artifact-id="${fx.implDiffArtifactId}"]`,
  );

  await expect(implDiff).toBeVisible();
  await expect(implDiff).toHaveAttribute("data-kind", "artifact");
  await expect(implDiff).toHaveAttribute("data-state", "current");

  // Node-attempt nodes for the four upstream nodes also render.
  for (const nodeId of ["plan", "implement", "checks", "judge"]) {
    await expect(
      page.locator(`[data-testid="evidence-node"][data-kind="node-attempt"]`, {
        hasText: nodeId,
      }),
    ).toBeVisible();
  }

  // Change both native selects before a navigation can commit.
  await page.evaluate(() => {
    for (const value of ["artifact", "current"]) {
      const select = document.querySelector<HTMLSelectElement>(
        `select:has(option[value="${value}"])`,
      );

      if (!select) throw new Error(`Evidence filter for ${value} is missing`);

      select.value = value;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    }
  });
  await expect(page).toHaveURL(/kind=artifact.*state=current/);
  const canvas = page.getByTestId("evidence-graph").locator(".react-flow");

  const fullyVisible = (): Promise<number> =>
    canvas.evaluate((el) => {
      const bounds = el.getBoundingClientRect();

      return [...el.querySelectorAll(".react-flow__node")].filter((node) => {
        const rect = node.getBoundingClientRect();

        return (
          rect.width > 0 &&
          rect.left >= bounds.left &&
          rect.right <= bounds.right &&
          rect.top >= bounds.top &&
          rect.bottom <= bounds.bottom
        );
      }).length;
    });

  await expect.poll(fullyVisible).toBe(7);

  // (2) Click the impl-diff artifact node → payload drawer opens → the REAL
  // payload API returns the inline diff text.
  await implDiff.click();

  const payload = page.locator('[data-testid="artifact-payload"]');

  await expect(payload).toBeVisible();
  await expect(payload).toContainText("diff --git");

  // Close the modal (Escape) before navigating on.
  await page.keyboard.press("Escape");
  const viewport = canvas.locator(".react-flow__viewport");
  const beforeZoom = await viewport.getAttribute("style");

  await canvas.getByRole("button", { name: "Zoom in" }).click();
  await expect(viewport).not.toHaveAttribute("style", beforeZoom!);
  const manualCamera = await viewport.getAttribute("style");

  await page.getByRole("button", { name: "Switch to dark mode" }).click();
  await expect(canvas).toHaveClass(/dark/);
  await expect(viewport).toHaveAttribute("style", manualCamera!);
  const evidencePane = page.getByTestId("evidence-pane");
  const state = evidencePane.getByRole("combobox", {
    name: "State",
    exact: true,
  });

  // (3a) Simulate rework → stale: impl-diff validity=stale + gate status=failed.
  await withDb(async (pool) => {
    await pool.query(
      `UPDATE artifact_instances SET validity = 'stale' WHERE id = $1`,
      [fx.implDiffArtifactId],
    );
    await pool.query(
      `UPDATE gate_results SET status = 'failed' WHERE id = $1`,
      [fx.gateResultId],
    );
  });

  try {
    // The first stream-ready refresh belongs to this same filtered route.
    const runPath = `/runs/${fx.runId}`;
    const staleUrl = `${runPath}?wb=evidence&kind=artifact&state=stale`;
    const connectedRefresh = page.waitForResponse((response) => {
      const url = new URL(response.url());

      return (
        url.pathname === runPath && response.request().headers().rsc === "1"
      );
    });

    await page.goto(staleUrl);
    await connectedRefresh;
    await expect(implDiff).toHaveAttribute("data-state", "stale");
    await expect.poll(fullyVisible).toBe(1);

    const fitted = await viewport.getAttribute("style");

    await canvas.getByRole("button", { name: "Zoom out" }).click();
    await expect(viewport).not.toHaveAttribute("style", fitted!);
    const staleCamera = await viewport.getAttribute("style");
    const liveUpdate = async (
      validity: "current" | "stale",
      status: "Running" | "NeedsInput",
    ): Promise<void> => {
      await withDb(async (pool) => {
        await pool.query(
          "UPDATE artifact_instances SET validity = $1 WHERE id = $2",
          [validity, fx.implDiffArtifactId],
        );
        await pool.query("UPDATE runs SET status = $1 WHERE id = $2", [
          status,
          fx.runId,
        ]);
      });
    };

    // Keep the same mounted URL while live data removes and restores its
    // only matching artifact.
    await liveUpdate("current", "Running");
    await expect(page.getByTestId("run-header-status").visible()).toContainText(
      "Running",
    );
    await expect(page.getByTestId("evidence-empty")).toBeVisible();
    await expect(page).toHaveURL(staleUrl);
    await expect.soft(state).toHaveValue("stale");

    await liveUpdate("stale", "NeedsInput");
    await expect(implDiff).toBeVisible();
    await expect.soft(viewport).toHaveAttribute("style", staleCamera!);
    const clear = evidencePane.getByRole("button", { name: "Clear filters" });

    await expect(clear).toBeVisible();
    await clear.click();
    await expect(page).toHaveURL(`${runPath}?wb=evidence`);
    await page.goBack();
    await expect(page).toHaveURL(staleUrl);
    await expect(state).toHaveValue("stale");

    // The board card now shows the unified readiness badge. T15: a failed
    // blocking gate dominates the rollup, so the badge reads "Failed".
    await page.goto(`/projects/${fx.projectSlug}`);
    await expect(
      page.getByLabel("Failed", { exact: true }).first(),
    ).toBeVisible();
  } finally {
    // (3b) Re-produce: impl-diff current + gate passed. In `finally` so a failure
    // in the stale assertions still restores the shared `m12` fixture to a clean
    // state for the rest of the suite invocation.
    await withDb(async (pool) => {
      await pool.query(
        `UPDATE artifact_instances SET validity = 'current' WHERE id = $1`,
        [fx.implDiffArtifactId],
      );
      await pool.query(
        `UPDATE gate_results SET status = 'passed' WHERE id = $1`,
        [fx.gateResultId],
      );
      await pool.query("UPDATE runs SET status = 'NeedsInput' WHERE id = $1", [
        fx.runId,
      ]);
    });
  }

  // The re-produced run (current artifact + passed gate) is ready → no badge at all.
  await page.goto(`/projects/${fx.projectSlug}`);
  await expect(page.locator("[data-readiness]")).toHaveCount(0);
});
