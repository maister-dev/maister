import { randomUUID } from "node:crypto";

import { test, expect } from "@playwright/test";

import { withE2EDb } from "./_seed/db";
import { loadFixtures } from "./_seed/fixtures";

// Member-level manage flows run as the seeded admin (global admin ≥ member —
// the same manageSchedules affordances). The canManage=false read-only
// rendering is covered by the component unit test
// (components/schedules/__tests__/schedules-table.test.ts).
test("schedules tab: create via modal, pause/resume, trigger-now outcome", async ({
  page,
}) => {
  const fx = loadFixtures().byKey.board;
  const scheduleName = `e2e nightly ${Date.now()}`;

  // A dedicated task whose latest run is ACTIVE: trigger-now then takes the
  // deterministic skipped_task_busy path — full dispatch pipeline, zero git
  // side effects on the shared fixture repo.
  const busyTaskId = randomUUID();
  const busyTaskTitle = `e2e schedule target ${Date.now()}`;

  await withE2EDb(async (pool) => {
    await pool.query(
      `WITH alloc AS (
         UPDATE projects SET next_task_number = next_task_number + 1
         WHERE id = $2 RETURNING next_task_number - 1 AS n
       )
       INSERT INTO tasks (id, project_id, number, title, prompt, flow_id, status)
       SELECT $1, $2, alloc.n, $3, 'e2e', $4, 'Backlog' FROM alloc`,
      [busyTaskId, fx.projectId, busyTaskTitle, fx.flowId],
    );
    await pool.query(
      `INSERT INTO runs (id, project_id, task_id, flow_id, status, flow_version, started_at)
       VALUES ($1, $2, $3, $4, 'Running', 'v1.0.0', now())`,
      [randomUUID(), fx.projectId, busyTaskId, fx.flowId],
    );
  });

  await page.goto(`/projects/${fx.projectSlug}?tab=schedules`);
  await expect(page.getByText("No schedules yet")).toBeVisible();

  await page.getByRole("button", { name: "New schedule" }).click();

  const dialog = page.getByRole("dialog");

  await expect(dialog).toBeVisible();
  await dialog.getByRole("textbox", { name: "Name" }).fill(scheduleName);
  await dialog
    .getByRole("combobox", { name: /^Task/ })
    .selectOption(busyTaskId);
  await dialog
    .getByRole("textbox", { name: "Cron expression" })
    .fill("0 3 * * *");
  await dialog
    .getByRole("combobox", { name: /^Timezone/ })
    .selectOption("Europe/Moscow");

  const createResponse = page.waitForResponse(
    (response) =>
      response.url().includes(`/api/projects/${fx.projectSlug}/schedules`) &&
      response.request().method() === "POST",
  );

  await dialog.getByRole("button", { name: "Save" }).click();
  expect((await createResponse).status()).toBe(201);

  const row = page.getByRole("row", { name: new RegExp(scheduleName) });

  await expect(row).toBeVisible();
  await expect(row).toContainText("0 3 * * *");
  await expect(row).toContainText("Europe/Moscow");
  await expect(row).toContainText("Enabled");

  // Pause → PATCH {enabled:false} → badge flips; resume flips back.
  const patchPaused = page.waitForResponse(
    (response) =>
      response.url().includes("/schedules/") &&
      response.request().method() === "PATCH",
  );

  await row.getByRole("button", { name: "Pause" }).click();
  expect((await patchPaused).status()).toBe(200);
  await expect(row).toContainText("Paused");

  const patchResumed = page.waitForResponse(
    (response) =>
      response.url().includes("/schedules/") &&
      response.request().method() === "PATCH",
  );

  await row.getByRole("button", { name: "Resume" }).click();
  expect((await patchResumed).status()).toBe(200);
  await expect(row).toContainText("Enabled");

  // Trigger-now: the schedule targets a task with an active run, so the
  // dispatch reports skipped_task_busy through the UI outcome surface.
  const triggerResponse = page.waitForResponse(
    (response) =>
      response.url().includes("/trigger") &&
      response.request().method() === "POST",
  );

  await row.getByRole("button", { name: "Trigger now" }).click();

  const triggerBody = await (await triggerResponse).json();

  expect(triggerBody.outcome).toBe("skipped_task_busy");
  await expect(
    page.getByText("Skipped: task already has an active run"),
  ).toBeVisible();
});
