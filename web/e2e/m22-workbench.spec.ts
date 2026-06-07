// T6.2 (e2e): the M22 workbench surface — flow-graph view, git-tracked file
// tree + viewer, run diff, authored-layout read-back, the readRepoFiles
// member-gate, and the project repo tab — end-to-end through the real UI + the
// real file/graph APIs, against the seeded `m22` fixture
// (e2e/_seed/seed-e2e.ts → seedM22Fixture). ONE project with a REAL parent repo
// (README.md + src/app.ts + an oversized tracked blob + a committed run-branch
// diff vs base) and a flow run parked at `Running` with current_step_id =
// `implement`, real node_attempts (plan Succeeded, implement Running on the
// current node, checks Succeeded + a PASSED gate, review Pending).
//
// Asserted, deterministic, supervisor-independent outcomes:
//   1. graph    — /runs/<id> (default ?wb=graph) renders the flow-graph view;
//      the `plan` node reflects its seeded Succeeded status; the current node
//      (`implement`) carries data-current="true".
//   2. layout   — GET /graph returns the authored layout from the flow.yaml
//      presentation section (ADR-062); the removed PUT /graph/layout is 404.
//   3. files    — ?wb=files lists tracked files; expanding `src` reveals its
//      file; opening a file shows file-content; opening the oversized file shows
//      file-too-large; a .git/config path → 404 and a ../etc path → 400.
//   4. denial   — a fresh-context VIEWER (global+project role viewer) is denied
//      the file route (403); the admin/owner is NOT denied.
//   5. diff     — ?wb=diff renders the run-diff with the committed change in the
//      <pre> and a changed-file entry.
//   6. repo tab — /projects/<slug>?tab=repo renders the file-tree for an admin
//      (member+) listing tracked repo files.
import { readFileSync } from "node:fs";
import path from "node:path";

import { test, expect, type Page } from "@playwright/test";

type M22Fixture = {
  projectSlug: string;
  repoPath: string;
  runId: string;
  branch: string;
  currentNode: string;
  succeededNode: string;
  oversizedFile: string;
  viewerEmail: string;
  viewerPassword: string;
};

function loadM22Fixture(): M22Fixture {
  const all = JSON.parse(
    readFileSync(path.resolve("e2e/.auth/fixtures.json"), "utf8"),
  ) as { byKey: { m22: M22Fixture } };

  return all.byKey.m22;
}

async function loginAs(
  page: Page,
  email: string,
  password: string,
): Promise<void> {
  await page.goto("/login");
  await page.locator('input[name="email"]').fill(email);
  await page.locator('input[name="password"]').fill(password);
  await page.locator('form button[type="submit"]').click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), {
    timeout: 30_000,
  });
}

test("flow-graph view renders node statuses and the current-node emphasis", async ({
  page,
}) => {
  const fx = loadM22Fixture();

  // Default ?wb=graph: the flow-graph view mounts. React Flow renders nodes
  // inside the fitView viewport; the 4-node graph fits entirely.
  await page.goto(`/runs/${fx.runId}`);

  await expect(page.locator('[data-testid="flow-graph-view"]')).toBeVisible();

  // The `plan` node reflects its seeded Succeeded node_attempt status.
  await expect(
    page
      .locator('[data-testid="flow-node"][data-node-status="Succeeded"]')
      .first(),
  ).toBeVisible();

  // The current node (`implement` = current_step_id) carries data-current.
  await expect(
    page.locator('[data-testid="flow-node"][data-current="true"]'),
  ).toBeVisible();
});

test("GET /graph returns the authored layout from the flow manifest, and there is no runtime layout store", async ({
  page,
}) => {
  const fx = loadM22Fixture();

  await page.goto(`/runs/${fx.runId}?wb=graph`);
  await expect(page.locator('[data-testid="flow-graph-view"]')).toBeVisible();

  // ADR-062: layout is authored in the flow.yaml presentation section and read
  // back by GET /graph — no per-project runtime store, no drag-persist route.
  const graphRes = await page.request.get(`/api/runs/${fx.runId}/graph`);

  expect(graphRes.status()).toBe(200);
  const graph = (await graphRes.json()) as {
    topology: { nodes: Array<{ id: string }> };
    layout: Record<string, { x: number; y: number }>;
  };

  // The authored positions seeded in M22_MANIFEST.presentation come through.
  expect(graph.layout.plan).toEqual({ x: 0, y: 0 });
  expect(graph.layout[fx.currentNode]).toEqual({ x: 220, y: 0 });

  // The removed runtime layout route no longer exists.
  const putRes = await page.request.put(`/api/runs/${fx.runId}/graph/layout`, {
    data: { nodeId: "plan", x: 1, y: 2 },
  });

  expect(putRes.status()).toBe(404);
});

