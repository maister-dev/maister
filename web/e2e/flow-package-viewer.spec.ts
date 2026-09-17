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
// drive the real contenteditable).
//
// Scoped to `flow-yaml-editor`, NOT `page.locator(".cm-content").first()`. The
// editor page mounts several CodeMirror instances (the manifest plus a per-file
// editor), they hydrate independently, and DOM order is not guaranteed while
// they do — so `.first()` sometimes selected the file editor and typed the
// manifest into it. The test then failed at the hidden-input check with the
// ORIGINAL yaml, one run in two.
async function replaceEditorContent(page: Page, text: string): Promise<void> {
  const content = page
    .getByTestId("flow-yaml-editor")
    .locator(".cm-content")
    .first();

  await expect(content).toBeVisible();

  // Click until focus actually lands in this editor. CodeMirror's
  // contenteditable does not reliably take focus from the first click here: the
  // editor arrives through a dynamic ssr:false import and React can re-render
  // underneath the click, leaving `document.activeElement` on <body>. Every
  // keystroke after that is swallowed SILENTLY — the buffer keeps its original
  // text and the failure only surfaces later, at the hidden-input check, as if
  // the form were broken. Measured directly: on the failing runs activeElement
  // was the body element, on the passing ones `cm-content`.
  await expect
    .poll(
      async () => {
        await content.click();

        return content.evaluate((el) => document.activeElement === el);
      },
      { intervals: [100, 250, 500, 1000], timeout: 15_000 },
    )
    .toBe(true);

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

  // The tab renders one block per ATTACHED package, each with a flow-preview
  // card per member flow. That card's title links to the project package
  // viewer and is labelled `metadata.title ?? flow.id` — the fixture manifest
  // carries no `metadata`, so it reads as the flow ref. This card is the only
  // remaining inbound link to the viewer; the tab stopped listing flow rows.
  //
  // Scope to the card. The package block's own header link carries the same
  // text (package name and flow ref coincide here) but goes to the STUDIO
  // viewer, so an unscoped `.first()` navigates to the wrong one of the two.
  await page
    .getByTestId("flow-preview-card")
    .getByRole("link", { name: fx.flowRefId })
    .first()
    .click();

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
    page.locator(`.react-flow__node[data-id="${fx.implementNode}"]`),
  ).toBeVisible();
  await expect(
    page.locator(`.react-flow__node[data-id="${fx.reviewNode}"]`),
  ).toBeVisible();

  // 2. The raw flow.yaml is shown read-only (CodeEditor kind="flow"); it carries
  //    the seeded manifest name. It now sits behind a collapsed disclosure —
  //    the graph above is the primary view — and the editor is not merely
  //    hidden but UNMOUNTED until the toggle is clicked, so the locator finds
  //    nothing at all before this.
  await page.getByTestId("flow-yaml-toggle").click();
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
  // the raw-YAML tab. Scope to `flow-yaml-editor` rather than relying on the
  // manifest being the FIRST CodeMirror on the page — it shares the page with
  // the per-file editor and their mount order is not guaranteed.
  await page.getByTestId("flow-tab-yaml").click();

  const yamlBuffer = page
    .getByTestId("flow-yaml-editor")
    .locator(".cm-content")
    .first();

  await expect(yamlBuffer).toBeVisible();
  await expect(yamlBuffer).toContainText("flow-package-viewer-demo");

  // 5. Edit + Save the draft, then reload to prove it persisted.
  const savedName = "Forked Viewer Saved";
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

  await replaceEditorContent(page, validManifest);
  // Wait for the React state flush to reach the hidden form input before
  // submitting — a loaded host can otherwise post the OLD yaml.
  await expect(page.locator('input[name="flowYaml"]')).toHaveValue(
    new RegExp(savedName),
  );

  // Match the server action's POST to THIS route, not merely "any POST". Under
  // parallel load an unrelated POST can settle this wait first, after which the
  // reload below races the save that has not landed yet — the editor then comes
  // back carrying the original manifest.
  const saveResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === new URL(editorUrl).pathname,
  );

  await page.getByRole("button", { name: /save draft/i }).click();
  expect((await saveResponse).status()).toBe(200);

  // No `waitForLoadState("networkidle")` here: the save round-trip is already
  // awaited on the line above, and networkidle cannot settle against a Next dev
  // server anyway — it would only add a 30 s stall to a test that is done.
  await page.goto(editorUrl);

  // The saved manifest still compiles → open the yaml tab again.
  await page.getByTestId("flow-tab-yaml").click();

  const editor = page
    .locator('[data-testid="code-editor"] .cm-content')
    .first();

  await expect(editor).toBeVisible();
  await expect(editor).toContainText(savedName);
});
