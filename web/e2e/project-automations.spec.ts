import { randomUUID } from "node:crypto";

import { test, expect } from "@playwright/test";

import { withE2EDb } from "./_seed/db";
import { loadFixtures } from "./_seed/fixtures";

const created = {
  runIds: [] as string[],
  scheduledLaunchIds: [] as string[],
  taskIds: [] as string[],
};

test.afterEach(async () => {
  await withE2EDb(async (pool) => {
    if (created.scheduledLaunchIds.length > 0) {
      await pool.query(
        "DELETE FROM scheduled_task_launches WHERE id = ANY($1::text[])",
        [created.scheduledLaunchIds],
      );
    }
    if (created.runIds.length > 0) {
      await pool.query("DELETE FROM runs WHERE id = ANY($1::text[])", [
        created.runIds,
      ]);
    }
    if (created.taskIds.length > 0) {
      await pool.query("DELETE FROM tasks WHERE id = ANY($1::text[])", [
        created.taskIds,
      ]);
    }
  });

  created.runIds.length = 0;
  created.scheduledLaunchIds.length = 0;
  created.taskIds.length = 0;
});

async function scheduleFromLaunchDialog(input: {
  page: import("@playwright/test").Page;
  projectSlug: string;
  taskTitle: string;
}): Promise<string> {
  const taskCard = input.page
    .locator("[data-board]")
    .getByText(input.taskTitle)
    .locator("xpath=ancestor::article");

  await expect(taskCard).toBeVisible();
  await taskCard.getByRole("button", { name: /^(Launch|Run again)$/ }).click();

  const dialog = input.page.getByRole("dialog");

  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Schedule run" }).click();
  await dialog
    .getByRole("textbox", { name: "Local date and time" })
    .fill("2030-01-02T03:04");
  await dialog.getByRole("textbox", { name: "IANA timezone" }).fill("UTC");
  await expect(
    dialog.getByText("Resolves to 2030-01-02T03:04:00.000Z."),
  ).toBeVisible();

  const createdResponse = input.page.waitForResponse(
    (response) =>
      response
        .url()
        .includes(`/api/projects/${input.projectSlug}/scheduled-launches`) &&
      response.request().method() === "POST",
  );

  await dialog.getByRole("button", { name: "Confirm schedule" }).click();

  const response = await createdResponse;

  expect(response.status()).toBe(201);

  const body = (await response.json()) as { intent: { id: string } };

  return body.intent.id;
}

test("Automations: schedule, inspect overdue recovery, cancel, and show a safe terminal refusal", async ({
  page,
}) => {
  const fx = loadFixtures().byKey.board;
  const taskId = randomUUID();
  const taskTitle = `e2e automation target ${Date.now()}`;
  const task = await withE2EDb(async (pool) => {
    const result = await pool.query<{ number: number; taskKey: string }>(
      `WITH alloc AS (
         UPDATE projects SET next_task_number = next_task_number + 1
         WHERE id = $1 RETURNING next_task_number - 1 AS number, task_key
       ), inserted AS (
         INSERT INTO tasks (id, project_id, number, title, prompt, flow_id, status)
         SELECT $2, $1, alloc.number, $3, 'e2e automation target', $4, 'Backlog'
         FROM alloc
         RETURNING number
       )
       SELECT inserted.number, alloc.task_key AS "taskKey"
       FROM inserted CROSS JOIN alloc`,
      [fx.projectId, taskId, taskTitle, fx.flowId],
    );

    return result.rows[0]!;
  });

  created.taskIds.push(taskId);

  await page.goto(`/projects/${fx.projectSlug}`);
  const overdueIntentId = await scheduleFromLaunchDialog({
    page,
    projectSlug: fx.projectSlug,
    taskTitle,
  });

  created.scheduledLaunchIds.push(overdueIntentId);

  const overdueRunId = randomUUID();

  created.runIds.push(overdueRunId);
  await withE2EDb(async (pool) => {
    await pool.query(
      `INSERT INTO runs
         (id, project_id, task_id, flow_id, status, flow_version, scheduled_launch_id)
       VALUES ($1, $2, $3, $4, 'Done', 'v1.0.0', $5)`,
      [overdueRunId, fx.projectId, taskId, fx.flowId, overdueIntentId],
    );
    await pool.query(
      `UPDATE scheduled_task_launches
       SET state = 'Launched', latest_outcome = 'launched',
           late_by_ms = 120000, next_attempt_at = NULL
       WHERE id = $1`,
      [overdueIntentId],
    );
  });

  await page.goto(`/projects/${fx.projectSlug}?tab=automations`);
  const scheduleName = `Schedule ${task.taskKey}-${task.number}`;
  const overdueRow = page
    .getByRole("listitem")
    .filter({ hasText: scheduleName });

  await expect(overdueRow).toContainText("Launched");
  await expect(overdueRow).toContainText("Started 2 minutes late");
  await expect(
    overdueRow.getByRole("link", { name: "View Run" }),
  ).toHaveAttribute("href", `/runs/${overdueRunId}`);

  await page.goto(`/projects/${fx.projectSlug}`);
  const cancellableIntentId = await scheduleFromLaunchDialog({
    page,
    projectSlug: fx.projectSlug,
    taskTitle,
  });

  created.scheduledLaunchIds.push(cancellableIntentId);

  await page.goto(`/projects/${fx.projectSlug}?tab=automations`);
  const cancellableRow = page
    .getByRole("listitem")
    .filter({ hasText: scheduleName })
    .filter({ hasText: "Scheduled" });
  const cancelResponse = page.waitForResponse(
    (response) =>
      response
        .url()
        .endsWith(`/scheduled-launches/${cancellableIntentId}/cancel`) &&
      response.request().method() === "POST",
  );

  page.once("dialog", (dialog) => dialog.accept());
  await cancellableRow.getByRole("button", { name: "Cancel" }).click();
  expect((await cancelResponse).status()).toBe(200);
  await expect(
    page
      .getByRole("listitem")
      .filter({ hasText: scheduleName })
      .filter({ hasText: "Cancelled" }),
  ).toHaveCount(1);

  await page.goto(`/projects/${fx.projectSlug}`);
  const refusedIntentId = await scheduleFromLaunchDialog({
    page,
    projectSlug: fx.projectSlug,
    taskTitle,
  });

  created.scheduledLaunchIds.push(refusedIntentId);

  const busyRunId = randomUUID();

  created.runIds.push(busyRunId);
  await withE2EDb(async (pool) => {
    await pool.query(
      `INSERT INTO runs (id, project_id, task_id, flow_id, status, flow_version, started_at)
       VALUES ($1, $2, $3, $4, 'Running', 'v1.0.0', now())`,
      [busyRunId, fx.projectId, taskId, fx.flowId],
    );
  });

  await page.goto(`/projects/${fx.projectSlug}?tab=automations`);
  const refusedRow = page
    .getByRole("listitem")
    .filter({ hasText: scheduleName })
    .filter({ hasText: "Scheduled" });
  const runNowResponse = page.waitForResponse(
    (response) =>
      response
        .url()
        .endsWith(`/scheduled-launches/${refusedIntentId}/run-now`) &&
      response.request().method() === "POST",
  );

  await refusedRow.getByRole("button", { name: "Run now" }).click();
  expect((await runNowResponse).status()).toBe(200);
  const failedRow = page
    .getByRole("listitem")
    .filter({ hasText: scheduleName })
    .filter({ hasText: "Failed" });

  await expect(failedRow).toHaveCount(1);
  await expect(failedRow).toContainText(
    "Action needs project or task attention",
  );
});
