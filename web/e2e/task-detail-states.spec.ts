// D10 task page (P-3, P-4, T-5 popover, S2 source chip). The state → action
// matrix is owned by lib/tasks/__tests__/task-next-action.test.ts; this spec
// samples one state per region and proves the on-demand/keyboard behavior.
import { randomUUID } from "node:crypto";

import { test, expect } from "@playwright/test";

import { seedDefaultRunSession, withE2EDb } from "./_seed/db";
import { loadFixtures } from "./_seed/fixtures";

type Seeded = { number: number; runId: string };

async function seedTask(status: "Backlog" | "Done"): Promise<Seeded> {
  const fx = loadFixtures().byKey.board;
  const suffix = randomUUID().slice(0, 8);
  const taskId = `task-d10-${suffix}`;
  const runId = `run-d10-${suffix}`;
  const number = (Number.parseInt(suffix, 16) % 900_000_000) + 100_000_000;

  await withE2EDb(async (pool) => {
    await pool.query(
      `INSERT INTO tasks (id, project_id, number, title, prompt, flow_id, status, stage, attempt_number)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'Backlog', 1)`,
      [
        taskId,
        fx.projectId,
        number,
        `D10 ${status} ${suffix}`,
        Array.from({ length: 12 }, (_, i) => `Statement line ${i + 1}`).join("\n"),
        fx.flowId,
        status,
      ],
    );
    if (status === "Backlog") return;

    await pool.query(
      `INSERT INTO runs (id, run_kind, task_id, project_id, flow_id, status, flow_version, flow_revision,
         started_at, ended_at, delivery_policy_snapshot)
       VALUES ($1, 'flow', $2, $3, $4, 'Done', 'v1', 'rev-1', now() - interval '40 minutes', now(),
         '{"strategy":"pull_request","push":"on_success","trigger":"manual","targetBranch":"main"}'::jsonb)`,
      [runId, taskId, fx.projectId, fx.flowId],
    );
    await seedDefaultRunSession(pool, {
      runId,
      runnerId: fx.runnerId,
      runnerResolutionTier: "project",
      capabilityAgent: "claude",
      runnerSnapshot: { model: "claude-sonnet-4-6" },
    });
    await pool.query(
      `INSERT INTO workspaces (id, run_id, project_id, branch, worktree_path, parent_repo_path,
         promotion_mode, promotion_state, pr_number, pr_url, pr_state)
       VALUES ($1, $2, $3, $4, $5, '/tmp/d10', 'pull_request', 'done', 7, 'https://github.com/acme/app/pull/7', 'merged')`,
      [`ws-${runId}`, runId, fx.projectId, `maister/d10-${suffix}`, `/tmp/d10-${suffix}`],
    );
    await pool.query(
      `INSERT INTO node_attempts (id, run_id, node_id, node_type, attempt, status, started_at, ended_at)
       VALUES ($1, $2, 'code', 'ai_coding', 1, 'succeeded', now() - interval '35 minutes', now() - interval '5 minutes')`,
      [`na-${runId}`, runId],
    );
    for (let i = 0; i < 3; i += 1) {
      await pool.query(
        `INSERT INTO task_activity (id, task_id, project_id, actor_type, event_kind, payload, created_at)
         VALUES ($1, $2, $3, 'system', 'run_launched', $4::jsonb, now() - interval '50 minutes' + ($5 || ' seconds')::interval)`,
        [`act-${runId}-${i}`, taskId, fx.projectId, JSON.stringify({ attemptNumber: i + 1 }), String(i)],
      );
    }
    await pool.query(
      `INSERT INTO task_activity (id, task_id, project_id, actor_type, event_kind, payload)
       VALUES ($1, $2, $3, 'system', 'task_completed', $4::jsonb)`,
      [`act-${runId}-done`, taskId, fx.projectId, JSON.stringify({ runId, cause: "pr_merged", prNumber: 7 })],
    );
    await pool.query(
      `INSERT INTO task_external_sources (id, project_id, task_id, source_kind, source_instance, scope_key,
         external_id, external_key, origin, created_by_actor_type)
       VALUES ($1, $2, $3, 'github', 'github.com', 'acme/app', $4, '#7', 'import', 'system')`,
      [`src-${runId}`, fx.projectId, taskId, `I_${suffix}`],
    );
  });

  return { number, runId };
}

