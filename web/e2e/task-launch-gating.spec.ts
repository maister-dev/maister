import { test, expect } from "@playwright/test";

import { singleValue } from "./_seed/db";
import { loadFixtures } from "./_seed/fixtures";

test("task creation works and a backlog card exposes a launch control", async ({
  page,
}) => {
  const fx = loadFixtures().byKey.board;
  const title = `Acceptance created task ${Date.now()}`;

  await page.goto(`/projects/${fx.projectSlug}`);
  await page.getByRole("button", { name: "New task" }).click();
  await page
    .locator('input[placeholder="Short summary of the task"]')
    .fill(title);
  await page
    .locator('textarea[placeholder="What should the agent do?"]')
    .fill("Create a deterministic e2e backlog task.");
  // M34: flow became optional (simple-intent tasks) and the modal defaults to
  // "no flow"; this spec asserts the one-click launch control, which only a
  // CONFIGURED task exposes — pick the project's flow explicitly.
  await page.getByLabel("Flow").selectOption({ index: 1 });

  const createResponse = page.waitForResponse(
    (response) =>
      response.url().includes(`/api/projects/${fx.projectSlug}/tasks`) &&
      response.request().method() === "POST",
  );

  await page.getByRole("button", { name: "Create task" }).click();
  expect((await createResponse).status()).toBe(201);
  await expect(page.getByText(title)).toBeVisible();

  const createdTaskId = await singleValue<string>(
    "SELECT id AS value FROM tasks WHERE project_id = $1 AND title = $2",
    [fx.projectId, title],
  );

  expect(createdTaskId).toBeTruthy();

  // The newly-created backlog card exposes a launch control. The e2e stub
  // answers GET /health as ready (e2e/_seed/stub-supervisor.ts) so the board's
  // readiness gate passes and the button renders ENABLED — the disabled
  // "paused" state only appears when /health is unreachable.
  const launchControl = page
    .locator("[data-board]")
    .getByText(title)
    .locator("xpath=ancestor::article")
    .getByRole("button", { name: "launch", exact: true });

  await expect(launchControl).toBeVisible();
  await expect(launchControl).toBeEnabled();

  // The "launch is gated before any worktree/DB side effect when the supervisor
  // is unavailable" guarantee (POST /api/runs → 503 EXECUTOR_UNAVAILABLE, no
  // addWorktree, no run row) is owned by the integration test
  // app/api/runs/__tests__/route.trust-boundary.integration.test.ts ("rejects
  // launch when supervisor readiness is unavailable before worktree or DB side
  // effects"), which can mock an unavailable supervisor. The e2e harness runs a
  // single, deliberately-healthy /health stub shared by the m11/m19 click-launch
  // flows, so it cannot model supervisor-unavailable here without racing them.
});
