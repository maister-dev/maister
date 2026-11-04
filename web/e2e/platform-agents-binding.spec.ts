// M34 (ADR-089) e2e (b): flow-bound agent. The seeded graph flow's ai_coding
// node declares `settings.agent: e2e-helper` (engine floor 1.5.0); launching
// the bound task from the board goes through the full launch pipeline —
// admission and runner resolution. Capacity may leave an accepted intent
// queued without a Run; binding is checked only when it actually happens.
// The session-level prompt substitution itself (agent .md
// body + "## Task" + node prompt) is asserted deterministically at the
// runner layer in lib/flows/__tests__/runner-agent.test.ts ("catalog-agent
// binding substitution"), where a spawn slot is not subject to the shared
// e2e capacity.

import { test, expect } from "@playwright/test";

import { singleValue } from "./_seed/db";
import { loadFixtures } from "./_seed/fixtures";
import { readTaskLaunchReceipt } from "./_seed/task-launch";

test("flow-bound agent launch records its selected Flow settings and any actual Run binding", async ({
  page,
}) => {
  const fx = loadFixtures().byKey.platformAgents;

  await page.goto(`/projects/${fx.projectSlug}`);
  await expect(page.getByText("Bound-agent flow target")).toBeVisible();

  const card = page
    .locator("article")
    .filter({ hasText: "Bound-agent flow target" });

  // ADR-087 launch popover: the card button opens a dialog that loads
  // /api/runs/launch-options; the POST fires from its confirm button. The
  // seeded task has never run, so its card button reads "Launch" — "Run again"
  // appears only once `runCount > 0` (components/board/board.tsx).
  await card.getByRole("button", { name: "Launch", exact: true }).click();

  const dialog = page.getByTestId("task-launch-dialog");

  await expect(dialog).toBeVisible();

  const createRun = dialog.getByRole("button", {
    name: "Launch",
    exact: true,
  });

  await expect(createRun).toBeEnabled();

  const launchResponse = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/task-launch-intents" &&
      response.request().method() === "POST",
  );

  await createRun.click();

  const response = await launchResponse;

  const receipt = await readTaskLaunchReceipt(response);
  const taskFlowId = await singleValue<string>(
    `SELECT flow_id AS value FROM tasks WHERE id = $1`,
    [fx.boundTaskId],
  );

  expect(receipt.taskId).toBe(fx.boundTaskId);
  expect(receipt.snapshot.kind).toBe("flow");
  expect(receipt.snapshot.flowId).toBe(taskFlowId);
  expect(receipt.snapshot.runnerIds).toContain(fx.runnerId);
  const intent = await singleValue<{
    id: string;
    taskId: string;
    state: string;
    runId: string | null;
    kind: string;
    flowId: string;
    settingsDigest: string;
    runTaskId: string | null;
    runIntentId: string | null;
    runFlowId: string | null;
    runStatus: string | null;
  }>(
    `SELECT json_build_object(
       'id', i.id, 'taskId', i.task_id, 'state', i.state, 'runId', i.run_id,
       'kind', i.settings_snapshot->>'kind', 'flowId', i.settings_snapshot->>'flowId',
       'settingsDigest', i.settings_digest, 'runTaskId', r.task_id,
       'runIntentId', r.task_launch_intent_id, 'runFlowId', r.flow_id, 'runStatus', r.status
     ) AS value FROM task_launch_intents i LEFT JOIN runs r ON r.id=i.run_id WHERE i.id=$1`,
    [receipt.intentId],
  );

  expect(intent).toMatchObject({
    id: receipt.intentId,
    taskId: fx.boundTaskId,
    kind: "flow",
    flowId: taskFlowId,
    settingsDigest: receipt.settingsDigest,
  });
  if (!intent) throw new Error("Accepted Flow intent was not persisted");
  expect(["queued", "preparing", "run_bound"]).toContain(intent.state);
  if (intent.runId) {
    expect(intent.runTaskId).toBe(fx.boundTaskId);
    expect(intent.runIntentId).toBe(receipt.intentId);
    expect(intent.runFlowId).toBe(taskFlowId);
    expect(["Pending", "Running"]).toContain(intent.runStatus);
  } else {
    expect(["queued", "preparing"]).toContain(intent.state);
    expect(
      await singleValue<number>(
        "SELECT count(*)::int AS value FROM runs WHERE task_launch_intent_id=$1",
        [receipt.intentId],
      ),
    ).toBe(0);
  }
});
