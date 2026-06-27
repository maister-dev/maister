import { randomUUID } from "node:crypto";

import { test, expect } from "@playwright/test";

import {
  e2eClaudeRunnerSnapshot,
  seedDefaultRunSession,
  singleValue,
  withE2EDb,
} from "./_seed/db";
import { loadFixtures } from "./_seed/fixtures";

// One shared self-seeded project for the whole file → run serially so the
// single beforeAll seeds once (parallel workers would race the unique slug).
test.describe.configure({ mode: "serial" });

// Self-seeded, isolated fixture (its own project + slug) so the active-workspaces
// rail rows are deterministic and never collide with the shared acceptance seed.
// Fixed slug + delete-first is idempotent across retries; afterAll cascades it.
const SLUG = "e2e-active-ws";
const TASK_KEY = "AWSE2E";
const ids = {
  project: randomUUID(),
  runner: randomUUID(),
  flow: randomUUID(),
  task: randomUUID(),
  flowRun: randomUUID(),
  flowWorkspace: randomUUID(),
  scratchRun: randomUUID(),
  scratchWorkspace: randomUUID(),
};

test.beforeAll(async () => {
  const adminId = loadFixtures().users.admin.id;

  await withE2EDb(async (pool) => {
    await pool.query("DELETE FROM projects WHERE slug = $1", [SLUG]);
    await pool.query("DELETE FROM platform_acp_runners WHERE id = $1", [
      ids.runner,
    ]);

    await pool.query(
      `INSERT INTO projects (id, slug, name, repo_path, main_branch, maister_yaml_path, task_key)
       VALUES ($1, $2, 'E2E Active Workspaces', $3, 'main', $4, $5)`,
      [
        ids.project,
        SLUG,
        `/tmp/maister-e2e/${ids.project}`,
        `/tmp/maister-e2e/${ids.project}/maister.yaml`,
        TASK_KEY,
      ],
    );
    await pool.query(
      `INSERT INTO platform_acp_runners
         (id, adapter, capability_agent, model, provider, permission_policy,
          readiness_status, readiness_reasons, enabled)
       VALUES ($1, 'claude', 'claude', 'claude-sonnet-4-6',
          '{"kind":"anthropic"}'::jsonb, 'default', 'Ready', '[]'::jsonb, true)`,
      [ids.runner],
    );
    await pool.query(
      `INSERT INTO flows (id, project_id, flow_ref_id, source, version, installed_path, manifest, schema_version)
       VALUES ($1, $2, 'aif', 'github.com/maister/maister-flow-aif', 'v1.0.0', $3, $4, 1)`,
      [
        ids.flow,
        ids.project,
        `/tmp/maister-e2e/flows/aif@v1.0.0`,
        JSON.stringify({ schemaVersion: 1, name: "AIF", steps: [] }),
      ],
    );
    await pool.query(
      `INSERT INTO tasks (id, project_id, number, title, prompt, flow_id, status, stage)
       VALUES ($1, $2, 1, 'Rail redesign task', 'do the thing', $3, 'InFlight', 'Backlog')`,
      [ids.task, ids.project, ids.flow],
    );

    // Flow run linked to the task → a ticket-derived name + KEY-N issue chip.
    await pool.query(
      `INSERT INTO runs (id, task_id, project_id, flow_id, run_kind, status, current_step_id, flow_version, started_at)
       VALUES ($1, $2, $3, $4, 'flow', 'Running', 'implement', 'v1.0.0', now())`,
      [ids.flowRun, ids.task, ids.project, ids.flow],
    );
    await seedDefaultRunSession(pool, {
      runId: ids.flowRun,
      runnerId: ids.runner,
      capabilityAgent: "claude",
      runnerSnapshot: e2eClaudeRunnerSnapshot(ids.runner),
    });
    await pool.query(
      `INSERT INTO workspaces (id, run_id, project_id, branch, worktree_path, parent_repo_path, base_branch, base_commit, target_branch)
       VALUES ($1, $2, $3, 'maister/rail-flow', $4, $5, 'main', '0000000', 'main')`,
      [
        ids.flowWorkspace,
        ids.flowRun,
        ids.project,
        `/tmp/maister-e2e/${ids.project}/.worktrees/flow`,
        `/tmp/maister-e2e/${ids.project}`,
      ],
    );

    // Scratch run owned by admin → renamable rail row.
    await pool.query(
      `INSERT INTO runs (id, project_id, run_kind, status, flow_version, flow_revision, created_by_user_id, started_at)
       VALUES ($1, $2, 'scratch', 'Running', 'scratch', 'manual', $3, now())`,
      [ids.scratchRun, ids.project, adminId],
    );
    await seedDefaultRunSession(pool, {
      runId: ids.scratchRun,
      runnerId: ids.runner,
      capabilityAgent: "claude",
      runnerSnapshot: e2eClaudeRunnerSnapshot(ids.runner),
    });
    await pool.query(
      `INSERT INTO workspaces (id, run_id, project_id, branch, worktree_path, parent_repo_path, base_branch, base_commit, target_branch)
       VALUES ($1, $2, $3, 'maister/rail-scratch', $4, $5, 'main', '0000000', 'main')`,
      [
        ids.scratchWorkspace,
        ids.scratchRun,
        ids.project,
        `/tmp/maister-e2e/${ids.project}/.worktrees/scratch`,
        `/tmp/maister-e2e/${ids.project}`,
      ],
    );
    await pool.query(
      `INSERT INTO scratch_runs (run_id, project_id, name, initial_prompt, base_branch, base_commit, dialog_status, created_by_user_id)
       VALUES ($1, $2, 'Scratch to rename', 'investigate', 'main', '0000000', 'Running', $3)`,
      [ids.scratchRun, ids.project, adminId],
    );
  });
});

