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
//     `enforcement.mcps: "strict"`. On the FROZEN all-instructed enforceability
//     table no agent can strictly enforce `mcps`, so clicking Launch refuses
//     with CONFIG (400) BEFORE any worktree/run/workspace is created — no
//     silent escape hatch. Asserts the UI surfaces the refusal and no run is
//     created (the task stays in Backlog).
//
// REFUSAL-ASSERTION PATH: the REAL UI Launch click (preferred). The board's
// LaunchButton (components/board/launch-button.tsx) POSTs /api/runs and, on a
// non-2xx, renders the typed `code` as the button label — so a CONFIG refusal
// turns the button text into "CONFIG", which is deterministically assertable.
// The same POST is intercepted to pin status 400 + body {code:"CONFIG"} and
// confirm the message names the node id + class. The e2e stub supervisor
// (e2e/_seed/stub-supervisor.ts) answers `/health` ready so the button is
// enabled and the launch reaches the settings-enforcement gate; it never
// implements `/sessions`, so no agent is spawned.
import { readFileSync } from "node:fs";
import path from "node:path";

import { test, expect } from "@playwright/test";

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

  // The settings panel renders under its title (i18n run.settingsTitle).
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

  const launch = card.getByRole("button", { name: "launch", exact: true });

  await expect(launch).toBeVisible();
  await expect(launch).toBeEnabled();

  // Intercept the launch POST: it must refuse with CONFIG (400) at the
  // settings-enforcement gate and the message must name the node id + class.
  const launchResponse = page.waitForResponse(
    (r) => r.url().endsWith("/api/runs") && r.request().method() === "POST",
  );

  await launch.click();

  const res = await launchResponse;

  expect(res.status()).toBe(400);

  const body = (await res.json()) as { code?: string; message?: string };

  expect(body.code).toBe("CONFIG");
  expect(body.message).toContain(fx.nodeId); // "implement"
  expect(body.message).toContain(fx.refusedClass); // "mcps"

  // The UI surfaces the refusal: the LaunchButton renders the typed code.
  await expect(
    card.getByRole("button", { name: "CONFIG", exact: true }),
  ).toBeVisible();

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
    reloadedCard.getByRole("button", { name: "launch", exact: true }),
  ).toBeVisible();
  await expect(page.locator('[data-board] a[href^="/runs/"]')).toHaveCount(0);
});
