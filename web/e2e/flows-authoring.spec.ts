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
//      with the static `ai_coding` node-type option.
//   4. persist    — restoring valid content and clicking Save Draft persists the
//      buffer (the hidden flowYaml input → updateAuthoredFlowAction); after a
//      reload the editor shows the saved manifest and the validation panel
//      reports a status.
import { readFileSync } from "node:fs";
import path from "node:path";

import { test, expect, type Page } from "@playwright/test";

// Every test in this file drives the SAME authored capability —
// `/flows/{projectSlug}/{capId}` from one seeded fixture — and it is mutable
// shared state, not a read-only page. `saving a restored valid manifest` calls
// `save draft`, which REPLACES the seeded legacy `steps:` body server-side;
// `an invalid manifest surfaces a lint marker` types unparseable YAML into it.
// Under the root config's `fullyParallel: true` those ran concurrently across
// four workers against that one document, so `legacy steps[] …` could read a
// body another test had already overwritten — which is exactly what it did,
// reporting "YAML is invalid" for a fixture that is valid YAML.
//
// Serial keeps them in file order, where the legacy reader runs before the
// writer. The alternative — a per-test capability — is the better fix and a
// bigger one: it means teaching the seed to mint fixtures per test.
test.describe.configure({ mode: "serial" });

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

test("legacy steps[] stays editable but blocks publish with graph-only remediation", async ({
  page,
}) => {
  const fx = loadFixture();

  await page.goto(`/flows/${fx.projectSlug}/${fx.capId}`);

  await expect(page.getByRole("alert").first()).toContainText(
    "legacy steps[] flows are not supported since engine 3.0.0",
  );
  await expect(page.getByTestId("topbar-publish")).toBeDisabled();
  await expect(
    page.locator('[data-testid="code-editor"] .cm-content').first(),
  ).toBeEditable();
});

test("Ctrl+Space opens autocomplete with the ai_coding node-type option", async ({
  page,
}) => {
  const fx = loadFixture();

  await page.goto(`/flows/${fx.projectSlug}/${fx.capId}`);
  await expect(
    page.locator('[data-testid="code-editor"] .cm-content'),
  ).toBeVisible();

  // Type a fresh token prefix on its own line, then trigger completion.
  // `ai`, not `ag`. `ag` is the prefix of the LEGACY `type: agent`, which the
  // graph-only cut-over renamed to `ai_coding` — `flowYamlCompletions("ag")`
  // now returns [], so CodeMirror had nothing to offer and never opened a
  // tooltip. The test was left pointing at the old vocabulary by the same
  // change that introduced it.
  await replaceEditorContent(page, "schemaVersion: 1\nai");
  // `Control+Space`, NOT `ControlOrMeta+ `. CodeMirror's `completionKeymap`
  // binds `Ctrl-Space` on every platform, while Playwright resolves
  // `ControlOrMeta` to META on macOS — so this pressed Cmd+Space, which
  // CodeMirror has no binding for (and which is Spotlight on a real Mac).
  // The select-all above is a different case: THAT one is genuinely
  // platform-dependent, so it keeps `ControlOrMeta`.
  await page.keyboard.press("Control+Space");

  const tooltip = page.locator(".cm-tooltip-autocomplete");

  await expect(tooltip).toBeVisible({ timeout: 15_000 });
  await expect(tooltip.getByText("ai_coding", { exact: true })).toBeVisible();
});

test("saving a restored valid manifest persists across reload", async ({
  page,
}) => {
  const fx = loadFixture();
  const savedName = "E2E Authoring Saved";
  const validManifest = `schemaVersion: 1
name: ${savedName}
compat:
  engine_min: 3.0.0
nodes:
  - id: plan
    type: ai_coding
    action:
      prompt: "do the thing"
    transitions:
      success: done
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
  // Wait for the server action's OWN response, not for the network to fall
  // quiet. `waitForLoadState("networkidle")` cannot settle against a Next DEV
  // server — the HMR socket and RSC streams keep connections open, so it burned
  // the whole 30 s test budget every run. Playwright discourages it for exactly
  // this reason. The action POSTs back to this route, so its response is the
  // precise "the draft is persisted" signal the reload below depends on.
  const saved = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname ===
        `/flows/${fx.projectSlug}/${fx.capId}`,
  );

  await page.getByRole("button", { name: /save draft/i }).click();
  await saved;

  // Reload to read the persisted revision body.
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
