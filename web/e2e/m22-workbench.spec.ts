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
//   1. graph    — /runs/<id> renders the Flow result as the primary surface;
//      the `plan` node reflects its seeded Succeeded status; the current node
//      (`implement`) carries data-current="true"; node role labels, declared
//      gate summaries, runtime gate summaries, and rework edge labels are
//      visible for the seeded graph.
//   1b. shell   — the right inspector toggles, and the workbench exposes
//      Files|Diff|Evidence|Timeline tabs below the primary Flow result.
//   2. layout   — GET /graph returns the authored layout from the flow.yaml
//      presentation section (ADR-064); the removed PUT /graph/layout is 404.
//   3. files    — ?wb=files lists tracked files; expanding `src` reveals its
//      file; opening a file NAVIGATES to ?file=<path> and renders the
//      server-highlighted Shiki code-view (line numbers + `--shiki` token spans,
//      ADR-066); opening the oversized file shows file-too-large.
//   3b. deep-link — a cold `?file=<path>` GET renders code-view directly; a
//      `?file=../etc` traversal and a `?file=.git/config` non-tracked path both
//      surface the not-found state (existence-hiding) — NOT code-view.
//   3c. tree-state — after opening a file (a `?file=` soft-nav) an expanded dir
//      STAYS expanded and a second file in it opens without re-expanding
//      (FINDING B: the file tree keeps stable identity in the persistent layout).
//   3d. theme   — toggling the theme flips html.dark↔html.light AND recolors a
//      `--shiki` span WITHOUT refetching the run/file route (CSS-var dual-theme).
//   4. denial   — a fresh-context VIEWER (global+project role viewer) is denied
//      the file route (403); the admin/owner is NOT denied.
//   5. diff     — ?wb=diff renders the ADR-066 git-diff-view (data-testid
//      diff-view) with the committed change, line-number gutters, per-file
//      `+`/`−` badges, `?diffview=split|unified` toggle (data-diff-mode), and a
//      data-theme recolor on theme toggle (NOT a raw <pre>).
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

  // Default run view: the Flow result is primary. React Flow renders nodes
  // inside the fitView viewport; the 4-node graph fits entirely.
  await page.goto(`/runs/${fx.runId}`);

  await expect(
    page.locator('[data-testid="run-primary-result"]'),
  ).toBeVisible();
  await expect(
    page.locator('[data-testid="flow-run-selected-node"]'),
  ).toContainText("Implement");
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

  await expect(page.locator('[data-node-role="agent"]').first()).toContainText(
    "Agent",
  );
  await expect(page.locator('[data-node-role="check"]').first()).toContainText(
    "Check",
  );
  await expect(
    page.locator('[data-testid="declared-gate-summary"]', {
      hasText: "1 declared gates",
    }),
  ).toBeVisible();
  await expect(
    page.locator('[data-testid="runtime-gate-summary"]', {
      hasText: "1 gates",
    }),
  ).toBeVisible();
  await expect(
    page.locator('[data-testid="blocking-gate-summary"]', {
      hasText: "1 blocking",
    }),
  ).toBeVisible();
  await expect(
    page.locator('[data-testid="flow-edge-label"][data-edge-role="rework"]', {
      hasText: "Rework",
    }),
  ).toBeVisible();
});

