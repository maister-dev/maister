// T2.5 (e2e): the Flow Studio Phase 2 nav-path exit gate. Seeded by
// e2e/_seed/seed-e2e.ts → seedInstalledPackageFixture: an Enabled `flow` row
// whose enabled `flow_revisions` row points at a REAL on-disk immutable bundle
// (/tmp/maister-e2e/flows/aif-flow-viewer@v0.0.1) carrying a graph manifest with
// presentation-positioned nodes plus skill/rule/schema/script/setup/readme
// files. Runs as the seeded admin (storageState), who is the project owner →
// canManageCatalog → the Fork slot renders and the editor is editable.
//
// The journey is driven by CLICKING (one page.goto to the board as the entry,
// matching the other authed specs):
//   board (Packages tab) → CLICK the package card → viewer
//     → assert: static graph node rendered (honoring presentation), raw
//       flow.yaml visible, and clicking a file in the list shows its content.
//   → CLICK Fork → assert navigation to /flows/{projectSlug}/{capId} (editor)
//   → in the editor, Save the draft → assert it persists across a reload.
import { readFileSync } from "node:fs";
import path from "node:path";

import { test, expect, type Page } from "@playwright/test";

type FlowViewerFixture = {
  projectSlug: string;
  flowRefId: string;
  revisionId: string;
  implementNode: string;
  reviewNode: string;
  sampleFilePath: string;
};

function loadFixture(): FlowViewerFixture {
  const all = JSON.parse(
    readFileSync(path.resolve("e2e/.auth/fixtures.json"), "utf8"),
  ) as { byKey: { flowViewer: FlowViewerFixture } };

  return all.byKey.flowViewer;
}

// Replace the whole CodeMirror buffer with `text` (the editor owns the DOM, so
// drive the real contenteditable). Mirrors flows-authoring.spec.ts.
async function replaceEditorContent(page: Page, text: string): Promise<void> {
  const content = page.locator(".cm-content").first();

  await content.click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("Delete");
  await page.keyboard.insertText(text);
}

test("nav-path: board → package viewer → open file → fork → editor → save", async ({
  page,
}) => {
  const fx = loadFixture();

  // Entry: the project board, Packages tab (the only page.goto; the rest is
  // clicking). The packages panel lists the seeded installed package.
  await page.goto(`/projects/${fx.projectSlug}?tab=packages`);

  // The package card is a stretched <Link> labelled with the flow ref. Click it
  // to land on the viewer.
  await page.getByRole("link", { name: fx.flowRefId }).first().click();

  await expect(page).toHaveURL(
    new RegExp(`/projects/${fx.projectSlug}/packages/${fx.flowRefId}`),
  );

  // 1. The static graph rendered from the stored manifest. A node from the
  //    seeded manifest is visible (the renderer humanizes the node id, so
  //    `implement` → "Implement"). Presentation x/y is honored by the layout;
  //    its visibility is what we assert (no SSE, no run — static mode).
  const nodes = page.locator('[data-testid="flow-node"]');

  await expect(nodes.first()).toBeVisible();
  await expect(
    page.locator('[data-testid="flow-node"]', { hasText: /Implement/i }),
  ).toBeVisible();
  await expect(
    page.locator('[data-testid="flow-node"]', { hasText: /Review/i }),
  ).toBeVisible();

  // 2. The raw flow.yaml is shown read-only (CodeEditor kind="flow"); it carries
  //    the seeded manifest name.
  await expect(
    page.locator('[data-testid="code-editor"] .cm-content').first(),
  ).toContainText("flow-package-viewer-demo");

  // 3. The bundle file list is present; click a file → its content renders. The
  //    skill file frontmatter `name: demo` is a stable anchor.
  const fileList = page.locator('[data-testid="package-file-list"]');

  await expect(fileList).toBeVisible();

  // Each file-list entry is a <Link> whose accessible name is the path PLUS a
  // kind badge (e.g. "skills/demo/SKILL.md skill"); target it by its `?file=`
  // href so the kind badge does not foul an exact-name match.
  await fileList
    .locator(`a[href*="file=${encodeURIComponent(fx.sampleFilePath)}"]`)
    .click();

  await expect(page).toHaveURL(
    new RegExp(`file=${encodeURIComponent(fx.sampleFilePath)}`),
  );
  // The selected-file editor (a SECOND CodeEditor instance) shows the skill body.
  await expect(
    page.getByText("A demo skill bundled with the viewer fixture flow."),
  ).toBeVisible();

  // 4. Fork → the route creates an authored draft and the button navigates to
  //    the editor at /flows/{projectSlug}/{capId}.
  await page
    .locator('[data-testid="package-fork-slot"]')
    .scrollIntoViewIfNeeded();
  await page.locator('[data-testid="package-fork-button"]').click();

  await expect(page).toHaveURL(
    new RegExp(`/flows/${fx.projectSlug}/[0-9a-f-]{36}`),
    { timeout: 15_000 },
  );

  const editorUrl = page.url();

  // The forked manifest compiles → the editor defaults to the graph tab; open
  // the raw-YAML tab so the FIRST CodeMirror buffer is the manifest (not the
  // README file editor below it).
  await page.getByTestId("flow-tab-yaml").click();
  await expect(
    page.locator('[data-testid="code-editor"] .cm-content').first(),
  ).toBeVisible();
  await expect(
    page.locator('[data-testid="code-editor"] .cm-content').first(),
  ).toContainText("flow-package-viewer-demo");

  // 5. Edit + Save the draft, then reload to prove it persisted.
  const savedName = "Forked Viewer Saved";
  const validManifest = `schemaVersion: 1
name: ${savedName}
steps:
  - id: plan
    type: agent
    mode: new-session
    prompt: "do the thing"
`;

  await replaceEditorContent(page, validManifest);
  // Wait for the React state flush to reach the hidden form input before
  // submitting — a loaded host can otherwise post the OLD yaml.
  await expect(page.locator('input[name="flowYaml"]')).toHaveValue(
    new RegExp(savedName),
  );

  const saveResponse = page.waitForResponse(
    (response) => response.request().method() === "POST",
  );

  await page.getByRole("button", { name: /save draft/i }).click();
  expect((await saveResponse).status()).toBe(200);

  await page.waitForLoadState("networkidle");
  await page.goto(editorUrl);

  // The saved manifest still compiles → open the yaml tab again.
  await page.getByTestId("flow-tab-yaml").click();

  const editor = page
    .locator('[data-testid="code-editor"] .cm-content')
    .first();

  await expect(editor).toBeVisible();
  await expect(editor).toContainText(savedName);
});
