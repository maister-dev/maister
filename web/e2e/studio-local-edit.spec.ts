import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { test, expect, type Page } from "@playwright/test";

// M36 Phase 2 — the editable-local-package walk: install a package, FORK it to a
// local package from the viewer, and land in the /studio/edit editor. The fork
// API + cut-version + the working-dir save/lock are exhaustively integration-
// tested (lib/local-packages/__tests__/{fork-cut,working-dir-files,service}.
// integration.test.ts); this e2e covers the UI navigation the integration tests
// cannot — viewer → Fork-to-local → editor route. The install flow mirrors
// package-management.spec.ts.
const RUN_TAG = `e2elocal${Date.now().toString(36)}`;
const PICKER_RUN_TAG = `e2epicker${Date.now().toString(36)}`;

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
  const repo = mkdtempSync(join(tmpdir(), "maister-e2e-local-"));

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

function buildReferencePickerPackageRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "maister-e2e-picker-"));

  git(repo, "init", "-b", "main");
  const pkgDir = join(repo, "packages", PICKER_RUN_TAG);

  mkdirSync(join(pkgDir, "flows/e2e-flow"), { recursive: true });
  mkdirSync(join(pkgDir, "maister-agents"), { recursive: true });
  mkdirSync(join(pkgDir, "schemas"), { recursive: true });
  writeFileSync(
    join(pkgDir, "maister-package.yaml"),
    `schemaVersion: 1\nname: ${PICKER_RUN_TAG}\nflows:\n  - { id: ${PICKER_RUN_TAG}-flow, path: flows/e2e-flow }\n`,
  );
  writeFileSync(
    join(pkgDir, "maister-agents/reviewer.md"),
    `---\nname: reviewer\ndescription: Reviews release plans\n---\n# Reviewer\n`,
  );
  writeFileSync(
    join(pkgDir, "schemas/intake.json"),
    `{"schemaVersion":1,"fields":[]}\n`,
  );
  writeFileSync(
    join(pkgDir, "flows/e2e-flow/flow.yaml"),
    `schemaVersion: 1
name: ${PICKER_RUN_TAG}-flow
compat:
  engine_min: 1.9.0
nodes:
  - id: decide_release
    type: consensus
    prompt: "Produce a release plan."
    participants:
      - id: architect
        runner: codex
      - id: reviewer
        runner: codex
    material_axes:
      - scope_matches_milestone
    rounds:
      mode: single_pass
      max: 1
    on_no_consensus: escalate
    synthesizer:
      runner: codex
    output:
      produces:
        - id: consensus_plan
          kind: plan
          current: true
        - id: debate_log
          kind: human_note
          current: true
  - id: intake
    type: form
    settings:
      form_schema: ./schemas/intake.json
`,
  );
  git(repo, "add", "-A");
  git(repo, "commit", "-m", "init");
  git(repo, "tag", `${PICKER_RUN_TAG}/v1.0.0`);

  return repo;
}

