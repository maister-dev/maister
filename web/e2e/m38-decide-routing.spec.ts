// M38 (ADR-103) — output/verdict-driven dynamic routing (`decide`) + malformed-
// output handling (`output.result.on_mismatch`), end-to-end through the REAL
// stack. Two routing cases are LAUNCHED from the board (Strategy A — exercises
// the real `runGraph` routing, not a static surface) and one Studio surface
// (Strategy B) asserts the new authoring Routing panel.
//
// Harness notes:
//   • The launched flows are ALL-`cli` so the background `runFlow` runs to a
//     terminal state with NO supervisor session (only the GET /health launch
//     gate); the runtime executes real `echo` commands in the worktree and the
//     engine routes on the structured output. The seeded fixtures saturate the
//     default flow concurrency cap, so playwright.config raises
//     MAISTER_MAX_CONCURRENT_RUNS for the e2e webServer (additive; see the
//     comment there).
//   • The routed OUTCOME is asserted from the DB (run status + the node_attempts
//     ledger), not the run-detail page. On this branch the run-detail page
//     (`/runs/{id}`) 500s for EVERY flow run — a pre-existing serialization bug
//     in app/(app)/runs/[runId]/layout.tsx (a function-typed `title` label in
//     the orchestrator-subtree / child-runs labels crosses the RSC→Client
//     boundary), confirmed independent of this change (it also breaks the m12 /
//     m15 run-detail specs). The DB assertions prove the routing deterministically.
//
// Asserted outcomes:
//   1. HAPPY (from:output): launch `classify` (emits {"verdict":"bug"}) → the
//      `bug` transition routes to `fixit`; the run reaches Review; the
//      node_attempts ledger shows classify (decision "bug") + fixit Succeeded
//      and `designit` ABSENT; the P7 writer leaves `<worktree>/.maister/run.json`.
//   2. NEGATIVE (no on_mismatch): launch `classify` (emits {"score":1}, missing
//      required `verdict`) → structured-output validation CONFIG-fails → the run
//      ends Failed (never promotes); only `classify` ran, and it Failed.
//   3. STUDIO (authoring): the flow editor renders the Routing panel for a node
//      declaring output.result — node-decide / node-decide-source /
//      node-decide-path are visible.
import { existsSync } from "node:fs";
import path from "node:path";

import { test, expect, type Page } from "@playwright/test";

import { singleValue, withE2EDb } from "./_seed/db";
import { loadFixtures } from "./_seed/fixtures";

const LATEST_RUN_SQL = `SELECT id AS value FROM runs WHERE task_id = $1
   ORDER BY started_at DESC NULLS LAST LIMIT 1`;

// Launches the named Backlog task from the project board (board Launch →
// confirm) and resolves the created run id from the DB by task id. The board
// launch POSTs with `Accept: text/event-stream` (staged SSE), so the response
// body is NOT JSON — the run id is read from the `runs` row the launch creates.
async function launchFromBoard(
  page: Page,
  projectSlug: string,
  taskId: string,
  taskTitle: string,
): Promise<string> {
  await page.goto(`/projects/${projectSlug}`);

  // A never-launched task's launch trigger is "Launch" (board.launchFirst); a
  // retry after a prior launch flips it to "Run again" (runCount > 0) — accept
  // both so the spec is retry-safe.
  const launchControl = page
    .locator("[data-board]")
    .getByText(taskTitle)
    .locator("xpath=ancestor::article")
    .getByRole("button", { name: /^(Launch|Run again)$/, exact: true });

  await expect(launchControl).toBeVisible();
  await expect(launchControl).toBeEnabled();

  const launchResponse = page.waitForResponse(
    (response) =>
      response.url().includes("/api/runs") &&
      response.request().method() === "POST",
  );

  await launchControl.click();

  // The launch popover (portaled to body) loads launch-options, then exposes
  // its confirm button "Create run" (launch.createRun).
  const dialog = page.getByTestId("task-launch-dialog");

  await expect(dialog).toBeVisible();

  const confirm = dialog.getByRole("button", {
    name: "Create run",
    exact: true,
  });

  await expect(confirm).toBeEnabled();
  await confirm.click();

  // The staged SSE stream opens with HTTP 200 (preconditions passed → a run was
  // created). The terminal frame carries {runId,status} but the body is SSE,
  // not JSON, so resolve the run from the DB by task id instead.
  expect((await launchResponse).status()).toBe(200);

  await expect
    .poll(() => singleValue<string>(LATEST_RUN_SQL, [taskId]), {
      timeout: 15_000,
      intervals: [200],
    })
    .not.toBeNull();

  const runId = await singleValue<string>(LATEST_RUN_SQL, [taskId]);

  expect(runId).toBeTruthy();

  return runId as string;
}

