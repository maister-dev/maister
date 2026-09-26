// M35 (T3.5): the scratch run detail on the shared run shell — conversation
// center, composer enablement, the toggleable inspector with change size +
// actions, and the Files/Diff workbench — end-to-end through the real UI + the
// real scratch/diff/file APIs, against the seeded `scratchDetail` fixture
// (e2e/_seed/seed-e2e.ts → seedScratchDetailFixture). ONE scratch run parked at
// dialog_status WaitingForUser with a committed branch diff (README.md), tracked
// files, and a two-message transcript.
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { test, expect } from "@playwright/test";

import { singleValue } from "./_seed/db";
import {
  E2E_HOLD_TURN_MARKER,
  STUB_SESSIONS_DIR,
} from "./_seed/stub-supervisor";

type ScratchDetailFixture = {
  projectSlug: string;
  repoPath: string;
  scratchRunId: string;
  branch: string;
};

function loadScratchDetailFixture(): ScratchDetailFixture {
  const all = JSON.parse(
    readFileSync(path.resolve("e2e/.auth/fixtures.json"), "utf8"),
  ) as { byKey: { scratchDetail: ScratchDetailFixture } };

  return all.byKey.scratchDetail;
}

test("scratch detail lands on the conversation with an enabled composer", async ({
  page,
}) => {
  const fx = loadScratchDetailFixture();

  await page.goto(`/scratch-runs/${fx.scratchRunId}`);

  // The conversation is the primary center; the seeded transcript renders.
  const conversation = page.locator('[data-testid="scratch-conversation"]');

  await expect(conversation).toBeVisible();
  await expect(conversation).toContainText("Please tweak the README.");

  // WaitingForUser → the composer is primary and enabled.
  const composer = page.locator(
    '[data-testid="scratch-message-composer"] [data-testid="capability-composer-input"]',
  );

  await expect(composer).toBeVisible();
  await expect(composer).toBeEditable();
});

test("scratch detail composer suggests project skills before live commands arrive", async ({
  page,
}) => {
  const fx = loadScratchDetailFixture();
  const catalogLoaded = page.waitForResponse(
    (response) => response.url().includes("/capability-catalog"),
    { timeout: 20_000 },
  );

  await page.goto(`/scratch-runs/${fx.scratchRunId}`);
  await catalogLoaded;

  const composer = page.locator(
    '[data-testid="scratch-message-composer"] [data-testid="capability-composer-input"]',
  );

  await composer.click();
  await page.keyboard.type("/aif");

  const item = page.locator(
    '[data-testid="capability-suggestion-item"][data-slug="aif-plan"]',
  );

  await expect(item).toBeVisible({ timeout: 10_000 });
});

test("scratch detail composer submits with Cmd or Ctrl Enter", async ({
  page,
}) => {
  const fx = loadScratchDetailFixture();
  const posted = page.waitForRequest(
    (request) =>
      request.method() === "POST" &&
      request.url().includes(`/api/scratch-runs/${fx.scratchRunId}/messages`),
  );

  await page.route(
    `**/api/scratch-runs/${fx.scratchRunId}/messages`,
    async (route) => {
      if (route.request().method() !== "POST") {
        await route.continue();

        return;
      }

      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true }),
      });
    },
  );
  await page.goto(`/scratch-runs/${fx.scratchRunId}`);

  const composer = page.locator(
    '[data-testid="scratch-message-composer"] [data-testid="capability-composer-input"]',
  );

  await composer.click();
  await page.keyboard.type("Keyboard submit check");
  await page.keyboard.press("ControlOrMeta+Enter");

  const request = await posted;
  const payload = request.postDataJSON() as { content?: string };

  expect(payload.content).toBe("Keyboard submit check");
});

test("scratch inspector toggles and surfaces change size + actions", async ({
  page,
}) => {
  const fx = loadScratchDetailFixture();

  await page.goto(`/scratch-runs/${fx.scratchRunId}`);

  await expect(page.locator('[data-testid="run-shell"]')).toBeVisible();
  await expect(
    page.locator('[data-testid="run-shell-inspector"]'),
  ).toBeVisible();
  await expect(page.locator('[data-testid="run-inspector"]')).toBeVisible();

  // The committed branch diff (README.md) gives a non-empty change size in the
  // always-visible header summary.
  await expect(
    page.locator('[data-testid="run-header-change-summary"]'),
  ).toContainText("+");

  // The inspector action group: lifecycle actions + promote (existing routes).
  await expect(
    page.locator('[data-testid="scratch-inspector-actions"]'),
  ).toBeVisible();
  await expect(page.locator('[data-testid="scratch-promote"]')).toBeVisible();

  // The inspector toggles closed and back open.
  await page.getByRole("button", { name: "Close inspector" }).click();
  await expect(page.locator('[data-testid="run-shell-inspector"]')).toHaveCount(
    0,
  );
  await page.getByRole("button", { name: "Open inspector" }).click();
  await expect(
    page.locator('[data-testid="run-shell-inspector"]'),
  ).toBeVisible();
});