async function installPackageFromRepo(
  page: Page,
  repo: string,
  tag: string,
): Promise<void> {
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
  await expect(page.getByText(tag, { exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await page.getByRole("button", { name: `${tag}/v1.0.0 · install` }).click();
  await expect(
    page.getByRole("button", { name: `${tag}/v1.0.0 · installed` }),
  ).toBeVisible({ timeout: 30_000 });
}

async function selectGraphNode(page: Page, nodeId: string): Promise<void> {
  const node = page.locator(`.react-flow__node[data-id="${nodeId}"]`);

  await page.getByTestId("flow-graph-editor").scrollIntoViewIfNeeded();
  await expect(node).toBeVisible();
  await node.dispatchEvent("click");
}

test("fork an installed package to local → land in the /studio/edit editor", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const repo = buildPackageRepo();

  // Install the package (source → discovery → install), mirroring package-management.
  await installPackageFromRepo(page, repo, RUN_TAG);

  // Fork-to-local from the package viewer → clone into a local package + open
  // the editor (the route changes to /studio/edit/{localPackageId}).
  await page.goto(`/studio/packages/${RUN_TAG}`);
  await page.getByTestId("package-fork").click();
  await page.waitForURL(/\/studio\/edit\//, { timeout: 30_000 });
  expect(page.url()).toMatch(/\/studio\/edit\//);

  // M39 (ADR-105): the no-path editor lands on the package HOME (overview +
  // manifest form), NOT an empty flow canvas — so there is no spurious
  // "YAML is invalid" sync banner. End-edit releases the lock and returns to the
  // local list.
  const editId = page.url().match(/\/studio\/edit\/([^/?#]+)/)?.[1];

  expect(editId).toBeTruthy();
  await page.goto(`/studio/edit/${editId}`);
  await expect(page.getByTestId("package-home")).toBeVisible();
  await expect(page.getByTestId("package-manifest-form")).toBeVisible();
  await expect(page.getByTestId("flow-yaml-sync-error")).toHaveCount(0);
  await page.getByTestId("local-editor-end-edit").click();
  await page.waitForURL(/\/studio\/local$/, { timeout: 15_000 });
});

test("local editor reference pickers save runner, agent, free-text agent, and schema draft", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const repo = buildReferencePickerPackageRepo();

  await installPackageFromRepo(page, repo, PICKER_RUN_TAG);

  await page.goto(`/studio/packages/${PICKER_RUN_TAG}`);
  await page.getByTestId("package-fork").click();
  await page.waitForURL(/\/studio\/edit\//, { timeout: 30_000 });

  const editId = page.url().match(/\/studio\/edit\/([^/?#]+)/)?.[1];

  expect(editId).toBeTruthy();
  await page.goto(`/studio/edit/${editId}/flows/e2e-flow/flow.yaml`);
  await expect(page.getByTestId("flow-graph-editor")).toBeVisible({
    timeout: 15_000,
  });
  await selectGraphNode(page, "decide_release");
  await expect(
    page.getByTestId("node-consensus-participant-source-0"),
  ).toBeVisible();

  await page.getByTestId("node-consensus-participant-source-0").fill("codex");
  await page.getByTestId("node-consensus-participant-source-1").click();
  await page
    .getByTestId("node-consensus-participant-source-1-option")
    .filter({ hasText: "reviewer" })
    .first()
    .click();
  await page
    .getByTestId("node-consensus-synthesizer-source")
    .fill("external-agent");
  await page
    .getByTestId("node-consensus-synthesizer-source-unknown")
    .getByRole("button", { name: "as agent" })
    .click();

  await selectGraphNode(page, "intake");
  await expect(page.getByTestId("node-form-schema")).toBeVisible();
  await page.getByTestId("node-form-schema-title").fill("Review intake");
  await page
    .getByTestId("node-form-schema-json")
    .fill('{"schemaVersion":1,"fields":[{"name":"decision","type":"string"}]}');
  await page.getByTestId("node-form-schema-create").click();

  const flowYamlInput = page.locator('input[name="flowYaml"]');

  await expect(flowYamlInput).toHaveValue(/runner: codex/);
  await expect(flowYamlInput).toHaveValue(
    new RegExp(`${PICKER_RUN_TAG}-local:reviewer`),
  );
  await expect(flowYamlInput).toHaveValue(/agent: external-agent/);
  await expect(flowYamlInput).toHaveValue(/review-intake/);
  await expect(page.locator('input[name="packageFilesJson"]')).toHaveValue(
    /schemas\/review-intake\.json/,
  );

  await expect(page.getByTestId("topbar-save")).toBeEnabled();
  await page.getByTestId("topbar-save").click();
  await page.waitForLoadState("networkidle");

  await page.goto(`/studio/edit/${editId}`);
  await expect(page.getByTestId("package-home")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "review-intake.json", exact: true }),
  ).toBeVisible();
});
