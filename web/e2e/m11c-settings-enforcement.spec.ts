// M11c (ADR-032): node settings VISIBILITY + strict-enforcement REFUSAL,
// end-to-end through the real UI + launch route. Two isolated fixtures
// (e2e/_seed/seed-e2e.ts), each on its OWN project so the `fullyParallel`
// authed specs never race a shared fixture or the m11a/m11b ones:
//
//   • Scenario A `e2e-m11c-visible` — a NeedsInput run parked at a `review`
//     human node; its `implement` ai_coding node carries `settings` with an
//     all-`instruct` enforcement map. The run-detail settings panel reads the
//     pinned manifest, runs evaluateNodeEnforcement, and tags each capability
//     class. Asserts the panel renders the node + an "Instructed" verdict.
//   • Scenario B `e2e-m11c-refuse` — a launchable Backlog task whose enabled
//     flow revision pins an ai_coding `implement` node declaring
//     `enforcement.skills: "strict"`. ADR-130 flipped tools/mcps/hooks to
//     `enforced` but `skills` stays `instructed` (no tool-identity seam mechanism),
//     so launch options expose a typed deterministic refusal and disable Launch
//     before any intent/worktree/run/workspace is created. Direct canonical
//     POST refusal remains covered by the real API integration suite. This
//     browser case checks actionable node/class copy and the zero-effect path.
import type { NodeEnforcementRefusal } from "@/lib/flows/enforcement-refusal";

import { readFileSync } from "node:fs";
import path from "node:path";

import { test, expect } from "@playwright/test";

import { singleValue } from "./_seed/db";

type VisibleFixture = {
  runId: string;
  hitlRequestId: string;
  projectSlug: string;
  branch: string;
  worktreePath: string;
};

type RefuseFixture = {
  projectSlug: string;
  taskId: string;
  nodeId: string;
  refusedClass: string;
};

function loadFixtures(): {
  m11cVisible: VisibleFixture;
  m11cRefuse: RefuseFixture;
} {
  const all = JSON.parse(
    readFileSync(path.resolve("e2e/.auth/fixtures.json"), "utf8"),
  ) as { byKey: { m11cVisible: VisibleFixture; m11cRefuse: RefuseFixture } };

  return all.byKey;
}

test("scenario A — node settings are visible on the run-detail panel", async ({
  page,
}) => {
  const { m11cVisible: fx } = loadFixtures();

  await page.goto(`/runs/${fx.runId}`);

  // T-C1 relocated the node-settings block out of the run-detail center into the
  // run-inspector "Flow" tab, where it renders as a collapsed <details>. The
  // inspector is open by default (RunShell defaultInspectorOpen); select the Flow
  // tab and expand the disclosure so the panel — and its <h2> title heading
  // (i18n run.settingsTitle) — enter the accessibility tree.
  const inspector = page.getByTestId("run-inspector");

  await inspector.getByRole("tab", { name: "Flow", exact: true }).click();
  await page
    .getByTestId("flow-extras")
    .locator("summary", { hasText: "Node settings" })
    .click();

  const panel = page.getByRole("heading", {
    name: "Node settings",
    exact: true,
  });

  await expect(panel).toBeVisible();

  // The ai_coding node id is listed in the panel.
  const section = panel.locator("xpath=ancestor::section[1]");

  await expect(section.getByText("implement", { exact: true })).toBeVisible();

  // At least one capability class is tagged "Instructed" (run.settingsVerdictInstructed)
  // — proof the panel ran evaluateNodeEnforcement against the pinned manifest.
  await expect(
    section.getByText("Instructed", { exact: true }).first(),
  ).toBeVisible();

  // And nothing resolved to "Refused" on this all-instruct manifest.
  await expect(section.getByText("Refused", { exact: true })).toHaveCount(0);
});

test("scenario B — strict enforcement refuses the launch with CONFIG (no run created)", async ({
  page,
}) => {
  const { m11cRefuse: fx } = loadFixtures();

  await page.goto(`/projects/${fx.projectSlug}`);

  // The launchable Backlog task card is on the board with a Launch control.
  const board = page.locator("[data-board]");
  const card = board.locator("article", {
    hasText: "E2E strict refusal",
  });

  await expect(card).toBeVisible();

  // ADR-087 launch popover: the card button opens a dialog; the POST fires
  // from its confirm button.
  const launch = card.getByRole("button", { name: "Launch", exact: true });

  await expect(launch).toBeVisible();
  await expect(launch).toBeEnabled();
  const optionsResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());

    return (
      url.pathname === "/api/runs/launch-options" &&
      url.searchParams.get("taskId") === fx.taskId &&
      response.request().method() === "GET"
    );
  });

  await launch.click();

  const dialog = page.getByTestId("task-launch-dialog");

  await expect(dialog).toBeVisible();

  const createRun = dialog.getByRole("button", {
    name: "Launch",
    exact: true,
  });

  const response = await optionsResponse;
  const body: {
    enforcementRefusal: NodeEnforcementRefusal;
    launchability: { launchable: boolean; reason: string };
    relaunch: { launchable: boolean; reason: string };
  } = await response.json();

  expect(response.status()).toBe(200);
  expect(body.enforcementRefusal).toMatchObject({
    reason: "flow_settings_enforcement_refused",
    nodeId: fx.nodeId,
    capabilityClass: fx.refusedClass,
    declared: "strict",
    capability: "instructed",
  });
  expect(body.launchability).toMatchObject({
    launchable: false,
    reason: "flow_settings_enforcement_refused",
  });
  expect(body.relaunch).toMatchObject({
    launchable: false,
    reason: "flow_settings_enforcement_refused",
  });
  await expect(createRun).toBeDisabled();
  const refusal = dialog.getByRole("alert").filter({ hasText: fx.nodeId });

  await expect(refusal).toContainText(fx.refusedClass);
  await expect(refusal).toContainText("Adjust the Flow enforcement setting");
  for (const table of ["task_launch_intents", "runs"])
    expect(
      await singleValue<number>(
        `SELECT count(*)::int AS value FROM ${table} WHERE task_id=$1`,
        [fx.taskId],
      ),
    ).toBe(0);

  // No run was created — reload the board and assert the task is still in
  // Backlog (its Launch control re-renders) and no flight card links a run for
  // it. A successful launch would have moved the task to an in-flight column
  // with a /runs/<id> link instead.
  await page.goto(`/projects/${fx.projectSlug}`);

  const reloadedCard = page.locator("[data-board] article", {
    hasText: "E2E strict refusal",
  });

  await expect(reloadedCard).toBeVisible();
  await expect(
    reloadedCard.getByRole("button", { name: "Launch", exact: true }),
  ).toBeVisible();
  await expect(page.locator('[data-board] a[href^="/runs/"]')).toHaveCount(0);
});