async function waitForRunStatus(runId: string, status: string): Promise<void> {
  await expect
    .poll(
      () =>
        singleValue<string>(`SELECT status AS value FROM runs WHERE id = $1`, [
          runId,
        ]),
      { timeout: 30_000, intervals: [400] },
    )
    .toBe(status);
}

type AttemptRow = { node_id: string; status: string; decision: string | null };

async function attemptsFor(runId: string): Promise<AttemptRow[]> {
  return withE2EDb(async (pool) => {
    const res = await pool.query<AttemptRow>(
      `SELECT node_id, status, decision FROM node_attempts WHERE run_id = $1`,
      [runId],
    );

    return res.rows;
  });
}

test("decide from:output routes to the matched branch; the run reaches Review and writes run.json", async ({
  page,
}) => {
  const fx = loadFixtures().byKey.m38.route;

  const runId = await launchFromBoard(
    page,
    fx.projectSlug,
    fx.taskId,
    fx.taskTitle,
  );

  // The all-cli flow runs to a terminal state in the web tier — the `bug`
  // verdict routed `classify → fixit`, reaching Review (NOT Failed).
  await waitForRunStatus(runId, "Review");

  const attempts = await attemptsFor(runId);
  const classify = attempts.find((a) => a.node_id === "classify");
  const fixit = attempts.find((a) => a.node_id === "fixit");

  // `classify` ran, succeeded, and decided the `bug` outcome.
  expect(classify?.status).toBe("Succeeded");
  expect(classify?.decision).toBe("bug");
  // `fixit` ran (routed here) and succeeded.
  expect(fixit?.status).toBe("Succeeded");
  // `designit` did NOT run — no attempt row for the unrouted branch.
  expect(attempts.find((a) => a.node_id === "designit")).toBeUndefined();

  // P7: a successful run leaves `<worktree>/.maister/run.json` (filesystem
  // projection — no UI reflects it, so assert it on disk).
  const worktreePath = await singleValue<string>(
    `SELECT worktree_path AS value FROM workspaces WHERE run_id = $1`,
    [runId],
  );

  expect(worktreePath).toBeTruthy();
  expect(
    existsSync(path.join(worktreePath as string, ".maister", "run.json")),
  ).toBe(true);
});

test("malformed structured output with no on_mismatch fails the run and never promotes", async ({
  page,
}) => {
  const fx = loadFixtures().byKey.m38.mismatch;

  const runId = await launchFromBoard(
    page,
    fx.projectSlug,
    fx.taskId,
    fx.taskTitle,
  );

  // Missing required `verdict` → structured-output validation CONFIG-fails →
  // the run ends Failed (never reaches Review/promotion).
  await waitForRunStatus(runId, "Failed");

  const attempts = await attemptsFor(runId);

  // `classify` failed; no downstream node ran and the run never promoted.
  expect(attempts.find((a) => a.node_id === "classify")?.status).toBe("Failed");
  expect(attempts.find((a) => a.node_id === "fixit")).toBeUndefined();
  expect(
    await singleValue<string>(
      `SELECT status AS value FROM runs WHERE id = $1`,
      [runId],
    ),
  ).toBe("Failed");
});

test("Flow Studio: selecting a node with output.result renders the decide Routing panel", async ({
  page,
}) => {
  const fx = loadFixtures().byKey.m38.studio;

  await page.goto(`/flows/${fx.projectSlug}/${fx.capId}`);

  // The 3-pane editor shell mounts (top bar + graph canvas).
  await expect(page.getByTestId("flow-editor-tabs")).toBeVisible();
  await expect(page.getByTestId("flow-graph-editor")).toBeVisible({
    timeout: 15_000,
  });

  // Select the `classify` node (declares output.result + decide) → the right
  // properties panel populates with the Routing section.
  await page
    .locator('[data-testid="flow-node"]')
    .filter({ hasText: fx.nodeLabel })
    .first()
    .click();

  await expect(page.getByTestId("node-side-form")).toBeVisible();

  // The new M38 Routing panel: the section, the source select (set to
  // "output"), and the from-path field for output-driven routing.
  await expect(page.getByTestId("node-decide")).toBeVisible();
  await expect(page.getByTestId("node-decide-source")).toBeVisible();
  await expect(page.getByTestId("node-decide-path")).toBeVisible();
});
