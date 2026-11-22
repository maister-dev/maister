import { readFileSync } from "node:fs";
import path from "node:path";

import { test, expect, type Locator } from "@playwright/test";

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

function lifecycleActions(scope: Locator): Locator {
  return scope
    .getByTestId("workbench-lifecycle-actions")
    .filter({ visible: true });
}

// ADR-181 D16: a card keeps Archive/Drop and deep-links the git actions into
// the run's git panel; the run and scratch detail host the panel itself (Commit
// and the handoff branch live there now — the Export dialog is gone).
async function expectLifecycleActions(
  scope: Locator,
  surface: "card" | "detail",
): Promise<void> {
  const actions = lifecycleActions(scope);

  await expect(actions).toBeVisible();
  await expect(actions.getByRole("button", { name: "Archive" })).toBeVisible();
  await expect(actions.getByRole("button", { name: "Drop" })).toBeVisible();
  if (surface === "card") {
    await expect(actions.getByTestId("card-git-snapshotCommit")).toBeVisible();
    await expect(actions.getByTestId("card-git-exportBranch")).toBeVisible();
  } else {
    await expect(actions.getByTestId("workbench-git-open")).toBeVisible();
  }
}

// Five surfaces plus commit, handoff and archive through the run git panel:
// the run-detail route's cold `next dev` compile alone can take most of the
// 30s default (as in run-sync.spec.ts).
test.describe.configure({ mode: "serial", timeout: 120_000 });

test("workbench lifecycle actions render across surfaces and execute handoff flow", async ({
  page,
}, testInfo) => {
  const fx = loadM27Fixture();

  // The project card this asserts on is the portfolio's, and the portfolio is
  // `/projects` since ADR-172 D2.
  await page.goto("/projects");
  await expect(
    page.getByRole("link", { name: "MAIster E2E M27 Lifecycle" }),
  ).toBeVisible();
  await expectLifecycleActions(
    page
      .locator("article li")
      .filter({ has: page.locator(`a[href="/runs/${fx.flowRunId}"]`) }),
    "card",
  );

  await page.goto(`/projects/${fx.projectSlug}`);
  await expect(
    page.getByRole("heading", { name: /M27 Lifecycle/i }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Runs and working copies" }).click();
  const workspaces = page
    .getByTestId("project-workspaces")
    .filter({ visible: true });

  await workspaces.getByRole("link", { name: /E2E M27 lifecycle/i }).click();
  await expectLifecycleActions(workspaces, "card");

  await page.goto(`/scratch-runs/${fx.scratchRunId}`);
  await expect(page).toHaveURL(new RegExp(`/scratch-runs/${fx.scratchRunId}$`));
  await page.getByRole("button", { name: "Open inspector" }).click();
  await expectLifecycleActions(
    page.getByTestId("scratch-inspector-actions"),
    "detail",
  );

  await page.goto(`/runs/${fx.flowRunId}`);
  await expectLifecycleActions(page.getByTestId("run-shell-main"), "detail");
  await testInfo.attach("m27-run-detail-desktop", {
    body: await page.screenshot({ fullPage: true }),
    contentType: "image/png",
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await expectLifecycleActions(page.getByTestId("run-shell-main"), "detail");
  await testInfo.attach("m27-run-detail-mobile", {
    body: await page.screenshot({ fullPage: true }),
    contentType: "image/png",
  });
  await page.setViewportSize({ width: 1280, height: 900 });

  // Commit and the handoff branch go through the run's git panel.
  await lifecycleActions(page.getByTestId("run-shell-main"))
    .getByTestId("workbench-git-open")
    .click();
  await expect(page.getByTestId("git-panel")).toBeVisible();
  await page.getByTestId("git-panel-action-snapshotCommit").click();
  await page
    .getByTestId("git-panel-commit-message")
    .fill("snapshot before handoff");
  await Promise.all([
    page.waitForResponse(
      (response) =>
        response.url().endsWith(`/api/runs/${fx.flowRunId}/snapshot-commit`) &&
        response.status() === 200,
    ),
    page.getByTestId("git-panel-commit-submit").click(),
  ]);

  await page.getByTestId("git-panel-handoff-open").click();

  const handoff = page.getByTestId("git-panel-handoff");

  await expect(handoff).toBeVisible();
  await expect(handoff.locator("select")).toHaveValue("origin");
  await Promise.all([
    page.waitForResponse(
      (response) =>
        response.url().endsWith(`/api/runs/${fx.flowRunId}/handoff-branch`) &&
        response.status() === 200,
    ),
    handoff.getByRole("button", { name: "Create branch" }).click(),
  ]);
  await expect(handoff).toContainText("git -C");

  await lifecycleActions(page.getByTestId("run-shell-main"))
    .getByRole("button", { name: "Archive" })
    .click();
  let dialog = page.getByRole("dialog", { name: "Archive workbench" });

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
  await page.getByRole("button", { name: "Open inspector" }).click();
  const scratchActions = page.getByTestId("scratch-inspector-actions");

  await expectLifecycleActions(scratchActions, "detail");
  await lifecycleActions(scratchActions)
    .getByRole("button", { name: "Drop" })
    .click();
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