test.afterAll(async () => {
  await withE2EDb(async (pool) => {
    await pool.query("DELETE FROM projects WHERE slug = $1", [SLUG]);
    await pool.query("DELETE FROM platform_acp_runners WHERE id = $1", [
      ids.runner,
    ]);
  });
});

function scratchRow(page: import("@playwright/test").Page) {
  return page
    .getByTestId("active-workspace-row")
    .filter({ hasText: "Scratch to rename" });
}

test("a running rail row renders the colour-coded state dot", async ({
  page,
}) => {
  await page.goto("/");

  const row = scratchRow(page);

  await expect(row).toBeVisible();
  await expect(row.locator('[data-status-tone="running"]')).toBeVisible();
});

test("hovering a live row reveals the inline Stop + ⋯ overflow and hides the timestamp", async ({
  page,
}) => {
  await page.goto("/");

  const row = scratchRow(page);

  await expect(row).toBeVisible();
  // Idle: timestamp shown, action cluster collapsed.
  await expect(row.getByTestId("row-time")).toBeVisible();

  await row.hover();

  // Hover: the inline Stop (live) + the ⋯ overflow surface; time hides. There is
  // no inline rename pencil any more — rename lives inside the ⋯ action-sheet.
  await expect(row.getByTestId("rail-stop")).toBeVisible();
  await expect(row.getByTestId("rail-menu-trigger")).toBeVisible();
  await expect(row.getByTestId("rename-pencil")).toHaveCount(0);
  await expect(row.getByTestId("row-time")).toBeHidden();
});

test("the ⋯ overflow opens the live action-sheet", async ({ page }) => {
  await page.goto("/");

  const row = scratchRow(page);

  await expect(row).toBeVisible();
  await row.hover();
  await row.getByTestId("rail-menu-trigger").click();

  // The action-sheet is a modal overlay; resolve its items at page level.
  await expect(page.getByTestId("rail-action-sheet")).toBeVisible();
  await expect(page.getByTestId("menu-open")).toBeVisible();
  await expect(page.getByTestId("menu-rename")).toBeVisible();
  await expect(page.getByTestId("menu-stopArchive")).toBeVisible();
  await expect(page.getByTestId("menu-stopDrop")).toBeVisible();
});

test("a row keeps a stable height between rest and hover (no jump)", async ({
  page,
}) => {
  await page.goto("/");

  const row = scratchRow(page);

  await expect(row).toBeVisible();

  const rest = await row.boundingBox();

  await row.hover();
  await expect(row.getByTestId("rail-menu-trigger")).toBeVisible();

  const hovered = await row.boundingBox();

  expect(rest).not.toBeNull();
  expect(hovered).not.toBeNull();
  expect(Math.round(hovered!.height)).toBe(Math.round(rest!.height));
});

test("the run name link stays reachable while the row is hovered", async ({
  page,
}) => {
  await page.goto("/");

  const row = scratchRow(page);

  await expect(row).toBeVisible();

  const nameLink = row.getByRole("link", { name: "Scratch to rename" });

  await expect(nameLink).toBeVisible();

  await row.hover();

  // The reserved right slot never covers the name link.
  await expect(nameLink).toBeVisible();
  await expect(nameLink).toHaveAttribute("href", /\/(runs|scratch-runs)\//);
});

test("the KEY-N issue chip navigates to the task detail", async ({ page }) => {
  await page.goto("/");

  const flowRow = page
    .getByTestId("active-workspace-row")
    .filter({ hasText: `${TASK_KEY}-1` });

  await expect(flowRow).toBeVisible();
  await flowRow.getByTestId("issue-chip").click();

  // The chip is a link to the task-detail route, so the destination URL is the
  // navigation contract under test. (The detail page's run/diff panels need a
  // real worktree, which this synthetic rail-only seed deliberately omits.)
  await expect(page).toHaveURL(new RegExp(`/projects/${SLUG}/tasks/1$`));
});

test("renaming a scratch run through the ⋯ modal round-trips and persists", async ({
  page,
}) => {
  await page.goto("/");

  const row = scratchRow(page);

  await expect(row).toBeVisible();
  await row.hover();
  await row.getByTestId("rail-menu-trigger").click();
  await page.getByTestId("menu-rename").click();

  // The rename modal is a page-level overlay; the name is now an input VALUE.
  const input = page.getByTestId("rename-input");

  await expect(input).toBeVisible();
  await input.fill("Renamed by e2e");

  const patch = page.waitForResponse(
    (res) =>
      res.url().includes(`/api/scratch-runs/${ids.scratchRun}`) &&
      res.request().method() === "PATCH",
  );

  await page.getByTestId("rename-save").click();
  expect((await patch).status()).toBe(200);

  // Persisted in the DB…
  const stored = await singleValue<string>(
    "SELECT name AS value FROM scratch_runs WHERE run_id = $1",
    [ids.scratchRun],
  );

  expect(stored).toBe("Renamed by e2e");

  // …and reflected in the rail after the row refreshes.
  await expect(
    page
      .getByTestId("active-workspace-row")
      .filter({ hasText: "Renamed by e2e" }),
  ).toBeVisible();
});
