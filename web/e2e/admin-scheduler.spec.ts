import { expect, test } from "@playwright/test";

test("admin scheduler exposes its recovery clock before scheduler queues", async ({
  page,
}) => {
  await page.goto("/admin/scheduler");

  await expect(
    page.getByRole("heading", { name: "Scheduler", level: 1 }),
  ).toBeVisible();

  const clock = page.getByRole("heading", { name: "Scheduler clock" });
  const brain = page.getByRole("heading", { name: "Brain index queue" });

  await expect(clock).toBeVisible();
  await expect(
    page.getByText("system_sweep.default", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("domain_event_dispatch.default", { exact: true }),
  ).toBeVisible();
  await expect(brain).toBeVisible();

  const clockBox = await clock.boundingBox();
  const brainBox = await brain.boundingBox();

  expect(clockBox?.y).toBeLessThan(brainBox?.y ?? Number.POSITIVE_INFINITY);
});
