import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { test, expect } from "@playwright/test";

// M36 Phase 1 — walk the redesigned read-only package VIEWER against a REAL
// installed package. The package ships ONE flow and no skills/agents/mcps/rules,
// so the viewer must show ONLY the Flows tab (hide-empty-tab), render the flow as
// a card (never a bare id chip), and link the card to the read-only flow detail.
// The install flow mirrors package-management.spec.ts (the one place a real
// install exists); the rich per-kind detail (skill bundle / agent metadata /
// node inspector / BOM enrichment) is unit-covered (components/studio/*,
// lib/queries/packages-bom.test.ts), matching studio.spec.ts's rationale.
const RUN_TAG = `e2eview${Date.now().toString(36)}`;

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
  const repo = mkdtempSync(join(tmpdir(), "maister-e2e-view-"));

  git(repo, "init", "-b", "main");
  const pkgDir = join(repo, "packages", RUN_TAG);

  mkdirSync(join(pkgDir, "flows/e2e-flow"), { recursive: true });
  writeFileSync(
    join(pkgDir, "maister-package.yaml"),
    `schemaVersion: 1\nname: ${RUN_TAG}\nflows:\n  - { id: ${RUN_TAG}-flow, path: flows/e2e-flow }\n`,
  );
  // Canonical graph DSL (one `cli` node `s1`) — the read-only inspector sources
  // its node list from the manifest `nodes:`, so a legacy `steps:` flow would
  // compile a canvas but render no inspector (empty `parsed.nodes`).
  writeFileSync(
    join(pkgDir, "flows/e2e-flow/flow.yaml"),
    `schemaVersion: 1\nname: ${RUN_TAG}-flow\ncompat:\n  engine_min: "1.1.0"\nnodes:\n  - id: s1\n    type: cli\n    action:\n      command: echo hi\n    transitions:\n      success: done\n`,
  );
  git(repo, "add", "-A");
  git(repo, "commit", "-m", "init");
  git(repo, "tag", `${RUN_TAG}/v1.0.0`);

  return repo;
}

test("studio package viewer: tabbed groups, hidden-empty tabs, card → read-only flow detail", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const repo = buildPackageRepo();

  // Install the package (source → discovery → install), mirroring package-management.
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

  // The package detail shows the Flows tab; the empty kinds are hidden.
  await page.goto(`/studio/packages/${RUN_TAG}`);
  await expect(
    page.getByRole("heading", { level: 1, name: RUN_TAG }),
  ).toBeVisible();
  await expect(page.getByTestId("package-tab-flows")).toBeVisible();
  await expect(page.getByTestId("package-tab-skills")).toHaveCount(0);
  await expect(page.getByTestId("package-tab-agents")).toHaveCount(0);

  // The flow renders as a card (not a bare id chip); View opens the read-only
  // flow detail (the URL carries the flow segment).
  const card = page
    .getByTestId("element-card")
    .filter({ hasText: `${RUN_TAG}-flow` });

  await expect(card).toBeVisible();
  await card.getByTestId("element-card-view").click();
  await expect(page).toHaveURL(
    new RegExp(`/studio/packages/${RUN_TAG}/flows/`),
  );
});
