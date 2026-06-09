import { readFileSync } from "node:fs";
import path from "node:path";

import { test, expect } from "@playwright/test";

type M27Fixture = { projectId: string; projectSlug: string; capId: string };

function loadM27(): M27Fixture {
  const all = JSON.parse(
    readFileSync(path.resolve("e2e/.auth/fixtures.json"), "utf8"),
  ) as { byKey: { m27Editor: M27Fixture } };

  return all.byKey.m27Editor;
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
  await expect(page.getByTestId("flow-editor-tabs")).toBeVisible();
  await expect(page.getByTestId("flow-graph-editor")).toBeVisible({
    timeout: 15000,
  });

  const addCli = page.getByTestId("add-node-cli");

  await expect(addCli).toBeVisible({ timeout: 15000 });

  // Add a cli node via the toolbar; the new id (cli_1) lands in the shared
  // flowYaml → visible on the raw-YAML tab.
  await addCli.click();
  await page.getByTestId("flow-tab-yaml").click();

  const afterAdd = await page.getByTestId("flow-yaml-textarea").inputValue();

  expect(afterAdd).toContain("cli_1");

  // Save the draft through the existing updateAuthoredFlowAction form.
  await page.getByRole("button", { name: "Save draft" }).click();
  await page.waitForLoadState("networkidle");

  // Reopen → the added node persisted.
  await page.goto(url);
  await page.getByTestId("flow-tab-yaml").click();
  const afterReopen = await page.getByTestId("flow-yaml-textarea").inputValue();

  expect(afterReopen).toContain("cli_1");

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

  await page.getByTestId("flow-yaml-textarea").fill(badYaml);
  await page.getByRole("button", { name: "Save draft" }).click();
  await page.waitForLoadState("networkidle");

  // Draft unchanged on reopen: still the valid cli_1 draft, not the rejected one.
  await page.goto(url);
  await page.getByTestId("flow-tab-yaml").click();
  const afterInvalid = await page
    .getByTestId("flow-yaml-textarea")
    .inputValue();

  expect(afterInvalid).toContain("cli_1");
  expect(afterInvalid).not.toContain("Broken Draft");
});
