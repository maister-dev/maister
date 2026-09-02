// ADR-165 (AC-38) — the governed recursive agent harness, DEPTH 2, end to end
// in the browser against the REAL HTTP stack.
//
//   rah-root-d2 (flow)                depth 0 — reduces, publishing a result
//     └─ e2e-rah-research (flow) × 2  depth 1 — exports a result and finishes
//         └─ e2e-worker (agent) × 2   depth 2   `Done` WITHOUT a promotion
//
// What this proves that the integration matrix cannot: the public-result plane
// over the real wire. Each grandchild emits a ```json maister:output``` sentinel
// that the real extractor parses, the real validator checks against the profile
// schema resolved from its parent's pinned revision, and the real ledger
// publishes. Each research child then finishes by RESULT-ONLY COMPLETION —
// `Running → Done` with no promotion, no merge commit, no human — and the root
// collects those two exports through the REAL collect route before publishing
// its own reduce result naming the ids it actually consumed.
//
// CI-ONLY: requires a free :3100 (the playwright webServer). It cannot run while
// a `next dev` holds the Next 16 single-dev lock on the same project dir.

import { test, expect } from "@playwright/test";

import { singleValue, withE2EDb } from "./_seed/db";
import { loadFixtures } from "./_seed/fixtures";
import { readLaunchResult } from "./_seed/launch-stream";

const CRON_HEADER = "X-Maister-Cron-Token";
const CRON_TOKEN = process.env.MAISTER_CRON_TOKEN ?? "e2e-cron-token-change-me";

// Two levels of REAL flow children, each provisioning a worktree and running a
// real graph, plus four agent grandchildren — minutes of wall clock past the
// default 30s budget.
test.setTimeout(240_000);

