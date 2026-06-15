// Phase B (T1.7) e2e for the redesigned Flow editor: the 3-pane shell (top bar
// chips + dominant canvas + properties panel), the node-type visual scheme on the
// shared node body, the YAML drawer, and the hideable rail. Runs as the seeded
// admin (storageState) against the compiling m27 flow draft. The save/persist
// round-trip through the seam is covered by m27-flow-editor.spec.ts; this spec
// stays read-only to avoid fixture contention.
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

test("flow editor Phase B: top-bar chips, node-type icons, properties, YAML drawer, rail collapse", async ({
  page,
}) => {
  const fx = loadM27();

  await page.goto(`/flows/${fx.projectSlug}/${fx.capId}`);

  // ── Shell + compact top bar ────────────────────────────────────────────────
  await expect(page.getByTestId("flow-editor-tabs")).toBeVisible();
  await expect(page.getByTestId("flow-editor-topbar")).toBeVisible();
  await expect(page.getByTestId("topbar-lifecycle")).toBeVisible();
  await expect(page.getByTestId("topbar-validation")).toBeVisible();
  await expect(page.getByTestId("topbar-readiness")).toBeVisible();
  // The seam Save action is wired into the top bar for the manager.
  await expect(page.getByTestId("topbar-save")).toBeVisible();

  // ── Dominant canvas with the new node-type icon chips (shared FlowNodeBody) ──
  await expect(page.getByTestId("flow-graph-editor")).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByTestId("node-type-icon").first()).toBeVisible({
    timeout: 15_000,
  });

  // ── Select a node → the right properties panel populates ───────────────────
  await page.locator('[data-testid="flow-node"]').first().click();
  await expect(page.getByTestId("node-side-form")).toBeVisible();

  // ── YAML drawer toggles open over the always-on canvas, then closes ────────
  await page.getByTestId("flow-tab-yaml").click();
  await expect(page.getByTestId("flow-yaml-editor")).toBeVisible();
  await page.getByTestId("flow-tab-graph").click();
  await expect(page.getByTestId("flow-yaml-editor")).toHaveCount(0);
  await expect(page.getByTestId("flow-graph-editor")).toBeVisible();

  // ── Hideable rail: collapsing removes the rail content (frees canvas width) ─
  const railToggle = page.getByTestId("rail-collapse-toggle");

  await expect(railToggle).toBeVisible();
  await expect(page.getByTestId("rail-content")).toBeVisible();
  await railToggle.click();
  await expect(page.getByTestId("rail-content")).toHaveCount(0);
  // Re-expanding restores it.
  await page.getByTestId("rail-collapse-toggle").click();
  await expect(page.getByTestId("rail-content")).toBeVisible();
});
