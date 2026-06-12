import { randomUUID } from "node:crypto";

import { test, expect } from "@playwright/test";

import { withE2EDb } from "./_seed/db";
import { loadFixtures } from "./_seed/fixtures";

type SeededMultiRunTask = {
  title: string;
  number: number;
};

async function seedMultiRunTask(): Promise<SeededMultiRunTask> {
  const fx = loadFixtures().byKey.board;
  const idSuffix = randomUUID().slice(0, 8);
  const taskId = `task-multi-${idSuffix}`;
  const firstRunId = `run-multi-${idSuffix}-1`;
  const secondRunId = `run-multi-${idSuffix}-2`;
  const title = `Multi-run policy task ${idSuffix}`;
  const number = (Number.parseInt(idSuffix, 16) % 900_000_000) + 100_000_000;

  await withE2EDb(async (pool) => {
    await pool.query(
      `
        INSERT INTO tasks (id, project_id, number, title, prompt, flow_id, status, stage, attempt_number, created_at, updated_at)
        VALUES ($1, $2, $3, $4, 'Exercise ADR-085 UI surfaces', $5, 'Done', 'Backlog', 2, now(), now())
      `,
      [taskId, fx.projectId, number, title, fx.flowId],
    );
    await pool.query(
      `
        INSERT INTO runs (
          id, run_kind, task_id, project_id, flow_id, runner_id,
          runner_resolution_tier, capability_agent, runner_snapshot,
          status, flow_version, flow_revision, started_at, ended_at
        )
        VALUES
          ($1, 'flow', $3, $4, $5, $6, 'project', 'claude', '{"model":"claude-sonnet-4-6"}', 'Failed', 'v1', 'rev-1', now() - interval '2 hours', now() - interval '90 minutes'),
          ($2, 'flow', $3, $4, $5, $6, 'project', 'claude', '{"model":"claude-sonnet-4-6"}', 'Done', 'v1', 'rev-1', now() - interval '1 hour', now() - interval '10 minutes')
      `,
      [firstRunId, secondRunId, taskId, fx.projectId, fx.flowId, fx.runnerId],
    );
  });

  return { title, number };
}

test.describe("multi-run cost and delivery policy UI", () => {
  test("task page shows Run again, launch overrides, history, and totals", async ({
    page,
  }) => {
    const fx = loadFixtures().byKey.board;
    const seeded = await seedMultiRunTask();

    await page.goto(`/projects/${fx.projectSlug}/tasks/${seeded.number}`);

    await expect(
      page.getByRole("button", { name: /Run again/i }),
    ).toBeVisible();
    await expect(page.getByText("2 runs")).toBeVisible();
    await expect(
      page.getByRole("columnheader", { name: /Flow/i }),
    ).toBeVisible();
    await expect(
      page.getByRole("columnheader", { name: /Runner|Model/i }),
    ).toBeVisible();
    await expect(
      page.getByRole("columnheader", { name: /Delivery/i }),
    ).toBeVisible();
    await expect(
      page.getByRole("columnheader", { name: /Token total/i }),
    ).toBeVisible();

    const launchOptionsResponse = page.waitForResponse(
      (response) =>
        response.url().includes("/api/runs/launch-options") &&
        response.request().method() === "GET",
      { timeout: 20_000 },
    );

    await page.getByRole("button", { name: /Run again/i }).click();
    expect((await launchOptionsResponse).ok()).toBe(true);

    const dialog = page.getByRole("dialog", { name: /Run again/i });

    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel("Flow")).toBeVisible();
    await expect(dialog.getByLabel("Runner / Model")).toBeVisible();
    await expect(dialog.getByText(/Delivery policy/i)).toBeVisible();

    await dialog.getByLabel("Strategy").click();
    await page.getByRole("option", { name: /Pull request/i }).click();

    await expect(dialog.getByText(/Override/i)).toBeVisible();
  });

  test("board card shows run-count badge and settings expose policy default", async ({
    page,
  }) => {
    const fx = loadFixtures().byKey.board;
    const seeded = await seedMultiRunTask();

    await page.goto(`/projects/${fx.projectSlug}`);

    const card = page
      .locator("[data-board]")
      .getByText(seeded.title)
      .locator("xpath=ancestor::article");

    await expect(card.getByText("2 runs")).toBeVisible();

    await page.goto(`/projects/${fx.projectSlug}?tab=settings`);

    await expect(page.getByText(/Delivery policy/i)).toBeVisible();
    await expect(page.getByLabel(/Strategy/i)).toBeVisible();
    await expect(
      page.getByRole("button", { name: /Save/i }).last(),
    ).toBeVisible();
  });

  test("Observatory exposes a read-only cost dimension", async ({ page }) => {
    await page.goto("/observatory");

    await expect(page.getByRole("tab", { name: /Cost/i })).toBeVisible();

    await page.getByRole("tab", { name: /Cost/i }).click();

    await expect(page.getByText(/Input tokens/i)).toBeVisible();
    await expect(page.getByText(/Resume tax/i)).toBeVisible();
    await expect(page.getByText("Read-only", { exact: true })).toBeVisible();
  });
});