test.describe("task detail around state and result (D10)", () => {
  test("P-3: a Done task leads with its result, keeps a relaunch under More and loads graph and diff on demand", async ({
    page,
  }) => {
    const fx = loadFixtures().byKey.board;
    const seeded = await seedTask("Done");

    await page.goto(`/projects/${fx.projectSlug}/tasks/${seeded.number}`);

    const result = page.getByTestId("task-result-card");

    await expect(result).toContainText("Resolving run");
    await expect(result.getByRole("link", { name: "#7" })).toHaveAttribute(
      "href",
      "https://github.com/acme/app/pull/7",
    );
    await expect(page.getByTestId("task-primary-action")).toContainText("View result");
    // S2: a binding without a URL renders as text, never a link.
    await expect(page.getByTestId("task-source-chip")).toHaveText("GitHub #7");
    await expect(page.locator('a[data-testid="task-source-chip"]')).toHaveCount(0);
    // One relaunch entry, behind More.
    await page.getByTestId("task-more-actions").locator("> summary").click();
    await expect(page.getByRole("button", { name: /Start a new attempt/i })).toHaveCount(1);
    // A Done statement opens collapsed.
    await expect(page.getByTestId("task-statement")).not.toHaveAttribute("open", "");
    // The diff mounts only once opened.
    await expect(page.getByTestId("task-run-diff")).toHaveCount(0);
    await page.getByTestId("task-run-diff-toggle").click();
    await expect(page.getByTestId("task-run-diff")).toBeVisible();
  });

  test("P-3: a launchable Backlog task offers Launch first and triage under More", async ({
    page,
  }) => {
    const fx = loadFixtures().byKey.board;
    const seeded = await seedTask("Backlog");

    await page.goto(`/projects/${fx.projectSlug}/tasks/${seeded.number}`);

    await expect(
      page.getByTestId("task-primary-action").getByRole("button", { name: /Launch/ }),
    ).toBeVisible();
    await page.getByTestId("task-more-actions").locator("> summary").click();
    await expect(page.getByRole("button", { name: "Send to triage" })).toBeVisible();
  });

  test("P-4: repetitive system events collapse into one row that keeps every entry", async ({
    page,
  }) => {
    const fx = loadFixtures().byKey.board;
    const seeded = await seedTask("Done");

    await page.goto(`/projects/${fx.projectSlug}/tasks/${seeded.number}`);

    const group = page.locator('[data-timeline-group="run_launched"]');

    await expect(group).toHaveCount(1);
    await expect(group).toContainText("×3");
    await group.locator("summary").click();
    for (const attempt of [1, 2, 3]) {
      await expect(group).toContainText(`launched run attempt ${attempt}`);
    }
  });

  test("T-5: the execution breakdown opens from the keyboard and closes on Escape", async ({
    page,
  }) => {
    const fx = loadFixtures().byKey.board;
    const seeded = await seedTask("Done");

    await page.goto(`/projects/${fx.projectSlug}/tasks/${seeded.number}`);

    const opener = page.getByTestId(`task-run-timing-${seeded.runId}-breakdown-open`);

    await opener.focus();
    await page.keyboard.press("Enter");
    const breakdown = page.getByTestId(`task-run-timing-${seeded.runId}-breakdown`);

    await expect(breakdown).toContainText("Execution");
    await page.keyboard.press("Escape");
    await expect(breakdown).toHaveCount(0);
    await expect(opener).toBeFocused();
    // Tap (pointer) opens it as well.
    await opener.click();
    await expect(breakdown).toBeVisible();
  });
});
