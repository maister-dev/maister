import { readFileSync } from "node:fs";
import path from "node:path";

import { test, expect, type Locator, type Page } from "@playwright/test";

type M27Fixture = {
  projectSlug: string;
  flowRunId: string;
  scratchRunId: string;
};

function loadM27Fixture(): M27Fixture {
  const all = JSON.parse(
    readFileSync(path.resolve("e2e/.auth/fixtures.json"), "utf8"),
  ) as { byKey: { m27: M27Fixture } };

  return all.byKey.m27;
}

function lifecycleActions(page: Page): Locator {
  return page
    .locator("main")
    .getByTestId("workbench-lifecycle-actions")
    .filter({ has: page.getByRole("button", { name: "Commit" }) })
    .first();
}

async function expectLifecycleActions(page: Page): Promise<void> {
  const actions = lifecycleActions(page);

  await expect(actions).toBeVisible();
  await expect(actions.getByRole("button", { name: "Archive" })).toBeVisible();
  await expect(actions.getByRole("button", { name: "Drop" })).toBeVisible();
  await expect(actions.getByRole("button", { name: "Commit" })).toBeVisible();
  await expect(actions.getByRole("button", { name: "Handoff" })).toBeVisible();
}

test.describe.configure({ mode: "serial" });

test("workbench lifecycle actions render across surfaces and execute handoff flow", async ({
  page,
}, testInfo) => {
  const fx = loadM27Fixture();

  await page.goto("/");
  await expect(
    page.getByRole("link", { name: "MAIster E2E M27 Lifecycle" }),
  ).toBeVisible();
  await expectLifecycleActions(page);

  await page.goto(`/projects/${fx.projectSlug}`);
  await expect(page.getByRole("heading", { name: /M27 Lifecycle/i })).toBeVisible();
  await expectLifecycleActions(page);

  await page.goto(`/scratch-runs/${fx.scratchRunId}`);
  await expect(page.getByRole("heading", { name: /M27 scratch lifecycle/i }))
    .toBeVisible();
  await expectLifecycleActions(page);

  await page.goto(`/runs/${fx.flowRunId}`);
  await expectLifecycleActions(page);
  await testInfo.attach("m27-run-detail-desktop", {
    body: await page.screenshot({ fullPage: true }),
    contentType: "image/png",
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await expectLifecycleActions(page);
  await testInfo.attach("m27-run-detail-mobile", {
    body: await page.screenshot({ fullPage: true }),
    contentType: "image/png",
  });
  await page.setViewportSize({ width: 1280, height: 900 });

  await lifecycleActions(page).getByRole("button", { name: "Commit" }).click();
  let dialog = page.getByRole("dialog", { name: "Snapshot commit" });

  await expect(dialog).toBeVisible();
  await Promise.all([
    page.waitForResponse(
      (response) =>
        response.url().endsWith(`/api/runs/${fx.flowRunId}/snapshot-commit`) &&
        response.status() === 200,
    ),
    dialog.getByRole("button", { name: "Commit" }).click(),
  ]);
  await expect(dialog).toContainText("Snapshot commit");
  await dialog.getByRole("button", { name: "Cancel" }).click();

  await lifecycleActions(page).getByRole("button", { name: "Handoff" }).click();
  dialog = page.getByRole("dialog", { name: "Branch handoff" });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator("select")).toHaveValue("origin");
  await Promise.all([
    page.waitForResponse(
      (response) =>
        response.url().endsWith(`/api/runs/${fx.flowRunId}/handoff-branch`) &&
        response.status() === 200,
    ),
    dialog.getByRole("button", { name: "Create branch" }).click(),
  ]);
  await expect(dialog).toContainText("git -C");
  await dialog.getByRole("button", { name: "Cancel" }).click();

  await lifecycleActions(page).getByRole("button", { name: "Archive" }).click();
  dialog = page.getByRole("dialog", { name: "Archive workbench" });
  await expect(dialog).toBeVisible();
  await Promise.all([
    page.waitForResponse(
      (response) =>
        response.url().endsWith(`/api/runs/${fx.flowRunId}/archive`) &&
        response.status() === 200,
    ),
    dialog.getByRole("button", { name: "Confirm" }).click(),
  ]);

  await page.goto(`/scratch-runs/${fx.scratchRunId}`);
  await expectLifecycleActions(page);
  await lifecycleActions(page).getByRole("button", { name: "Drop" }).click();
  dialog = page.getByRole("dialog", { name: "Drop workbench" });
  await expect(dialog).toBeVisible();
  const dropResponsePromise = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/api/runs/${fx.scratchRunId}/drop`) &&
      response.status() === 200,
  );

  await dialog.getByRole("button", { name: "Confirm" }).click();

  const dropResponse = await dropResponsePromise;
  const dropBody = (await dropResponse.json()) as {
    workspaceRemoved: boolean;
    runStatus: string;
  };

  expect(dropBody).toMatchObject({
    workspaceRemoved: true,
    runStatus: "Abandoned",
  });
});
