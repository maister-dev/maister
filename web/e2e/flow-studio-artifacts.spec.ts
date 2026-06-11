// T5.1 (e2e): the Flow Studio Phase 2 INTERACTIVE editing journeys deferred
// from Phase 3/4 — artifact frontmatter form + save validation gate, the
// form_schema builder + live preview, live YAML→graph re-seed, and the
// typed-edge modal-on-connect. These close the QA-flagged e2e gap (spec §8.3
// rows 12-16, §8.4 rows 17-18; matrix row "artifact-edit").
//
// All four journeys run on ONE DEDICATED authored `flow` DRAFT seeded by
// e2e/_seed/seed-e2e.ts → seedFlowStudioArtifactsFixture. The spec opens it
// DIRECTLY (page.goto /flows/<slug>/<capId>, like flows-authoring.spec.ts) —
// it does NOT fork the shared installed package. (Forking aif-flow-viewer from
// here raced flow-package-viewer.spec.ts under fullyParallel: both defaulted to
// the same `aif-flow-viewer-fork` slug, both probed it free, one lost the
// (project_id,kind,slug) unique → CONFLICT 409. The dedicated draft removes the
// shared-slug contention entirely.) The draft's body carries skills/demo/SKILL.md,
// schemas/review.json, scripts/run.sh and a graph flow.yaml with two
// presentation-positioned nodes (implement → review); its revision `manifest`
// declares `compat.engine_min`, so the editor's Graph tab is available
// (journeys 3 + 4 need the canvas).
//
// Entry is the single page.goto (the editor); every step after is CLICK/drag.
// Journeys are sequenced so an earlier mutation never invalidates a later
// assertion: 1 (artifact-edit, persists + reloads) → 2 (schema builder, read
// only on the reloaded editor) → typed-edge on the pristine canvas → live
// yaml→graph LAST (it reseeds/remounts the canvas, so it runs after the edge
// journey it would otherwise disturb).
import { readFileSync } from "node:fs";
import path from "node:path";

import { test, expect, type Page } from "@playwright/test";

type FlowStudioArtifactsFixture = {
  projectSlug: string;
  capId: string;
  implementNode: string;
  reviewNode: string;
};

function loadFixture(): FlowStudioArtifactsFixture {
  const all = JSON.parse(
    readFileSync(path.resolve("e2e/.auth/fixtures.json"), "utf8"),
  ) as { byKey: { flowStudioArtifacts: FlowStudioArtifactsFixture } };

  return all.byKey.flowStudioArtifacts;
}

// Open the dedicated authored draft's editor directly (no fork). Returns the
// editor URL so later journeys can reload the same draft in place.
async function openEditor(
  page: Page,
  fx: FlowStudioArtifactsFixture,
): Promise<string> {
  await page.goto(`/flows/${fx.projectSlug}/${fx.capId}`);

  // The editor mounts the CodeMirror buffer seeded from the draft body.
  await expect(
    page.locator('[data-testid="code-editor"] .cm-content').first(),
  ).toBeVisible();

  return page.url();
}

// Open a bundle file in the package-files file tree by its leaf name. The tree
// renders each file as a <button> whose accessible text is the path leaf.
async function openPackageFile(page: Page, leafName: string): Promise<void> {
  await page.getByRole("button", { name: leafName, exact: true }).click();
}

// Replace the whole flow.yaml CodeMirror buffer (the yaml tab) with `text`.
async function replaceYamlEditor(page: Page, text: string): Promise<void> {
  const content = page
    .getByTestId("flow-yaml-editor")
    .locator(".cm-content")
    .first();

  await content.click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("Delete");
  await page.keyboard.insertText(text);
}

