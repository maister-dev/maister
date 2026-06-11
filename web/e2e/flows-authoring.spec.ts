// T3.7 (e2e): the ADR-066 Phase-3 CodeMirror authored-Flow editor on
// /flows/<projectSlug>/<capId>. Seeded by e2e/_seed/seed-e2e.ts →
// seedFlowsAuthoringFixture: a DRAFT `flow`-kind authored capability whose
// revision `body.flowYaml` is a valid manifest. Runs as the seeded admin
// (storageState), who is the project owner → canManage → the editor is editable.
//
// Asserted, deterministic outcomes (no supervisor, no real repo):
//   1. mount      — the CodeMirror editor (.cm-editor/.cm-content) renders the
//      seeded flow.yaml with syntax token spans (.cm-content .ͼ* token classes).
//   2. lint       — typing a schema-invalid manifest surfaces a @codemirror/lint
//      error marker (.cm-lintRange-error) after the debounce.
//   3. autocomplete — Ctrl+Space inside the buffer opens .cm-tooltip-autocomplete
//      with the static `agent` step-type option.
//   4. persist    — restoring valid content and clicking Save Draft persists the
//      buffer (the hidden flowYaml input → updateAuthoredFlowAction); after a
//      reload the editor shows the saved manifest and the validation panel
//      reports a status.
import { readFileSync } from "node:fs";
import path from "node:path";

import { test, expect, type Page } from "@playwright/test";

type FlowsAuthoringFixture = {
  projectSlug: string;
  capId: string;
  capSlug: string;
};

function loadFixture(): FlowsAuthoringFixture {
  const all = JSON.parse(
    readFileSync(path.resolve("e2e/.auth/fixtures.json"), "utf8"),
  ) as { byKey: { flowsAuthoring: FlowsAuthoringFixture } };

  return all.byKey.flowsAuthoring;
}

// Replace the whole editor buffer with `text`. CodeMirror owns the DOM, so we
// drive it through the real contenteditable: focus, select-all, type.
async function replaceEditorContent(page: Page, text: string): Promise<void> {
  const content = page.locator(".cm-content").first();

  await content.click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("Delete");
  await page.keyboard.insertText(text);
}

test("the authored-Flow editor mounts CodeMirror with highlighted flow.yaml", async ({
  page,
}) => {
  const fx = loadFixture();

  await page.goto(`/flows/${fx.projectSlug}/${fx.capId}`);

  // The CodeMirror editor mounts (ssr:false dynamic import hydrates).
  const editor = page.locator('[data-testid="code-editor"]').first();

  await expect(editor.locator(".cm-editor")).toBeVisible();
  await expect(editor.locator(".cm-content")).toBeVisible();

  // The seeded manifest text is rendered in the buffer.
  await expect(editor.locator(".cm-content")).toContainText(
    "E2E Authoring Flow",
  );

  // Syntax highlighting ran: the language tokenizer emits highlight token spans
  // (CodeMirror's default highlight style uses generated `.ͼ…` classes on
  // `.cm-content span`). At least one token span is present.
  await expect(editor.locator(".cm-content span").first()).toBeVisible();
  expect(await editor.locator(".cm-content span").count()).toBeGreaterThan(0);
});

test("an invalid manifest surfaces a CodeMirror lint marker", async ({
  page,
}) => {
  const fx = loadFixture();

  await page.goto(`/flows/${fx.projectSlug}/${fx.capId}`);
  await expect(
    page.locator('[data-testid="code-editor"] .cm-content'),
  ).toBeVisible();

  // A schema-invalid manifest (missing required `name` + no steps/nodes) → the
  // flow lint source (flowYamlV1Schema) reports a file-level diagnostic.
  await replaceEditorContent(page, "foo: bar\n");

  // The @codemirror/lint gutter/inline marker appears after the lint debounce.
  await expect(page.locator(".cm-lintRange-error").first()).toBeVisible({
    timeout: 15_000,
  });
});

test("Ctrl+Space opens autocomplete with the agent step-type option", async ({
  page,
}) => {
  const fx = loadFixture();

  await page.goto(`/flows/${fx.projectSlug}/${fx.capId}`);
  await expect(
    page.locator('[data-testid="code-editor"] .cm-content'),
  ).toBeVisible();

  // Type a fresh token prefix on its own line, then trigger completion.
  await replaceEditorContent(page, "schemaVersion: 1\nag");
  await page.keyboard.press("ControlOrMeta+ ");

  const tooltip = page.locator(".cm-tooltip-autocomplete");

  await expect(tooltip).toBeVisible({ timeout: 15_000 });
  await expect(tooltip.getByText("agent", { exact: true })).toBeVisible();
});

test("saving a restored valid manifest persists across reload", async ({
  page,
}) => {
  const fx = loadFixture();
  const savedName = "E2E Authoring Saved";
  const validManifest = `schemaVersion: 1
name: ${savedName}
steps:
  - id: plan
    type: agent
    mode: new-session
    prompt: "do the thing"
`;

  await page.goto(`/flows/${fx.projectSlug}/${fx.capId}`);
  await expect(
    page.locator('[data-testid="code-editor"] .cm-content'),
  ).toBeVisible();

  await replaceEditorContent(page, validManifest);

  // Submit the draft through the existing updateAuthoredFlowAction form. The
  // hidden flowYaml input carries the live buffer — wait for the React state
  // flush to reach it before submitting, or a loaded host posts the OLD yaml.
  await expect(page.locator('input[name="flowYaml"]')).toHaveValue(
    new RegExp(savedName),
  );
  await page.getByRole("button", { name: /save draft/i }).click();

  // The action redirects back to the detail page; reload to read the persisted
  // revision body.
  await page.waitForLoadState("networkidle");
  await page.goto(`/flows/${fx.projectSlug}/${fx.capId}`);

  // The saved manifest now compiles → the editor defaults to the graph tab;
  // open the raw-YAML tab before asserting the persisted buffer.
  await page.getByTestId("flow-tab-yaml").click();

  const editor = page
    .locator('[data-testid="code-editor"] .cm-content')
    .first();

  await expect(editor).toBeVisible();
  await expect(editor).toContainText(savedName);

  // The validation panel reports a status (the server recomputed it on save).
  await expect(
    page.getByText(/Valid|Invalid|Not validated/).first(),
  ).toBeVisible();
});
