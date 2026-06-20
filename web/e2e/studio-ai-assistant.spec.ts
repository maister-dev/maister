import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { test, expect } from "@playwright/test";

// M36 Phase 5 (ADR-097) T5.9 — the docked AI authoring assistant walk: install a
// package, FORK it to a local package, land in /studio/edit, switch to the AI
// tab, start the assistant, and confirm the conversation renders. The launch +
// turn + project-less plumbing is exhaustively integration-tested
// (lib/scratch-runs/__tests__/local-package-assistant.integration.test.ts);
// this e2e covers ONLY the UI path the integration tests cannot — the
// Properties⇆AI toggle + launch wiring — against the e2e stub supervisor (which
// answers /sessions create/prompt/stream/delete; no real agent spawns). Mirrors
// studio-local-edit.spec.ts for the install→fork→editor navigation.
const RUN_TAG = `e2eai${Date.now().toString(36)}`;

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "e2e",
      GIT_AUTHOR_EMAIL: "e2e@test",
      GIT_COMMITTER_NAME: "e2e",
      GIT_COMMITTER_EMAIL: "e2e@test",
    },
  });
}

function buildPackageRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "maister-e2e-ai-"));

  git(repo, "init", "-b", "main");
  const pkgDir = join(repo, "packages", RUN_TAG);

  mkdirSync(join(pkgDir, "flows/e2e-flow"), { recursive: true });
  writeFileSync(
    join(pkgDir, "maister-package.yaml"),
    `schemaVersion: 1\nname: ${RUN_TAG}\nflows:\n  - { id: ${RUN_TAG}-flow, path: flows/e2e-flow }\n`,
  );
  writeFileSync(
    join(pkgDir, "flows/e2e-flow/flow.yaml"),
    `schemaVersion: 1\nname: ${RUN_TAG}-flow\nsteps:\n  - id: s1\n    type: cli\n    command: echo hi\n`,
  );
  git(repo, "add", "-A");
  git(repo, "commit", "-m", "init");
  git(repo, "tag", `${RUN_TAG}/v1.0.0`);

  return repo;
}

test("docked AI assistant: open the AI tab and start the assistant from the editor", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const repo = buildPackageRepo();

  // Install → fork-to-local → editor (mirrors studio-local-edit.spec.ts).
  await page.goto("/studio/sources");
  await page.getByRole("button", { name: "Add package source" }).click();
  const dialog = page.getByRole("dialog");

  await dialog.getByLabel("Git monorepo URL").fill(repo);
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText(repo)).toBeVisible();
  await page
    .locator("tr", { hasText: repo })
    .getByRole("button", { name: "Refresh", exact: true })
    .click();
  await expect(page.getByText(RUN_TAG, { exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await page
    .getByRole("button", { name: `${RUN_TAG}/v1.0.0 · install` })
    .click();
  await expect(
    page.getByRole("button", { name: `${RUN_TAG}/v1.0.0 · installed` }),
  ).toBeVisible({ timeout: 30_000 });

  await page.goto(`/studio/packages/${RUN_TAG}`);
  await page.getByTestId("package-fork").click();
  await page.waitForURL(/\/studio\/edit\//, { timeout: 30_000 });

  // Switch to the AI tab. The working-dir lock acquires on mount, enabling the
  // launch control.
  await page.getByTestId("local-editor-tab-ai").click();
  await expect(page.getByTestId("studio-ai-tab")).toBeVisible();

  const launch = page.getByTestId("studio-ai-launch");

  await expect(launch).toBeEnabled({ timeout: 15_000 });
  await page
    .getByTestId("studio-ai-prompt")
    .fill("Add a review gate to the flow");

  // Launching POSTs to the assistant route (asserts the lock) → the stub
  // supervisor session drives the conversation surface into view.
  const launchResponse = page.waitForResponse(
    (response) =>
      /\/api\/studio\/local-packages\/[^/]+\/assistant$/.test(response.url()) &&
      response.request().method() === "POST",
  );

  await launch.click();
  expect((await launchResponse).status()).toBe(202);

  // The transcript surface (reused ScratchConversation) renders for the run.
  await expect(page.getByTestId("scratch-conversation")).toBeVisible({
    timeout: 30_000,
  });
});