test("scratch workbench exposes the shared Diff renderer and a readable file tree", async ({
  page,
}) => {
  const fx = loadScratchDetailFixture();

  await page.goto(`/scratch-runs/${fx.scratchRunId}?wb=diff`);

  // Diff deep link opens the collapsed Files/Diff workbench and selects Diff.
  await expect(page.getByTestId("workbench-disclosure")).toBeVisible();
  await expect(page.locator('[data-testid="run-diff"]')).toBeVisible();
  await expect(page.locator('[data-testid="diff-view"]')).toBeVisible();

  // Files tab → the tracked file tree; a member can open a file into the pane.
  await page.getByRole("tab", { name: "Files" }).click();
  await page.waitForURL(/[?&]wb=files/);
  await expect(page.locator('[data-testid="file-tree"]')).toBeVisible();
  await expect(
    page.locator('[data-testid="file-tree-entry"]', { hasText: "README.md" }),
  ).toBeVisible();

  // Open the tracked Markdown file → the shared file pane renders the rich
  // Markdown view inside the copy-to-clipboard header (M35 T4.2), reusing the
  // same readRepoFiles + repoRelPathSchema path as flow runs.
  await page
    .locator('[data-testid="file-tree-entry"][data-entry-type="file"]', {
      hasText: "README.md",
    })
    .click();
  await page.waitForURL(/[?&]file=README\.md/);
  await expect(page.locator('[data-testid="file-pane-shell"]')).toBeVisible();
  await expect(page.locator('[data-testid="file-copy-button"]')).toBeVisible();
  await expect(
    page.locator('[data-testid="markdown-rich-view"]'),
  ).toBeVisible();
});

// ADR-182 (T4.6): a message sent while the agent is busy is accepted by the
// server — the test supervisor advertises no steering, so it is QUEUED behind
// the running turn and dispatched when that turn ends. The browser holds no
// queue of its own. The launch prompt carries the seed's hold marker, so its
// turn stays open until the spec drops `<sessionId>.turn-release`.
test("sending while the agent is busy shows a Queued row and the composer stays usable", async ({
  page,
}) => {
  test.setTimeout(150_000);
  const fx = loadScratchDetailFixture();
  const projectId = await singleValue<string>(
    "SELECT id AS value FROM projects WHERE slug = $1",
    [fx.projectSlug],
  );
  const name = `Busy send ${randomUUID().slice(0, 8)}`;
  // The launch answers after its first turn, which the seed holds: fire it
  // and find the run in the database.
  const launching = page.request.post("/api/scratch-runs", {
    data: {
      projectId,
      baseBranch: "main",
      name,
      // The fixture's own branch `maister/<slug>` would shadow the derived
      // `maister/<slug>/scratch/...` ref.
      branchName: `e2e-busy-send/${randomUUID().slice(0, 8)}`,
      prompt: `${E2E_HOLD_TURN_MARKER} Keep working until told otherwise.`,
      reasoningEffort: "high",
      attachments: [],
    },
    timeout: 150_000,
  });
  let runId: string | null = null;
  let launchFailure: string | null = null;

  // The launch streams its stages; a refusal after the headers is an error
  // frame in a 200 body, and a held first turn never finishes the body.
  void launching.then(
    async (launch) => {
      launchFailure = `${launch.status()} ${await launch.text()}`;
    },
    (error: unknown) => {
      launchFailure = String(error);
    },
  );
  await expect
    .poll(
      async () => {
        runId = await singleValue<string>(
          "SELECT run_id AS value FROM scratch_runs WHERE name = $1",
          [name],
        );

        if (!runId && launchFailure)
          throw new Error(`launch ended without a run: ${launchFailure}`);

        return runId
          ? singleValue<string>(
              "SELECT dialog_status AS value FROM scratch_runs WHERE run_id = $1",
              [runId],
            )
          : null;
      },
      { timeout: 60_000 },
    )
    .toBe("Running");

  await page.goto(`/scratch-runs/${runId}`);
  const composer = page.locator(
    '[data-testid="scratch-message-composer"] [data-testid="capability-composer-input"]',
  );

  await expect(page.getByTestId("scratch-composer-stop")).toBeVisible({
    timeout: 30_000,
  });
  await composer.click();
  await page.keyboard.type("Queued while the agent works");
  const sent = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().includes(`/api/scratch-runs/${runId}/messages`),
  );

  await page.getByTestId("scratch-composer-send").click();
  const response = await sent;

  expect(response.status()).toBe(202);
  expect(await response.json()).toMatchObject({
    delivery: "queued",
    dialogStatus: "Running",
  });
  const badge = page.locator(
    '[data-testid="scratch-delivery-badge"][data-delivery="queued"]',
  );

  await expect(badge).toBeVisible({ timeout: 30_000 });
  await expect(badge).toHaveText("Queued");
  await expect(page.getByTestId("scratch-delivery-notice")).toBeVisible();
  // The composer stays usable while the agent works.
  await expect(composer).toBeEditable();

  // End the running turn: the queued message is dispatched as the next turn,
  // so its row loses the badge.
  const hostSessionId = await singleValue<string>(
    "SELECT host_session_id AS value FROM run_sessions WHERE run_id = $1",
    [runId],
  );

  writeFileSync(
    path.join(STUB_SESSIONS_DIR, `${hostSessionId}.turn-release`),
    "",
  );
  await expect(page.getByTestId("scratch-delivery-badge")).toHaveCount(0, {
    timeout: 60_000,
  });
  expect(
    await singleValue<string>(
      "SELECT delivery AS value FROM run_messages WHERE run_id = $1 AND content = $2",
      [runId, "Queued while the agent works"],
    ),
  ).toBe("prompted");
  expect((await launching).status()).toBe(200);
});
