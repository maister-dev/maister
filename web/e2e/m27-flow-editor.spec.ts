import { readFileSync } from "node:fs";
import path from "node:path";

import { test, expect, type Page } from "@playwright/test";

type M27Fixture = { projectId: string; projectSlug: string; capId: string };

function loadM27(): M27Fixture {
  const all = JSON.parse(
    readFileSync(path.resolve("e2e/.auth/fixtures.json"), "utf8"),
  ) as { byKey: { m27Editor: M27Fixture } };

  return all.byKey.m27Editor;
}

// The yaml tab is now a CodeMirror editor (T3.2). The live buffer is the source
// of truth carried by the hidden `flowYaml` input (the save payload), so we read
// the buffer from that input rather than scraping CodeMirror's virtualized DOM.
function flowYamlValue(page: Page): Promise<string> {
  return page.getByRole("main").locator('input[name="flowYaml"]').inputValue();
}

// Replace the whole CodeMirror buffer with `text`: focus the contenteditable,
// select-all, delete, insert (mirrors flows-authoring.spec.ts).
async function replaceYamlEditor(page: Page, text: string): Promise<void> {
  const content = page
    .getByRole("main")
    .getByTestId("flow-yaml-editor")
    .locator(".cm-content")
    .first();

  await content.click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("Delete");
  await page.keyboard.insertText(text);
}

// Submit the draft and wait for the server action's OWN response, not for the
// network to fall quiet. `waitForLoadState("networkidle")` cannot settle against
// a Next DEV server — the HMR socket and RSC streams keep connections open, so
// it burned the whole 30 s test budget on every run. The action POSTs back to
// this same route, so its response is the precise "the save round-trip is done"
// signal the reopen below depends on. It is also the right signal for the
// REFUSED save: a rejected draft still posts, and still answers.
async function saveDraft(page: Page, url: string): Promise<void> {
  const saved = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === url,
  );

  await page.getByRole("button", { name: "Save draft" }).click();
  await saved;
}

// M27/T-A9: the flow-graph editor mounts on the authored-flow page; a canvas
// edit (toolbar add-node — robust, not a ReactFlow drag) flows into the shared
// flowYaml, the existing Save form persists it, and the save-time hard-gate
// refuses an invalid manifest leaving the draft unchanged.
test("M27 flow editor: canvas add-node saves + persists; invalid edit refused", async ({
  page,
}) => {
  const fx = loadM27();
  const url = `/flows/${fx.projectSlug}/${fx.capId}`;

  await page.goto(url);

  // Editor mounted: tabs + canvas (dynamic ssr:false) + toolbar add-node.
  await expect(
    page.getByRole("main").getByTestId("flow-editor-tabs"),
  ).toBeVisible();
  await expect(
    page.getByRole("main").getByTestId("flow-graph-editor"),
  ).toBeVisible({
    timeout: 15000,
  });

  const addCli = page.getByRole("main").getByTestId("add-node-cli");

  await expect(addCli).toBeVisible({ timeout: 15000 });

  // Add a cli node via the toolbar; the new id (cli_1) lands in the shared
  // flowYaml → visible on the raw-YAML tab.
  await addCli.click();
  await page.getByRole("main").getByTestId("flow-tab-yaml").click();
  await expect(
    page.getByRole("main").getByTestId("flow-yaml-editor"),
  ).toBeVisible();

  // Retrying assertion: the canvas edit reaches the hidden input on a React
  // state flush, which can lag on a loaded host.
  await expect(
    page.getByRole("main").locator('input[name="flowYaml"]'),
  ).toHaveValue(/cli_1/);

  // Save the draft through the existing updateAuthoredFlowAction form.
  await saveDraft(page, url);

  // Reopen → the added node persisted.
  await page.goto(url);
  await page.getByRole("main").getByTestId("flow-tab-yaml").click();
  await expect(
    page.getByRole("main").getByTestId("flow-yaml-editor"),
  ).toBeVisible();
  const afterReopen = await flowYamlValue(page);

  expect(afterReopen).toContain("cli_1");

  await page.getByTestId("flow-tab-graph").click();
  const graph = page.getByTestId("flow-graph-editor");
  const viewport = graph.locator(".react-flow__viewport");
  const initialCamera = await viewport.getAttribute("style");

  await graph.getByRole("button", { name: "Zoom in" }).click();
  await expect(viewport).not.toHaveAttribute("style", initialCamera!);
  const manualCamera = await viewport.getAttribute("style");

  await page.getByTestId("flow-tab-yaml").click();
  await replaceYamlEditor(page, afterReopen.replaceAll("cli_1", "cli_camera"));
  await page.getByTestId("flow-tab-graph").click();
  await expect(
    graph.locator('.react-flow__node[data-id="cli_camera"]'),
  ).toBeAttached();
  await expect(viewport).toHaveAttribute("style", manualCamera!);
  await page.getByTestId("flow-tab-yaml").click();

  // Invalid edit: a PARSEABLE manifest that fails the save-time graph hard-gate
  // (a graph flow must declare compat.engine_min) → CONFIG, never persisted.
  // (An unparseable manifest is a different path — stored raw — so we use a
  // schema-valid manifest with an invalid graph instead.)
  const badYaml = [
    "schemaVersion: 1",
    "name: Broken Draft",
    "nodes:",
    "  - id: plan",
    "    type: ai_coding",
    "    action:",
    "      prompt: x",
    "",
  ].join("\n");

  await replaceYamlEditor(page, badYaml);
  await expect(
    page.getByRole("main").locator('input[name="flowYaml"]'),
  ).toHaveValue(/Broken Draft/);
  await saveDraft(page, url);

  // Draft unchanged on reopen: still the valid cli_1 draft, not the rejected one.
  await page.goto(url);
  await page.getByRole("main").getByTestId("flow-tab-yaml").click();
  await expect(
    page.getByRole("main").getByTestId("flow-yaml-editor"),
  ).toBeVisible();
  const afterInvalid = await flowYamlValue(page);

  expect(afterInvalid).toContain("cli_1");
  expect(afterInvalid).not.toContain("Broken Draft");
});
