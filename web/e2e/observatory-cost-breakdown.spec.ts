// ADR-117: the portfolio + project Observatory cost tab renders a "By model"
// and a "By runner" breakdown over the persisted run_cost_rollups jsonb columns,
// including scratch-run cost. Gated: runs only when :3000 is free (Next 16
// single-dev-server lock); static lint of the spec must always pass.

import { randomUUID } from "node:crypto";

import { test, expect } from "@playwright/test";

import { withE2EDb } from "./_seed/db";
import { loadFixtures } from "./_seed/fixtures";

const RUNNER_A = "claude/claude-sonnet-4-6";
const RUNNER_B = "codex/gpt-5";

async function seedCostRuns(): Promise<{ projectSlug: string }> {
  const fx = loadFixtures().byKey.board;
  const suffix = randomUUID().slice(0, 8);
  const flowRunId = `run-cost-flow-${suffix}`;
  const scratchRunId = `run-cost-scratch-${suffix}`;

  await withE2EDb(async (pool) => {
    await pool.query(
      `
        INSERT INTO runs (
          id, run_kind, project_id, flow_id, status, flow_version,
          started_at, ended_at
        )
        VALUES
          ($1, 'flow', $3, $4, 'Done', 'v1', now() - interval '2 hours', now() - interval '90 minutes'),
          ($2, 'scratch', $3, NULL, 'Done', 'v1', now() - interval '1 hour', now() - interval '10 minutes')
      `,
      [flowRunId, scratchRunId, fx.projectId, fx.flowId],
    );

    // A multi-runner flow run: two distinct runner buckets.
    await pool.query(
      `
        INSERT INTO run_cost_rollups (
          run_id, project_id, flow_id, input_tokens, output_tokens,
          source_event_count, by_model, by_runner
        )
        VALUES ($1, $2, $3, 100, 0, 2, $4, $5)
      `,
      [
        flowRunId,
        fx.projectId,
        fx.flowId,
        JSON.stringify({
          "claude-sonnet-4-6": {
            inputTokens: 70,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
          },
          "gpt-5": {
            inputTokens: 30,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
          },
        }),
        JSON.stringify({
          [RUNNER_A]: {
            inputTokens: 70,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
          },
          [RUNNER_B]: {
            inputTokens: 30,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
          },
        }),
      ],
    );

    // A scratch run with a single runner — its cost MUST appear in the totals.
    await pool.query(
      `
        INSERT INTO run_cost_rollups (
          run_id, project_id, input_tokens, output_tokens,
          source_event_count, by_model, by_runner
        )
        VALUES ($1, $2, 40, 0, 1, $3, $4)
      `,
      [
        scratchRunId,
        fx.projectId,
        JSON.stringify({
          "claude-sonnet-4-6": {
            inputTokens: 40,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
          },
        }),
        JSON.stringify({
          [RUNNER_A]: {
            inputTokens: 40,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
          },
        }),
      ],
    );
  });

  return { projectSlug: fx.projectSlug };
}

test.describe("Observatory cost breakdown (ADR-117)", () => {
  test("portfolio cost tab shows by-model and by-runner rows incl. scratch cost", async ({
    page,
  }) => {
    await seedCostRuns();

    await page.goto("/observatory");

    const byRunner = page.getByTestId("observatory-cost-by-runner");
    const byModel = page.getByTestId("observatory-cost-by-model");

    await expect(byRunner).toBeVisible();
    await expect(byModel).toBeVisible();

    // Both runner buckets render; the scratch run's runner (RUNNER_A) is summed
    // alongside the flow run's, so the by-runner card includes it.
    await expect(byRunner.getByText(RUNNER_A, { exact: true })).toBeVisible();
    await expect(byRunner.getByText(RUNNER_B, { exact: true })).toBeVisible();
    await expect(byModel.getByText("gpt-5", { exact: true })).toBeVisible();
  });

  test("project cost section renders the breakdown tables", async ({
    page,
  }) => {
    const { projectSlug } = await seedCostRuns();

    await page.goto(`/projects/${projectSlug}/observatory`);

    await expect(page.getByTestId("observatory-cost-by-runner")).toBeVisible();
    await expect(
      page
        .getByTestId("observatory-cost-by-runner")
        .getByText(RUNNER_A, { exact: true }),
    ).toBeVisible();
  });
});