test("recursive harness: depth-2 tree → result-only Done children → the root reduces what it collected", async ({
  page,
  request,
}) => {
  const fx = loadFixtures().byKey.rah;

  const tickDispatcher = async (): Promise<void> => {
    await withE2EDb((pool) =>
      pool.query(
        `UPDATE scheduler_jobs SET next_run_at = now(), lease_expires_at = NULL
          WHERE job_kind = 'domain_event_dispatch'`,
      ),
    );
    await request.post("/api/cron/tick?jobKind=domain_event_dispatch", {
      headers: { [CRON_HEADER]: CRON_TOKEN },
    });
  };

  // Seed the consumer cursors BEFORE ANYTHING RUNS. `orchestrator_resume` is
  // `startFrom: "now"` and never looks back; a flow child is not held, so it
  // settles in well under a second. Seeding after the park would land AFTER the
  // settle events and skip the wake forever — which reads exactly like "the
  // wake is broken". (Same reason as flow-target-delegation.spec.ts.)
  await tickDispatcher();

  // ---- Launch the root coordinator from the board. -------------------------
  await page.goto(`/projects/${fx.projectSlug}`);

  // Retry-safe: "Launch" only while the task has never run; a Playwright retry
  // re-uses the same seeded task, whose card then reads "Run again".
  const launchControl = page
    .locator("[data-board]")
    .getByText("Research the change surface")
    .locator("xpath=ancestor::article")
    .getByRole("button", { name: /^(Launch|Run again)$/ });

  await expect(launchControl).toBeVisible();
  await expect(launchControl).toBeEnabled();

  const launchResponse = page.waitForResponse(
    (response) =>
      response.url().includes("/api/runs") &&
      response.request().method() === "POST",
  );

  await launchControl.click();

  const dialog = page.getByTestId("task-launch-dialog");

  await expect(dialog).toBeVisible();

  const createRun = dialog.getByRole("button", {
    name: "Create run",
    exact: true,
  });

  await expect(createRun).toBeEnabled();
  await createRun.click();

  const response = await launchResponse;

  expect(response.status()).toBe(200);

  const { runId } = await readLaunchResult(response);

  expect(runId).toBeTruthy();

  // ---- The root parks with two RESEARCH FLOW children. --------------------
  await expect
    .poll(
      () =>
        singleValue<string>(`SELECT status AS value FROM runs WHERE id = $1`, [
          runId,
        ]),
      { timeout: 60_000, intervals: [1000] },
    )
    .toBe("WaitingOnChildren");

  expect(
    await singleValue<string>(
      `SELECT count(*)::text AS value
         FROM runs r JOIN flow_revisions fr ON fr.id = r.flow_revision_id
        WHERE r.parent_run_id = $1 AND fr.flow_ref_id = $2`,
      [runId, fx.researchFlowRef],
    ),
  ).toBe("2");

  // ---- Each research child fans out AGENT grandchildren at depth 2. -------
  // The depth bound is what allows this: the root declares max_depth 2 and the
  // research flow declares 2 as well (absolute from the tree root), so the
  // grandchildren are admitted and a fourth level would not be.
  await expect
    .poll(
      () =>
        singleValue<string>(
          `SELECT string_agg(x.line, ' / ' ORDER BY x.line) AS value FROM (
             SELECT c.id || '=' || count(g.id) || ':' ||
                    coalesce(string_agg(DISTINCT g.status, ','), '-') AS line
               FROM runs c LEFT JOIN runs g
                 ON g.parent_run_id = c.id AND g.run_kind = 'agent'
              WHERE c.parent_run_id = $1
              GROUP BY c.id) x`,
          [runId],
        ),
      { timeout: 90_000, intervals: [1000] },
    )
    .toMatch(/^[0-9a-f-]+=2:\S+ \/ [0-9a-f-]+=2:\S+$/);

  // Every grandchild carries the contract its parent's `resultProfile` resolved
  // — server-side, from the research flow's pinned revision. The body named a
  // profile; it never named a schema.
  expect(
    await singleValue<string>(
      `SELECT count(*)::text AS value
         FROM runs g JOIN runs c ON c.id = g.parent_run_id
        WHERE c.parent_run_id = $1
          AND g.result_contract->>'schemaRef' LIKE '%research-result.v1'`,
      [runId],
    ),
  ).toBe("4");

  // ---- Grandchildren publish VALID results through the real ledger. -------
  await expect
    .poll(
      async () => {
        await tickDispatcher();

        return singleValue<string>(
          `SELECT count(*)::text AS value
             FROM run_results rr
             JOIN runs g ON g.id = rr.run_id
             JOIN runs c ON c.id = g.parent_run_id
            WHERE c.parent_run_id = $1 AND rr.validity = 'valid'`,
          [runId],
        );
      },
      { timeout: 90_000, intervals: [1000] },
    )
    .toBe("4");

  // ---- Each research child finishes Done by RESULT-ONLY COMPLETION. -------
  // The whole point of D17: it published a valid export and changed nothing, so
  // it reaches `Done` with no promotion at all — no merge commit, no promoted
  // head, and its workspace never leaves `promotion_state = 'none'`.
  await expect
    .poll(
      async () => {
        await tickDispatcher();

        return singleValue<string>(
          `SELECT count(*)::text AS value
             FROM runs WHERE parent_run_id = $1 AND status = 'Done'`,
          [runId],
        );
      },
      { timeout: 120_000, intervals: [1000] },
    )
    .toBe("2");

  expect(
    await singleValue<string>(
      `SELECT count(*)::text AS value
         FROM runs r JOIN workspaces w ON w.run_id = r.id
        WHERE r.parent_run_id = $1
          AND r.merge_commit_sha IS NULL
          AND r.promoted_head_sha IS NULL
          AND w.promotion_state = 'none'`,
      [runId],
    ),
  ).toBe("2");

  // Each carries its own `valid` export row — the run's public answer.
  expect(
    await singleValue<string>(
      `SELECT count(*)::text AS value
         FROM run_results rr JOIN runs r ON r.id = rr.run_id
        WHERE r.parent_run_id = $1 AND rr.validity = 'valid'`,
      [runId],
    ),
  ).toBe("2");

  // ---- The root wakes, collects, and reduces. -----------------------------
  // Poll for the SETTLE, not merely for "no longer parked": the wake flips the
  // coordinator to `Running` first, and its result is published by the resume
  // turn that follows. Stopping at `Running` would read the result plane before
  // the turn that writes it.
  await expect
    .poll(
      async () => {
        await tickDispatcher();

        return singleValue<string>(
          `SELECT status AS value FROM runs WHERE id = $1`,
          [runId],
        );
      },
      { timeout: 120_000, intervals: [1000] },
    )
    .toMatch(/^(Review|Done|Failed|Crashed)$/);

  // The root reduced successfully — it did not fail on its own result.
  const rootState = await singleValue<string>(
    `SELECT r.status || ' | rows=' || coalesce(
       (SELECT string_agg(rr.validity || ':' || coalesce(rr.invalid_reason, '-'), ',')
          FROM run_results rr WHERE rr.run_id = r.id), 'none')
       AS value FROM runs r WHERE r.id = $1`,
    [runId],
  );

  expect(rootState, "root run state").toMatch(/^(Review|Done)\b/);

  // The root's own reduce result, revision 1, naming the two children it
  // collected. `consumedChildRunIds` came from the REAL collect route's
  // `resultStatus: "valid"` items — not from anything the spec fed it.
  const reduce = await singleValue<string>(
    `SELECT rr.value::text AS value
       FROM run_results rr
      WHERE rr.run_id = $1 AND rr.validity = 'valid'`,
    [runId],
  );

  expect(reduce, `reduce result missing; root ${rootState}`).toBeTruthy();

  const consumed = (JSON.parse(reduce!) as { consumedChildRunIds: string[] })
    .consumedChildRunIds;
  const childIds = (
    await withE2EDb((pool) =>
      pool.query(`SELECT id FROM runs WHERE parent_run_id = $1`, [runId]),
    )
  ).rows.map((r: { id: string }) => r.id);

  expect(consumed.sort()).toEqual([...childIds].sort());

  // Collecting stamped `first_collected_at` exactly once per collected row.
  expect(
    await singleValue<string>(
      `SELECT count(*)::text AS value
         FROM run_results rr JOIN runs r ON r.id = rr.run_id
        WHERE r.parent_run_id = $1 AND rr.first_collected_at IS NOT NULL`,
      [runId],
    ),
  ).toBe("2");

  // ---- The run detail renders the result plane. ---------------------------
  await page.goto(`/runs/${runId}`);

  const panel = page.getByTestId("run-public-result");

  await expect(panel).toBeVisible();
  await expect(panel).toHaveAttribute("data-result-status", "valid");
  await expect(panel.getByTestId("run-public-result-revision")).toContainText(
    "1",
  );

  // Tree cost facts exist only for a ROOT WITH CHILDREN — which this is. The
  // simulated supervisor writes no cost events, so the token totals are 0 and
  // `runCount` (runs WITH recorded cost) is 0 too; what this proves is that the
  // tree object is PRESENT and its wall-clock fact spans the real tree. The
  // exact totals are asserted against seeded rollups in
  // lib/queries/__tests__/run-tree-cost.integration.test.ts.
  const cost = await request.get(`/api/runs/${runId}/cost-summary`);

  expect(cost.status()).toBe(200);

  const tree = (await cost.json()).tree;

  expect(tree, "tree cost facts on the tree root").toBeTruthy();
  expect(tree.wallClockMinutes).toBeGreaterThanOrEqual(0);
  expect(tree).toHaveProperty("totalTokens");
});