test("file-tree lists tracked files, opens a file, and flags the oversized blob", async ({
  page,
}) => {
  const fx = loadM22Fixture();

  await page.goto(`/runs/${fx.runId}?wb=files`);

  await expect(page.locator('[data-testid="file-tree"]')).toBeVisible();

  // Tracked root entries appear (README.md, src/, big.txt).
  await expect(
    page.locator('[data-testid="file-tree-entry"]', { hasText: "README.md" }),
  ).toBeVisible();

  // Expand the `src` directory → its tracked file appears.
  await page
    .locator('[data-testid="file-tree-entry"][data-entry-type="dir"]', {
      hasText: "src",
    })
    .click();
  await expect(
    page.locator('[data-testid="file-tree-entry"]', { hasText: "app.ts" }),
  ).toBeVisible();

  // Open the nested file → file-content renders its text.
  await page
    .locator('[data-testid="file-tree-entry"]', { hasText: "app.ts" })
    .click();
  await expect(page.locator('[data-testid="file-content"]')).toBeVisible();
  await expect(page.locator('[data-testid="file-content"]')).toContainText(
    "answer",
  );

  // Open the oversized tracked blob → the too-large marker (413 → too-large).
  await page
    .locator('[data-testid="file-tree-entry"]', { hasText: fx.oversizedFile })
    .click();
  await expect(page.locator('[data-testid="file-too-large"]')).toBeVisible();

  // Path confinement: a non-tracked git-internal path → 404; a traversal → 400.
  const gitConfig = await page.request.get(
    `/api/runs/${fx.runId}/files/content?path=.git/config`,
  );

  expect(gitConfig.status()).toBe(404);

  const traversal = await page.request.get(
    `/api/runs/${fx.runId}/files/content?path=${encodeURIComponent("../etc")}`,
  );

  expect(traversal.status()).toBe(400);
});

test("a viewer project-member is denied the repo file route (member-gate)", async ({
  browser,
  baseURL,
}) => {
  if (!baseURL) throw new Error("Playwright baseURL is required");
  const fx = loadM22Fixture();

  const context = await browser.newContext({
    baseURL,
    storageState: { cookies: [], origins: [] },
  });
  const page = await context.newPage();

  try {
    await loginAs(page, fx.viewerEmail, fx.viewerPassword);

    // readRepoFiles requires `member`; a viewer project member is below it → 403
    // (the admin/owner, exercised by the other tests, is NOT denied).
    const res = await page.request.get(`/api/runs/${fx.runId}/files`);

    expect(res.status()).toBe(403);
  } finally {
    await context.close();
  }
});

test("run-diff renders the committed run-branch change with a changed-file entry", async ({
  page,
}) => {
  const fx = loadM22Fixture();

  await page.goto(`/runs/${fx.runId}?wb=diff`);

  await expect(page.locator('[data-testid="run-diff"]')).toBeVisible();

  // The committed change (README.md modified on the run branch vs base).
  await expect(
    page.locator("pre", { hasText: "workbench diff change" }),
  ).toBeVisible();

  await expect(
    page.locator('[data-testid="changed-file"]', { hasText: "README.md" }),
  ).toBeVisible();
});

test("project repo tab renders the file-tree of tracked repo files", async ({
  page,
}) => {
  const fx = loadM22Fixture();

  await page.goto(`/projects/${fx.projectSlug}?tab=repo`);

  await expect(page.locator('[data-testid="file-tree"]')).toBeVisible();
  await expect(
    page.locator('[data-testid="file-tree-entry"]', { hasText: "README.md" }),
  ).toBeVisible();
});
