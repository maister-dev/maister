// ADR-163 — an orchestrator delegates to a FLOW, end-to-end in the browser
// against the REAL HTTP stack. Sibling of orchestrator-loop.spec.ts, which
// covers the AGENT arm; this one covers the arm that did not exist.
//
// The board Launch creates the orchestrator FLOW run. The test supervisor
// (e2e/_seed/test-supervisor.ts, wired in global-setup) simulates the
// coordinator's session and spawns children through the REAL ext
// /api/v1/ext/runs/delegate route — and because THIS project carries the
// in-repo `e2e-delegated-flow`, the supervisor sends `target.flowId` rather
// than `target.agentId`. Each child is therefore a governed FLOW run: its own
// worktree, its own two-node graph, its own `Review`.
//
// What this proves that the integration suites cannot: the whole chain over
// real HTTP + the real supervisor wire — carrier task, canonical launcher,
// worktree, graph execution to `Review`, the `run.review` DOMAIN emit, and the
// parked coordinator waking through the domain-event dispatcher.
//
// CI-ONLY: requires a free :3100 (the playwright webServer). It cannot run while
// a `next dev` holds the Next 16 single-dev lock on the same project dir.

import { test, expect } from "@playwright/test";

import { singleValue, withE2EDb } from "./_seed/db";
import { loadFixtures } from "./_seed/fixtures";
import { readLaunchResult } from "./_seed/launch-stream";

const CRON_HEADER = "X-Maister-Cron-Token";
const CRON_TOKEN = process.env.MAISTER_CRON_TOKEN ?? "e2e-cron-token-change-me";

// Two REAL flow children run a real graph in a real worktree here, which is
// minutes of wall clock away from orchestrator-loop's `workspace: none` agent
// children — the default 30s test budget expires mid-wake, with every earlier
// assertion already green.
test.setTimeout(180_000);

test("flow-target delegation: launch → flow children in Review → the parked coordinator wakes", async ({
  page,
  request,
}) => {
  const fx = loadFixtures().byKey.orchestratorFlow;

  // The dispatcher is a SCHEDULER JOB on a 60s cadence and the tick route claims
  // only DUE jobs, so re-arm it before every call (same reason as
  // orchestrator-loop.spec.ts).
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

  // Seed the consumer cursors BEFORE ANYTHING RUNS.
  //
  // `orchestrator_resume` is `startFrom: "now"`: its cursor row is created
  // inside a dispatch pass, seeded to MAX(domain_events.id) at that moment, and
  // it never looks back. orchestrator-loop.spec.ts can seed it after the park
  // because its agent children are HELD until the spec releases them — a FLOW
  // child is not held: it starts the instant it is launched and a two-node cli
  // graph reaches `Review` in well under a second. Seeding after the park would
  // therefore land AFTER both `run.review` rows and skip the wake forever,
  // which reads exactly like "the wake is broken".
  await tickDispatcher();

  // ---- Launch the orchestrator task from the board. ------------------------
  await page.goto(`/projects/${fx.projectSlug}`);

  // Retry-safe: the card reads "Launch" only while the task has never run. A
  // Playwright retry re-uses the SAME seeded task, which by then has a run, so
  // the button reads "Run again" — matching both keeps a retry a real retry
  // instead of a locator failure that hides the original error.
  const launchControl = page
    .locator("[data-board]")
    .getByText("Delegate a governed flow")
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

  // ---- The orchestrator parks with FLOW children. --------------------------
  await expect
    .poll(
      () =>
        singleValue<string>(`SELECT status AS value FROM runs WHERE id = $1`, [
          runId,
        ]),
      { timeout: 30_000 },
    )
    .toBe("WaitingOnChildren");

  // Every child is a run_kind='flow' run with a carrier task — the thing that
  // did not exist before ADR-163.
  const childKinds = await singleValue<string>(
    `SELECT string_agg(DISTINCT run_kind, ',') AS value FROM runs WHERE parent_run_id = $1`,
    [runId],
  );

  expect(childKinds).toBe("flow");

  const carrierCount = await singleValue<string>(
    `SELECT count(*)::text AS value
       FROM runs r JOIN tasks t ON t.id = r.task_id
      WHERE r.parent_run_id = $1 AND t.launch_mode = 'manual'`,
    [runId],
  );

  expect(carrierCount).toBe("2");

  // Each carrier task is linked parent_of under the orchestrator's own task —
  // in `mode: run`, which for a flow target is NOT a board-visibility switch.
  expect(
    await singleValue<string>(
      `SELECT count(*)::text AS value
         FROM task_relations tr
         JOIN runs parent ON parent.task_id = tr.from_task_id
         JOIN runs child ON child.task_id = tr.to_task_id
        WHERE parent.id = $1 AND child.parent_run_id = $1 AND tr.kind = 'parent_of'`,
      [runId],
    ),
  ).toBe("2");

  // ---- The workbench renders the flow children in the run-tree. ------------
  await page.goto(`/runs/${runId}`);
  const subtree = page.getByTestId("orchestrator-run-subtree");

  await expect(subtree).toBeVisible();
  await expect(subtree.locator("[data-child-run-id]")).toHaveCount(2);

  // ---- Each flow child runs its own graph to Review. ----------------------
  // A flow child always provisions a worktree, so it ALWAYS parks in `Review`
  // (unlike a workspace:none agent child, which reaches Done directly).
  await expect
    .poll(
      () =>
        singleValue<string>(
          `SELECT count(*)::text AS value FROM runs WHERE parent_run_id = $1 AND status = 'Review'`,
          [runId],
        ),
      { timeout: 60_000, intervals: [1000] },
    )
    .toBe("2");

  // The wake edge itself: a `run.review` DOMAIN event per child, each carrying
  // the parent linkage. Before ADR-163 the graph runner emitted only the
  // webhook here, and the coordinator would have parked forever.
  expect(
    await singleValue<string>(
      `SELECT count(*)::text AS value
         FROM domain_events e JOIN runs r ON r.id = e.run_id
        WHERE r.parent_run_id = $1
          AND e.kind = 'run.review'
          AND e.payload->>'parentRunId' = $1`,
      [runId],
    ),
  ).toBe("2");

  // ---- Tick the dispatcher → the parked coordinator wakes. ----------------
  await expect
    .poll(
      async () => {
        await tickDispatcher();

        return singleValue<string>(
          `SELECT status AS value FROM runs WHERE id = $1`,
          [runId],
        );
      },
      { timeout: 60_000, intervals: [1000] },
    )
    .not.toBe("WaitingOnChildren");

  // The coordinator resumed over the real wire and finished; its flow children
  // stay in Review awaiting a promote decision (ADR-163 residual W12 — nothing
  // reclaims them, which is exactly what the run tree should show here).
  expect(
    await singleValue<string>(
      `SELECT count(*)::text AS value FROM runs WHERE parent_run_id = $1 AND status = 'Review'`,
      [runId],
    ),
  ).toBe("2");
});