test("run shell inspector toggles and workbench exposes evidence and timeline tabs", async ({
  page,
}) => {
  const fx = loadM22Fixture();

  await page.goto(`/runs/${fx.runId}`);

  await expect(page.locator('[data-testid="run-shell"]')).toBeVisible();
  await expect(
    page.locator('[data-testid="run-shell-inspector"]'),
  ).toBeVisible();
  await expect(page.locator('[data-testid="run-inspector"]')).toBeVisible();

  await page.getByRole("button", { name: "Close inspector" }).click();
  await expect(page.locator('[data-testid="run-shell-inspector"]')).toHaveCount(
    0,
  );

  await page.getByRole("button", { name: "Open inspector" }).click();
  await expect(
    page.locator('[data-testid="run-shell-inspector"]'),
  ).toBeVisible();

  await expect(page.getByRole("tab", { name: "Files" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Diff" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Evidence" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Timeline" })).toBeVisible();

  await page.getByRole("tab", { name: "Evidence" }).click();
  await page.waitForURL(/[?&]wb=evidence/);
  await expect(page.locator('[data-testid="evidence-graph"]')).toBeVisible();

  await page.getByRole("tab", { name: "Timeline" }).click();
  await page.waitForURL(/[?&]wb=timeline/);
  await expect(page.getByRole("heading", { name: "Timeline" })).toBeVisible();
});

test("GET /graph returns the authored layout from the flow manifest, and there is no runtime layout store", async ({
  page,
}) => {
  const fx = loadM22Fixture();

  await page.goto(`/runs/${fx.runId}?wb=graph`);
  await expect(page.locator('[data-testid="flow-graph-view"]')).toBeVisible();

  // ADR-064: layout is authored in the flow.yaml presentation section and read
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

test("file-tree opens a file into the Shiki code-view and flags the oversized blob", async ({
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

  // Open the nested file → it NAVIGATES to ?file=src/app.ts and the
  // server-rendered Shiki code-view replaces the old <pre>.
  await page
    .locator('[data-testid="file-tree-entry"]', { hasText: "app.ts" })
    .click();
  await page.waitForURL(/[?&]file=src%2Fapp\.ts/);

  const codeView = page.locator('[data-testid="code-view"]');

  await expect(codeView).toBeVisible();
  await expect(codeView).toContainText("answer");

  // Per-line structure: the highlighted view renders ≥ the file's line count.
  const lineCount = await codeView.locator(".line").count();

  expect(lineCount).toBeGreaterThanOrEqual(2);

  // Server highlight actually ran: ≥1 token span carries a Shiki CSS variable.
  await expect(codeView.locator('[style*="--shiki"]').first()).toBeVisible();

  // Open the oversized tracked blob → the too-large marker (413 → too-large).
  await page
    .locator('[data-testid="file-tree-entry"]', { hasText: fx.oversizedFile })
    .click();
  await expect(page.locator('[data-testid="file-too-large"]')).toBeVisible();
});

test("?file= cold deep-link renders the code-view; traversal + .git are hidden", async ({
  page,
}) => {
  const fx = loadM22Fixture();

  // Cold deep-link straight to a tracked file → the server pane renders the
  // code-view directly (no client fetch round-trip).
  await page.goto(`/runs/${fx.runId}?wb=files&file=README.md`);
  await expect(page.locator('[data-testid="code-view"]')).toBeVisible();

  // A `..` traversal is rejected by repoRelPathSchema BEFORE any read → the
  // not-found state, never the code-view and never the rejected path.
  await page.goto(
    `/runs/${fx.runId}?wb=files&file=${encodeURIComponent("../etc")}`,
  );
  await expect(page.locator('[data-testid="file-not-found"]')).toBeVisible();
  await expect(page.locator('[data-testid="code-view"]')).toHaveCount(0);

  // A non-tracked git-internal path surfaces as not-found (existence-hiding) —
  // the same uniform state, so `.git` is indistinguishable from a missing file.
  await page.goto(`/runs/${fx.runId}?wb=files&file=.git%2Fconfig`);
  await expect(page.locator('[data-testid="file-not-found"]')).toBeVisible();
  await expect(page.locator('[data-testid="code-view"]')).toHaveCount(0);
});

test("an expanded dir survives a ?file= soft-nav (FINDING B tree state)", async ({
  page,
}) => {
  const fx = loadM22Fixture();

  await page.goto(`/runs/${fx.runId}?wb=files`);
  await expect(page.locator('[data-testid="file-tree"]')).toBeVisible();

  // Expand `src`, then open the file inside it (a ?file= soft-nav).
  await page
    .locator('[data-testid="file-tree-entry"][data-entry-type="dir"]', {
      hasText: "src",
    })
    .click();
  await page
    .locator('[data-testid="file-tree-entry"]', { hasText: "app.ts" })
    .click();
  await page.waitForURL(/[?&]file=src%2Fapp\.ts/);
  await expect(page.locator('[data-testid="code-view"]')).toBeVisible();

  // The tree kept stable identity across the soft-nav: `src` is STILL expanded
  // (app.ts visible) without re-expanding, and a second file in the SAME dir
  // opens directly.
  await expect(
    page.locator('[data-testid="file-tree-entry"]', { hasText: "app.ts" }),
  ).toBeVisible();

  // Open README.md from the (still-rendered) tree → the pane re-reads it.
  await page
    .locator('[data-testid="file-tree-entry"][data-entry-type="file"]', {
      hasText: "README.md",
    })
    .click();
  await page.waitForURL(/[?&]file=README\.md/);
  await expect(page.locator('[data-testid="code-view"]')).toBeVisible();
  // `src` is STILL expanded after the second soft-nav (app.ts still listed).
  await expect(
    page.locator('[data-testid="file-tree-entry"]', { hasText: "app.ts" }),
  ).toBeVisible();
});

test("theme toggle recolors the code-view without refetching the run/file route", async ({
  page,
}) => {
  const fx = loadM22Fixture();

  await page.goto(`/runs/${fx.runId}?wb=files&file=src%2Fapp.ts`);
  const span = page
    .locator('[data-testid="code-view"] [style*="--shiki"]')
    .first();

  await expect(span).toBeVisible();

  // A pure CSS-var recolor must NOT refetch the run page's RSC document (the
  // file blob lives in that payload). Next.js <Link> prefetches of sibling
  // workbench tabs and the file-tree's own `/api/.../files` listing are benign
  // perf hints, not a re-read of the open file — exclude them.
  const runRequests: { url: string; prefetch: boolean }[] = [];

  page.on("request", (req) => {
    if (!req.url().includes(`/runs/${fx.runId}`)) return;

    const h = req.headers();
    const prefetch =
      h["next-router-prefetch"] === "1" ||
      h["purpose"] === "prefetch" ||
      (h["sec-purpose"] ?? "").includes("prefetch");

    runRequests.push({ url: req.url(), prefetch });
  });

  const htmlClassBefore = await page.evaluate(
    () => document.documentElement.className,
  );
  const colorBefore = await span.evaluate((el) => getComputedStyle(el).color);

  await page.locator('button[aria-label$="mode"]').click();

  // The class on <html> flipped between the light/dark forest themes.
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const c = document.documentElement.classList;

        return c.contains("light") || c.contains("dark");
      }),
    )
    .toBe(true);

  const htmlClassAfter = await page.evaluate(
    () => document.documentElement.className,
  );
  const colorAfter = await span.evaluate((el) => getComputedStyle(el).color);

  expect(htmlClassAfter).not.toBe(htmlClassBefore);
  // The Shiki token recolored across the toggle via the CSS-var dual theme.
  expect(colorAfter).not.toBe(colorBefore);

  // No real refetch of the run page document (the open file's RSC payload).
  // Next.js dev-mode prefetch/RSC pings are non-deterministic noise — exclude
  // prefetches and the file-tree's own `/api/.../files` listing.
  const documentRefetches = runRequests.filter(
    (r) => !r.prefetch && !r.url.includes("/api/"),
  );

  expect(documentRefetches).toEqual([]);
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

test("run-diff renders the ADR-066 diff-view with line numbers + per-file +/− badges", async ({
  page,
}) => {
  const fx = loadM22Fixture();

  await page.goto(`/runs/${fx.runId}?wb=diff`);

  await expect(page.locator('[data-testid="run-diff"]')).toBeVisible();

  // The raw <pre> is replaced by the git-diff-view container (ADR-066). Default
  // mode is split.
  const diffView = page.locator('[data-testid="diff-view"]');

  await expect(diffView).toBeVisible();
  await expect(diffView).toHaveAttribute("data-diff-mode", "split");

  // The committed change (README.md modified on the run branch vs base) renders
  // inside the diff body.
  await expect(diffView).toContainText("workbench diff change");

  // The changed-files list shows the file with its server-computed +/− counts.
  const changedFile = page.locator('[data-testid="changed-file"]', {
    hasText: "README.md",
  });

  await expect(changedFile).toBeVisible();
  await expect(
    changedFile.locator('[data-testid="changed-file-additions"]'),
  ).toContainText("+");
  await expect(
    changedFile.locator('[data-testid="changed-file-deletions"]'),
  ).toContainText("−");

  // Split mode renders git-diff-view line-number gutters (old + new columns).
  await expect(diffView.locator(".diff-line-old-num").first()).toBeVisible();
  await expect(diffView.locator(".diff-line-new-num").first()).toBeVisible();
});

test("diff-view toggles split↔unified via ?diffview= and recolors with the theme", async ({
  page,
}) => {
  const fx = loadM22Fixture();

  // Unified deep-link → the container reports unified and renders the single
  // unified line-number gutter.
  await page.goto(`/runs/${fx.runId}?wb=diff&diffview=unified`);

  const diffView = page.locator('[data-testid="diff-view"]');

  await expect(diffView).toBeVisible();
  await expect(diffView).toHaveAttribute("data-diff-mode", "unified");
  await expect(diffView.locator(".diff-line-num").first()).toBeVisible();

  // Switch to split via the query param → split line-number columns appear.
  await page.goto(`/runs/${fx.runId}?wb=diff&diffview=split`);
  await expect(diffView).toHaveAttribute("data-diff-mode", "split");
  await expect(diffView.locator(".diff-line-new-num").first()).toBeVisible();

  // Server highlighting actually reached the screen (B1 guard): the diff body
  // carries ≥1 Shiki token span with a `--shiki` CSS var. This only passes when
  // the FULL bundle's syntax survived hydration AND `diffViewHighlight={true}`
  // rendered <DiffSyntax> (not the plain <DiffString>) — i.e. the original
  // "plain monochrome diff" bug is gone.
  const token = diffView.locator('span[style*="--shiki"]').first();

  await expect(token).toBeVisible();
  expect(
    await diffView.locator('span[style*="--shiki"]').count(),
  ).toBeGreaterThan(0);

  // The git-diff-view wrapper carries data-theme on `.diff-tailwindcss-wrapper`
  // (verified against the rendered DOM — NOT `.diff-view-wrapper`, which has no
  // such attribute); toggling the app theme flips it (the diff chrome re-applies
  // on the `key={resolvedTheme}` remount), with no run-page document refetch (the
  // diff payload is already client-side).
  const wrapper = diffView.locator(".diff-tailwindcss-wrapper").first();

  await expect(wrapper).toBeVisible();
  const themeBefore = await wrapper.getAttribute("data-theme");
  const colorBefore = await token.evaluate((el) => getComputedStyle(el).color);

  await page.locator('button[aria-label$="mode"]').click();

  // (S1 guard) the wrapper's data-theme flips on toggle ...
  await expect
    .poll(async () => wrapper.getAttribute("data-theme"))
    .not.toBe(themeBefore);

  // ... AND the Shiki token recolors via the `--shiki-light`/`--shiki-dark`
  // CSS-var dual theme (the bundle is built once; the toggle is pure CSS).
  await expect
    .poll(async () =>
      diffView
        .locator('span[style*="--shiki"]')
        .first()
        .evaluate((el) => getComputedStyle(el).color),
    )
    .not.toBe(colorBefore);
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
