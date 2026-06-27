// Run & Task context visibility (this-branch feature). Seeds ONE isolated
// in-flight flow run that borrows the m22 fixture run's flow + revision (so the
// run page resolves a real manifest with a selectable `implement` node), with
// node_attempts carrying a captured `resolved_prompt`. Asserts the three new
// surfaces end-to-end:
//   1. board flight card — task identity (KEY-N -> task page) + flow, no branch;
//   2. run header — task title H1 + KEY-N chip + collapsible Task prompt block;
//   3. run timeline — the per-attempt resolved-prompt disclosure.
import { randomUUID } from "node:crypto";

import { test, expect } from "@playwright/test";

import { seedDefaultRunSession, withE2EDb } from "./_seed/db";
import { loadFixtures } from "./_seed/fixtures";

type Seeded = {
  projectSlug: string;
  flowRef: string;
  taskNumber: number;
  runId: string;
  title: string;
  branch: string;
  resolvedPrompt: string;
};

async function seedContextRun(): Promise<Seeded> {
  const m22 = loadFixtures().byKey.m22;
  const suffix = randomUUID().slice(0, 8);
  const taskId = `task-ctx-${suffix}`;
  const runId = `run-ctx-${suffix}`;
  const wsId = `ws-ctx-${suffix}`;
  const taskNumber = (Number.parseInt(suffix, 16) % 900_000_000) + 100_000_000;
  const title = `Context visibility ${suffix}`;
  const taskPrompt = "Make the **timeout** configurable via env.";
  const resolvedPrompt = `Implement the configurable timeout for ctx-${suffix} and add a regression test.`;
  const branch = `maister/ctx-${suffix}`;

  const flowRef = await withE2EDb(async (pool) => {
    // Borrow the renderable flow + revision (+ runner/project/repo) from the
    // m22 fixture run so the run page resolves a real manifest.
    const src = (
      await pool.query(
        `SELECT r.project_id, r.flow_id, r.flow_revision,
                (SELECT rs.runner_id FROM run_sessions rs WHERE rs.run_id = r.id ORDER BY (rs.acp_session_id IS NOT NULL) DESC, rs.updated_at DESC LIMIT 1) AS runner_id,
                p.repo_path, p.slug, f.flow_ref_id
         FROM runs r
         JOIN projects p ON p.id = r.project_id
         JOIN flows f ON f.id = r.flow_id
         WHERE r.id = $1`,
        [m22.runId],
      )
    ).rows[0] as {
      project_id: string;
      flow_id: string;
      flow_revision: string;
      runner_id: string;
      repo_path: string;
      slug: string;
      flow_ref_id: string;
    };

    await pool.query(
      `INSERT INTO tasks (id, project_id, number, title, prompt, flow_id, status, stage, attempt_number, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,'InFlight','Backlog',1, now(), now())`,
      [taskId, src.project_id, taskNumber, title, taskPrompt, src.flow_id],
    );
    // A complete runner snapshot — the active-workspaces rail's executorDisplay
    // throws unless the snapshot carries both `id` and `model`.
    const runnerSnapshot = {
      id: src.runner_id,
      adapter: "claude",
      capabilityAgent: "claude",
      model: "claude-sonnet-4-6",
      provider: { kind: "anthropic" },
      providerKind: "anthropic",
      permissionPolicy: "default",
      sidecar: null,
      sidecarId: null,
    };

    await pool.query(
      `INSERT INTO runs (
         id, run_kind, task_id, project_id, flow_id,
         status, flow_version, flow_revision, current_step_id, started_at
       )
       VALUES ($1,'flow',$2,$3,$4,'Running','v1',$5,'implement', now())`,
      [runId, taskId, src.project_id, src.flow_id, src.flow_revision],
    );
    await seedDefaultRunSession(pool, {
      runId,
      runnerId: src.runner_id,
      runnerResolutionTier: "project",
      capabilityAgent: "claude",
      runnerSnapshot,
    });
    await pool.query(
      `INSERT INTO workspaces (id, project_id, run_id, branch, worktree_path, parent_repo_path, created_at)
       VALUES ($1,$2,$3,$4,$5,$6, now())`,
      [
        wsId,
        src.project_id,
        runId,
        branch,
        `/tmp/ctx-${suffix}`,
        src.repo_path,
      ],
    );
    await pool.query(
      `INSERT INTO node_attempts (id, run_id, node_id, node_type, attempt, status, started_at, ended_at, resolved_prompt)
       VALUES
         ($1, $3, 'plan', 'ai_coding', 1, 'Succeeded', now() - interval '5 minutes', now() - interval '4 minutes', NULL),
         ($2, $3, 'implement', 'ai_coding', 1, 'Running', now() - interval '3 minutes', NULL, $4)`,
      [`na-plan-${suffix}`, `na-impl-${suffix}`, runId, resolvedPrompt],
    );

    return src.flow_ref_id;
  });

  return {
    projectSlug: m22.projectSlug,
    flowRef,
    taskNumber,
    runId,
    title,
    branch,
    resolvedPrompt,
  };
}

test.describe("run & task context visibility", () => {
  test("board flight card shows task identity (KEY-N -> task) + flow, not the branch", async ({
    page,
  }) => {
    const fx = await seedContextRun();

    await page.goto(`/projects/${fx.projectSlug}`);

    const card = page
      .locator('[data-testid="flight-card"]')
      .filter({ hasText: fx.title });

    await expect(card).toBeVisible();
    // KEY-N anchors to the task detail page.
    await expect(
      card.locator(
        `a[href="/projects/${fx.projectSlug}/tasks/${fx.taskNumber}"]`,
      ),
    ).toBeVisible();
    // The flow ref chip renders.
    await expect(card).toContainText(fx.flowRef);
    // Whole-card stretched link opens the run.
    await expect(
      card.locator(
        `a[data-testid="flight-card-open"][href="/runs/${fx.runId}"]`,
      ),
    ).toBeVisible();
    // The worktree branch is NOT shown on the compact card.
    await expect(card).not.toContainText(fx.branch);
  });

  test("run header is task-first: title H1 + KEY-N chip + collapsible Task prompt", async ({
    page,
  }) => {
    const fx = await seedContextRun();

    await page.goto(`/runs/${fx.runId}`);

    const header = page.locator('[data-testid="run-header"]');

    await expect(header).toBeVisible();
    await expect(header.locator("h1")).toContainText(fx.title);
    await expect(
      header.locator('[data-testid="run-header-keyref"]'),
    ).toBeVisible();

    const taskBlock = header.locator('[data-testid="run-header-task"]');

    await expect(taskBlock.locator("summary")).toContainText("Task");
    await taskBlock.locator("summary").click();
    // The task prompt is rendered as markdown (bold -> <strong>).
    await expect(taskBlock.locator("strong")).toContainText("timeout");
  });

  test("run timeline exposes the per-attempt resolved-prompt disclosure", async ({
    page,
  }) => {
    const fx = await seedContextRun();

    await page.goto(`/runs/${fx.runId}`);

    const disclosure = page
      .locator('[data-testid="flow-run-attempt-prompt"]')
      .first();

    await expect(disclosure).toBeVisible();
    await disclosure.locator("summary").click();
    await expect(disclosure).toContainText(fx.resolvedPrompt);
  });
});