// Drag a ReactFlow connection from `source`'s source handle (Position.Right) to
// `target`'s target handle (Position.Left). xyflow starts the connection on the
// handle's mousedown and completes it on mouseup over a valid target handle. We
// drive the raw mouse (not Locator.click) because handles are 6px and sit under
// the connection-line layer — actionability-checked clicks get intercepted. The
// canvas is scrolled into view first so the handle bounding boxes land inside
// the viewport; intermediate moves clear the connection drag threshold.
async function connectNodes(
  page: Page,
  source: string,
  target: string,
): Promise<void> {
  await page
    .locator('[data-testid="flow-graph-editor"]')
    .scrollIntoViewIfNeeded();

  const sourceHandle = page.locator(
    `.react-flow__node[data-id="${source}"] .react-flow__handle-right`,
  );
  const targetHandle = page.locator(
    `.react-flow__node[data-id="${target}"] .react-flow__handle-left`,
  );

  await expect(sourceHandle).toBeVisible();
  await expect(targetHandle).toBeVisible();
  await sourceHandle.scrollIntoViewIfNeeded();

  const from = await sourceHandle.boundingBox();
  const to = await targetHandle.boundingBox();

  if (!from || !to) throw new Error("handle bounding box unavailable");

  const fromX = from.x + from.width / 2;
  const fromY = from.y + from.height / 2;
  const toX = to.x + to.width / 2;
  const toY = to.y + to.height / 2;

  await page.mouse.move(fromX, fromY);
  await page.mouse.down();
  await page.mouse.move((fromX + toX) / 2, (fromY + toY) / 2, { steps: 10 });
  await page.mouse.move(toX, toY, { steps: 10 });
  await page.mouse.up();
}

