// M34 (ADR-089) e2e (b): flow-bound agent. The seeded graph flow's ai_coding
// node declares `settings.agent: e2e-helper` (engine floor 1.5.0); launching
// the bound task from the board goes through the full launch pipeline —
// settings-enforcement gate, runner resolution, worktree add — and queues
// behind the e2e suite's permanently saturated flow pool (the seeded
// fixtures hold >cap live runs by design), exactly the Pending+queue
// product behavior. The session-level prompt substitution itself (agent .md
// body + "## Task" + node prompt) is asserted deterministically at the
// runner layer in lib/flows/__tests__/runner-agent.test.ts ("catalog-agent
// binding substitution"), where a spawn slot is not subject to the shared
// e2e capacity.

import { test, expect } from "@playwright/test";

import { singleValue } from "./_seed/db";
import { loadFixtures } from "./_seed/fixtures";

test("flow-bound agent task launches through the gate and queues on the flow pool", async ({
  page,
}) => {
  const fx = loadFixtures().byKey.platformAgents;

  await page.goto(`/projects/${fx.projectSlug}`);
  await expect(page.getByText("Bound-agent flow target")).toBeVisible();

  const card = page
    .locator("article")
    .filter({ hasText: "Bound-agent flow target" });

  const launchResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/runs") &&
      response.request().method() === "POST",
  );

  await card.getByRole("button", { name: "launch", exact: true }).click();

  const response = await launchResponse;

  // The launch passed every gate (graph compile with the agent:<id> node,
  // enforcement, runner resolution, worktree preconditions) — 201/202.
  expect([201, 202]).toContain(response.status());

  const { runId } = (await response.json()) as { runId: string };

  // The run rides the FLOW pool with the bound flow attached; the seeded
  // suite saturates the global cap, so it queues Pending (the agent budget
  // is a separate pool and stays unaffected).
  const runFlowId = await singleValue<string>(
    `SELECT flow_id AS value FROM runs WHERE id = $1`,
    [runId],
  );
  const taskFlowId = await singleValue<string>(
    `SELECT flow_id AS value FROM tasks WHERE id = $1`,
    [fx.boundTaskId],
  );

  expect(runFlowId).toBeTruthy();
  expect(runFlowId).toBe(taskFlowId);

  const status = await singleValue<string>(
    `SELECT status AS value FROM runs WHERE id = $1`,
    [runId],
  );

  expect(["Pending", "Running"]).toContain(status);
});
