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
//     not the graph terminal). See the documented test.skip at the bottom.
import { readFileSync } from "node:fs";
import path from "node:path";

import { Pool } from "pg";
import { test, expect } from "@playwright/test";

import { E2E_DB_URL } from "./_seed/db-url";

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
  const pool = new Pool({ connectionString: E2E_DB_URL });

  try {
    return await fn(pool);
  } finally {
    await pool.end();
  }
}

test("evidence graph renders, artifact payload opens, and the board readiness badge tracks stale/merge-blocked", async ({
  page,
}) => {
  const fx = loadM12Fixture();

  // (1) The evidence explorer renders with the seeded node-attempt + artifact
  // nodes. React Flow only mounts nodes inside the fitView viewport, so assert
  // on the container + the impl-diff artifact node (which carries its state).
  await page.goto(`/runs/${fx.runId}`);

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

  // (2) Click the impl-diff artifact node → payload drawer opens → the REAL
  // payload API returns the inline diff text.
  await implDiff.click();

  const payload = page.locator('[data-testid="artifact-payload"]');

  await expect(payload).toBeVisible();
  await expect(payload).toContainText("diff --git");

  // Close the modal (Escape) before navigating on.
  await page.keyboard.press("Escape");

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
    // Reload run detail → impl-diff node now surfaces `stale`.
    await page.goto(`/runs/${fx.runId}`);
    await expect(
      page.locator(
        `[data-testid="evidence-node"][data-artifact-id="${fx.implDiffArtifactId}"]`,
      ),
    ).toHaveAttribute("data-state", "stale");

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
    });
  }

  // The re-produced run (current artifact + passed gate) is ready → no badge at all.
  await page.goto(`/projects/${fx.projectSlug}`);
  await expect(page.locator("[data-readiness]")).toHaveCount(0);
});

// (4) Runner-side approve→done refusal: NOT e2e-drivable under the stub
// supervisor (no on-disk worktree for the m12 fixture; the respond route
// resumes the graph runner in a background microtask with no deterministic UI
// signal). The blocking pre_finish artifact_required gate that refuses approval
// while impl-diff is not current is integration-proven, with a real worktree,
// in web/lib/flows/graph/__tests__/review-refusal.integration.test.ts (T4.4).
test.skip("runner refuses approve→done while impl-diff is stale (integration-proven, not e2e)", () => {
  // Intentionally empty — see the comment above and review-refusal.integration.test.ts.
});