test("flow studio: artifact form + save gate, form-schema preview, typed edge, live yaml→graph", async ({
  page,
}) => {
  const fx = loadFixture();
  const editorUrl = await openEditor(page, fx);

  // ── Journey 1 — artifact-edit + the per-kind content validation gate (§8.3) ──
  // Open the seeded skill in the file tree → the frontmatter FORM. Clearing the
  // required `description` field must (a) surface the BLOCK content issue inline
  // (the client mirror of the server hard-gate) and (b) be REFUSED by the
  // draft-save hard-gate (CONFIG → not persisted). Restoring + saving lands GREEN.
  await openPackageFile(page, "SKILL.md");

  const descriptionField = page.getByRole("textbox", {
    name: "Description",
    exact: true,
  });

  await expect(descriptionField).toHaveValue(
    "A demo skill bundled with the viewer fixture flow.",
  );

  // Clear `description` → the frontmatter loses a required key → the inline
  // ArtifactContentIssues block surfaces a `frontmatter_field_missing` BLOCK.
  await descriptionField.fill("");
  await expect(
    page.locator('[data-testid="artifact-issue-frontmatter_field_missing"]'),
  ).toBeVisible();

  // Save with the BLOCK present. The server `assertAuthoredFlowContentValid`
  // gate throws CONFIG BEFORE the CAS, so the draft row is NOT mutated.
  await page.getByRole("button", { name: /save draft/i }).click();
  await page.waitForLoadState("networkidle");

  // Reopen the same draft: the cleared description was NEVER persisted (the
  // server BLOCK gate held) — the original frontmatter is intact.
  await page.goto(editorUrl);
  await openPackageFile(page, "SKILL.md");
  await expect(
    page.getByRole("textbox", { name: "Description", exact: true }),
  ).toHaveValue("A demo skill bundled with the viewer fixture flow.");

  // Now make a VALID edit and save → GREEN: the content panel reports clean and
  // the edit persists across a reload.
  const restoredDescription =
    "Demo skill description edited by the artifact e2e.";

  await page
    .getByRole("textbox", { name: "Description", exact: true })
    .fill(restoredDescription);
  await expect(
    page.locator('[data-testid="artifact-content-ok"]'),
  ).toBeVisible();

  await page.getByRole("button", { name: /save draft/i }).click();
  await page.waitForLoadState("networkidle");

  await page.goto(editorUrl);
  await openPackageFile(page, "SKILL.md");
  await expect(
    page.getByRole("textbox", { name: "Description", exact: true }),
  ).toHaveValue(restoredDescription);

  // ── Journey 2 — form_schema builder + live preview (§7.4) ───────────────────
  // Open the seeded schema. The structured builder + the live HitlDecisionControls
  // preview render; editing a field's label is reflected in the preview pane.
  await openPackageFile(page, "review.json");

  await expect(
    page.locator('[data-testid="form-schema-builder"]'),
  ).toBeVisible();

  const preview = page.locator('[data-testid="form-schema-preview"]');

  await expect(preview).toBeVisible();

  // The seeded schema's field 1 is `notes`; retitle its label and assert the
  // live preview re-renders with the new label text (preview reads field.label).
  const newLabel = "Reviewer notes (edited)";
  const notesLabelInput = page
    .locator('[data-testid="form-schema-field-1"]')
    .getByRole("textbox")
    .nth(1);

  await notesLabelInput.fill(newLabel);
  await expect(preview).toContainText(newLabel);

  // ── Journey 4 (run before 3) — typed-edge modal-on-connect (§8.4.18 / 4.7) ──
  // On the pristine canvas, drag a connection implement → review. The modal must
  // open; picking a NEW outcome (`failure`, not yet declared on implement) and
  // confirming routes through setTransition and adds the edge `implement:failure`.
  await page.getByTestId("flow-tab-graph").click();
  await expect(page.getByTestId("flow-graph-editor")).toBeVisible({
    timeout: 15_000,
  });
  await expect(
    page.locator(`.react-flow__node[data-id="${fx.implementNode}"]`),
  ).toBeVisible();

  await connectNodes(page, fx.implementNode, fx.reviewNode);

  const edgeModal = page.locator('[data-testid="edge-connect-modal"]');

  await expect(edgeModal).toBeVisible();

  // `failure` is not yet an outcome on `implement` → no retarget warning; pick it
  // and confirm. The new edge id is `${source}:${outcome}` (upsertEdge).
  await page.locator('[data-testid="edge-connect-suggestion-failure"]').click();
  await page.locator('[data-testid="edge-connect-confirm"]').click();

  await expect(edgeModal).toHaveCount(0);
  await expect(
    page.locator(`[data-testid="rf__edge-${fx.implementNode}:failure"]`),
  ).toBeVisible();

  // ── Journey 3 (last) — live YAML→graph re-seed (§8.4.17 / 4.5) ──────────────
  // Editing the manifest on the yaml tab to ADD a node must re-seed the canvas
  // without a page reload. Switch to yaml, append a cli node, switch back to the
  // graph tab (which flushes the debounced sync) → the new node is on the canvas.
  await page.getByTestId("flow-tab-yaml").click();
  await expect(page.getByTestId("flow-yaml-editor")).toBeVisible();

  const manifestWithExtraNode = [
    "schemaVersion: 1",
    "name: flow-package-viewer-demo",
    "compat:",
    '  engine_min: "1.1.0"',
    "nodes:",
    `  - id: ${fx.implementNode}`,
    "    type: ai_coding",
    "    action:",
    '      prompt: "/aif-implement {{ task.prompt }}"',
    "    transitions:",
    `      success: ${fx.reviewNode}`,
    `  - id: ${fx.reviewNode}`,
    "    type: human",
    "    finish:",
    "      human:",
    "        role: maintainer",
    "        decisions: [approve, rework]",
    "    transitions:",
    `      approve: done`,
    `      rework: ${fx.implementNode}`,
    "  - id: extranode",
    "    type: cli",
    "    action:",
    '      command: "echo hi"',
    "",
  ].join("\n");

  await replaceYamlEditor(page, manifestWithExtraNode);

  // Switching to the graph tab flushes the pending yaml→canvas sync; the added
  // node lands on the canvas (humanizeToken("extranode") → "Extranode") with NO
  // page reload.
  await page.getByTestId("flow-tab-graph").click();
  await expect(page.getByTestId("flow-graph-editor")).toBeVisible({
    timeout: 15_000,
  });
  await expect(
    page.locator('[data-testid="flow-node"]', { hasText: /Extranode/i }),
  ).toBeVisible({ timeout: 15_000 });
});
