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
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { test, expect, type Page } from "@playwright/test";

import { withE2EDb } from "./_seed/db";

type M22Fixture = {
  projectSlug: string;
  repoPath: string;
  runId: string;
  branch: string;
  currentNode: string;
  succeededNode: string;
  oversizedFile: string;
  reader: { email: string; password: string };
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
  const workbench = page.locator('[data-testid="run-shell"]:visible');

  // Default run view: the Flow result is primary. React Flow renders nodes
  // inside the fitView viewport; the 4-node graph fits entirely.
  await page.goto(`/runs/${fx.runId}`);

  await expect(
    workbench.locator('[data-testid="run-primary-result"]'),
  ).toBeVisible();
  await expect(
    workbench.locator('[data-testid="flow-run-selected-node"]'),
  ).toContainText("Implement");
  await expect(
    workbench.locator('[data-testid="flow-graph-view"]'),
  ).toBeVisible();

  // The `plan` node reflects its seeded Succeeded node_attempt status.
  await expect(
    workbench
      .locator('[data-testid="flow-node"][data-node-status="Succeeded"]')
      .first(),
  ).toBeVisible();

  // The current node (`implement` = current_step_id) carries data-current.
  await expect(
    workbench.locator('[data-testid="flow-node"][data-current="true"]'),
  ).toBeVisible();

  await expect(
    workbench.locator('[data-node-role="agent"]').first(),
  ).toContainText("Agent");
  await expect(
    workbench.locator('[data-node-role="check"]').first(),
  ).toContainText("Check");
  await expect(
    workbench.locator('[data-testid="declared-gate-summary"]', {
      hasText: "1 declared gates",
    }),
  ).toBeVisible();
  await expect(
    workbench.locator('[data-testid="runtime-gate-summary"]', {
      hasText: "1 gates",
    }),
  ).toBeVisible();
  await expect(
    workbench.locator('[data-testid="blocking-gate-summary"]', {
      hasText: "1 blocking",
    }),
  ).toBeVisible();
  await expect(
    workbench.locator(
      '[data-testid="flow-edge-label"][data-edge-role="rework"]',
      {
        hasText: "Rework",
      },
    ),
  ).toBeVisible();
});

test("current-step help and interrupt belong to the selected step", async ({
  page,
}) => {
  const fx = loadM22Fixture();

  await page.goto(`/runs/${fx.runId}?node=${fx.succeededNode}`);
  const shell = page.locator('[data-testid="run-shell"]:visible');
  const selected = shell.getByTestId("flow-run-selected-node");
  const action = selected.getByRole("button", { name: "Stop current step" });

  await expect(action).toHaveCount(0);
  await shell
    .getByTestId("flow-run-node-link")
    .filter({ hasText: "Implement" })
    .click();
  await expect(action).toBeVisible();
  const help = selected.getByRole("button", {
    name: "About stopping the current step",
  });
  let posts = 0;

  await page.route(`**/api/runs/${fx.runId}/node-interrupt`, async (route) => {
    posts++;
    expect(route.request().postDataJSON()).toEqual({});
    await route.fulfill({
      status: 409,
      json: { code: "CONFLICT", message: "changed" },
    });
  });
  await help.focus();
  await help.press("Enter");
  await expect(page.getByRole("dialog")).toContainText(/only the current/i);
  await page.keyboard.press("Escape");
  await expect(help).toBeFocused();
  expect(posts).toBe(0);
  await action.click();
  await expect(selected.getByRole("alert")).toBeVisible();
  expect(posts).toBe(1);
});

test("run shell inspector toggles and workbench exposes evidence and timeline tabs", async ({
  page,
}) => {
  const fx = loadM22Fixture();

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`/runs/${fx.runId}?inspector=open`);

  await expect(page.locator('[data-testid="run-shell"]:visible')).toBeVisible();
  await expect(
    page.locator(
      '[data-testid="run-shell"]:visible [data-testid="run-shell-inspector"]',
    ),
  ).toBeVisible();
  await expect(
    page.locator(
      '[data-testid="run-shell"]:visible [data-testid="run-inspector"]',
    ),
  ).toBeVisible();

  await page.getByRole("button", { name: "Close inspector" }).click();
  await expect(
    page.locator(
      '[data-testid="run-shell"]:visible [data-testid="run-shell-inspector"]',
    ),
  ).toHaveCount(0);

  await page.getByRole("button", { name: "Open inspector" }).click();
  await expect(
    page.locator(
      '[data-testid="run-shell"]:visible [data-testid="run-shell-inspector"]',
    ),
  ).toBeVisible();

  // Timeline/Evidence are the always-visible workbench tabs.
  await expect(
    page.getByRole("tab", { name: "Results and checks" }),
  ).toBeVisible();
  await expect(page.getByRole("tab", { name: "Timeline" })).toBeVisible();

  // Files/Diff moved inside the collapsed "Files / Diff" <details>, which only
  // starts open when `?wb=` already names one of them. Closed <details> content
  // is out of the a11y tree entirely, so those tabs are not merely invisible —
  // they do not resolve at all until the disclosure is opened.
  const disclosure = page.getByTestId("workbench-disclosure");

  await expect(disclosure).toBeVisible();
  await disclosure.locator("> summary").click();

  await expect(page.getByRole("tab", { name: "Files" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Diff" })).toBeVisible();

  await page.getByRole("tab", { name: "Results and checks" }).click();
  await page.waitForURL(/[?&]wb=evidence/);
  await expect(
    page.getByRole("heading", { name: "Current results" }),
  ).toBeVisible();

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

  await expect(page.locator('[data-testid="file-tree"]:visible')).toBeVisible();

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

  // T4.2: a non-empty text file gets a copy-to-clipboard control in the header.
  await expect(page.locator('[data-testid="file-copy-button"]')).toBeVisible();

  // Open the oversized tracked blob → the too-large marker (413 → too-large).
  await page
    .locator('[data-testid="file-tree-entry"]', { hasText: fx.oversizedFile })
    .click();
  await expect(page.locator('[data-testid="file-too-large"]')).toBeVisible();
});

test("?file= cold deep-link renders the file pane; traversal + .git are hidden", async ({
  page,
}) => {
  const fx = loadM22Fixture();
  const workbench = page.locator('[data-testid="run-shell"]:visible');

  // Cold deep-link straight to a tracked Markdown file → the server pane renders
  // the rich Markdown view directly (no client fetch round-trip). A `.md` file
  // routes to MarkdownRichView, not the Shiki code-view.
  await page.goto(`/runs/${fx.runId}?wb=files&file=README.md`);
  await expect(
    workbench.locator('[data-testid="markdown-rich-view"]'),
  ).toBeVisible();
  // The README's ```mermaid fence renders the client Mermaid diagram (T6.2).
  await expect(
    workbench.locator('[data-testid="mermaid-diagram"]'),
  ).toBeVisible();

  // A `..` traversal is rejected by repoRelPathSchema BEFORE any read → the
  // not-found state, never the code-view and never the rejected path.
  await page.goto(
    `/runs/${fx.runId}?wb=files&file=${encodeURIComponent("../etc")}`,
  );
  await expect(
    workbench.locator('[data-testid="file-not-found"]'),
  ).toBeVisible();
  await expect(workbench.locator('[data-testid="code-view"]')).toHaveCount(0);

  // A non-tracked git-internal path surfaces as not-found (existence-hiding) —
  // the same uniform state, so `.git` is indistinguishable from a missing file.
  await page.goto(`/runs/${fx.runId}?wb=files&file=.git%2Fconfig`);
  await expect(
    workbench.locator('[data-testid="file-not-found"]'),
  ).toBeVisible();
  await expect(workbench.locator('[data-testid="code-view"]')).toHaveCount(0);
});

test("an expanded dir survives a ?file= soft-nav (FINDING B tree state)", async ({
  page,
}) => {
  const fx = loadM22Fixture();

  await page.goto(`/runs/${fx.runId}?wb=files`);
  await expect(page.locator('[data-testid="file-tree"]:visible')).toBeVisible();

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

  // Open README.md from the (still-rendered) tree → the pane re-reads it as the
  // rich Markdown view (a .md file routes to MarkdownRichView).
  await page
    .locator('[data-testid="file-tree-entry"][data-entry-type="file"]', {
      hasText: "README.md",
    })
    .click();
  await page.waitForURL(/[?&]file=README\.md/);
  await expect(
    page.locator('[data-testid="markdown-rich-view"]'),
  ).toBeVisible();
  // `src` is STILL expanded after the second soft-nav (app.ts still listed).
  await expect(
    page.locator('[data-testid="file-tree-entry"]', { hasText: "app.ts" }),
  ).toBeVisible();
});

test("theme toggle recolors the code-view without refetching the run/file route", async ({
  page,
}) => {
  const fx = loadM22Fixture();

  await page.context().clearCookies();
  await loginAs(page, fx.reader.email, fx.reader.password);
  const path = `/runs/${fx.runId}`;
  // The workbench refreshes its server layout when its stream first connects.
  const connectedRefresh = page.waitForResponse((response) => {
    const url = new URL(response.url());
    const headers = response.request().headers();

    return (
      url.pathname === path &&
      url.searchParams.get("file") === "src/app.ts" &&
      !url.searchParams.has("node") &&
      !url.searchParams.has("flow") &&
      headers.rsc === "1" &&
      headers["next-router-prefetch"] !== "1"
    );
  });

  await page.goto(`${path}?wb=files&file=src%2Fapp.ts`);
  await connectedRefresh;
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

    await page.goto(`/runs/${fx.runId}`);
    const shell = page.locator('[data-testid="run-shell"]:visible');
    const selected = shell.getByTestId("flow-run-selected-node");

    await expect(
      selected.getByRole("button", { name: "Stop current step" }),
    ).toBeDisabled();
    await expect(
      selected.getByRole("button", { name: "About stopping the current step" }),
    ).toBeEnabled();

    await expect(
      shell.getByRole("button", { name: "Stop run", exact: true }),
    ).toHaveCount(0);

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
  const header = page.getByTestId("run-header").filter({ visible: true });
  const changes = header.getByRole("link", { name: /^Changes:/ });
  const disclosure = page.getByTestId("workbench-disclosure");
  const diff = disclosure.getByTestId("run-diff");

  await page.goto(`/runs/${fx.runId}?inspector=closed`);

  await expect(
    header.getByRole("link", { name: "Back to board" }),
  ).toHaveAttribute("href", `/projects/${fx.projectSlug}`);
  await expect(header.getByTestId("run-stream-liveness")).toBeVisible();
  await expect(diff).toBeHidden();
  await changes.click();
  await expect(page).toHaveURL(
    (url) =>
      url.searchParams.get("wb") === "diff" &&
      url.searchParams.get("scope") === "run" &&
      url.searchParams.get("inspector") === "closed",
  );
  await expect(disclosure.locator("> summary")).toBeInViewport();
  await expect(diff).toBeVisible();

  await disclosure.locator("> summary").click();
  await expect(diff).toBeHidden();
  await expect(page).not.toHaveURL(/[?&]wb=diff/);
  await changes.click();
  await expect(diff).toBeVisible();

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

  await expect(page.locator('[data-testid="file-tree"]:visible')).toBeVisible();
  await expect(
    page.locator('[data-testid="file-tree-entry"]', { hasText: "README.md" }),
  ).toBeVisible();
});

test("a live cursor change moves interrupt eligibility while the selected node stays open", async ({
  page,
}) => {
  const fx = loadM22Fixture();
  const runId = randomUUID();
  await withE2EDb((pool) =>
    pool.query(
      "INSERT INTO runs(id,project_id,flow_id,run_kind,status,flow_version,current_step_id) SELECT $1,project_id,flow_id,'flow','Running',flow_version,$3 FROM runs WHERE id=$2",
      [runId, fx.runId, fx.currentNode],
    ),
  );
  try {
    await page.goto(`/runs/${runId}?node=${fx.currentNode}`);
    const shell = page.getByTestId("run-shell").filter({ visible: true });
    const action = shell
      .getByTestId("flow-run-selected-node")
      .getByRole("button", { name: "Stop current step" });
    await expect(action).toBeVisible();
    await withE2EDb((pool) =>
      pool.query("UPDATE runs SET current_step_id=$2 WHERE id=$1", [
        runId,
        fx.succeededNode,
      ]),
    );
    await expect(action).toHaveCount(0);
    await shell
      .getByTestId("flow-run-node-link")
      .filter({ hasText: "Plan" })
      .click();
    await expect(action).toBeVisible();
  } finally {
    await withE2EDb((pool) =>
      pool.query("DELETE FROM runs WHERE id=$1", [runId]),
    );
  }
});

test("Git sync progress stays reachable when Stop run is the only lifecycle action @flow-controls", async ({
  page,
}) => {
  const fx = loadM22Fixture();
  await page.goto(`/runs/${fx.runId}?inspector=closed`);
  const shell = page.getByTestId("run-shell").filter({ visible: true });
  const stop = { name: "Stop run", exact: true };

  await expect(shell.getByRole("button", stop)).toHaveCount(1);
  await expect(
    shell.getByTestId("run-header").getByRole("button", stop),
  ).toBeVisible();
  await shell.getByTestId("workbench-git-open").click();
  await expect(
    shell.getByTestId("git-panel").getByRole("status").filter({
      hasText: "Branch sync #1 · Checking the result",
    }),
  ).toContainText("main");
});

test.describe("touch and compact layout", () => {
  test.use({ hasTouch: true });
  for (const [locale, policy, stop, step] of [
    ["en", "Unattended", "Stop run", "Stop current step"],
    ["ru", "Без контроля", "Остановить запуск", "Остановить текущий шаг"],
  ] as const) {
    test(`Flow run metadata and controls in ${locale}`, async ({
      page,
      baseURL,
    }) => {
      const fx = loadM22Fixture();

      await page
        .context()
        .addCookies([{ name: "NEXT_LOCALE", value: locale, url: baseURL! }]);
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.goto(`/runs/${fx.runId}?inspector=closed`);
      const shell = page.getByTestId("run-shell").filter({ visible: true });
      const header = shell.locator("header").first();
      const action = header.getByRole("button", { name: stop, exact: true });
      const branch = header.getByTestId("run-header-branch");

      await expect(header.getByTestId("execution-policy-badge")).toHaveText(
        policy,
      );
      await expect(action).toBeVisible();
      await expect
        .poll(() =>
          header.evaluate((el) => {
            const badge = el
              .querySelector('[data-testid="execution-policy-badge"]')!
              .getBoundingClientRect();
            const button = el
              .querySelector(
                '[data-testid="workbench-lifecycle-actions"] button',
              )!
              .getBoundingClientRect();
            return Math.abs(
              badge.y + badge.height / 2 - button.y - button.height / 2,
            );
          }),
        )
        .toBeLessThan(3);
      expect(
        await branch.evaluate((el) => el.scrollWidth > el.clientWidth),
      ).toBe(true);
      await branch.press("Enter");
      await expect(branch.locator("..").locator("div")).toHaveText(
        new RegExp(fx.branch),
      );
      await branch.press("Enter");
      let posts = 0;

      await page.route(`**/api/runs/${fx.runId}/stop`, async (route) => {
        posts++;
        expect(route.request().postDataJSON()).toEqual({});
        await route.fulfill({ status: 409, json: { code: "CONFLICT" } });
      });
      await action.click();
      await page.keyboard.press("Escape");
      await expect(action).toBeFocused();
      expect(posts).toBe(0);
      await action.click();
      await page
        .getByRole("dialog")
        .getByRole("button", {
          name: locale === "en" ? "Confirm" : "Подтвердить",
          exact: true,
        })
        .click();
      await expect(page.getByRole("dialog").getByRole("alert")).toBeVisible();
      expect(posts).toBe(1);
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await page.setViewportSize({ width: 320, height: 768 });
      const help = shell.getByRole("button", {
        name:
          locale === "en"
            ? "About stopping the current step"
            : "Об остановке текущего шага",
      });
      await help.tap();
      await expect(page.getByRole("dialog")).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(help).toBeFocused();
      await expect(action).toBeVisible();
      await expect(
        shell.getByRole("button", { name: step, exact: true }),
      ).toBeVisible();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBeLessThanOrEqual(320);
    });
  }
});

test("expands the live canvas and preserves history and focus @flow-controls", async ({
  page,
  browserName: engine,
}, testInfo) => {
  const fx = loadM22Fixture();

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`/runs/${fx.runId}?node=${fx.currentNode}&inspector=closed`);
  const shell = page.getByTestId("run-shell").filter({ visible: true });
  const enter = shell.getByTestId("flow-run-fullscreen");
  const graph = shell.getByTestId("flow-run-graph-view");
  const canvas = graph.locator(".react-flow");

  await expect(canvas).toBeVisible();
  const inline = await canvas.boundingBox();
  const originalCanvas = await canvas.elementHandle();
  await enter.scrollIntoViewIfNeeded();
  const initialScroll = await page.evaluate(() => window.scrollY);

  await enter.click();
  await expect(page).toHaveURL(/flow=fullscreen/);
  await expect
    .poll(async () => (await canvas.boundingBox())?.height ?? 0)
    .toBeGreaterThan(inline!.height + 200);
  const verifyBounds = async () => {
    const box = await graph.boundingBox();

    expect(Math.abs(box!.x) + Math.abs(box!.y)).toBeLessThanOrEqual(2);
    expect(Math.abs(box!.width - 1440)).toBeLessThanOrEqual(2);
    expect(Math.abs(box!.height - 1000)).toBeLessThanOrEqual(2);
  };

  await verifyBounds();
  expect(
    await canvas.evaluate((el, original) => el === original, originalCanvas),
  ).toBe(true);
  const closeControl = graph.getByRole("button", { name: "Close fullscreen" });
  await expect(closeControl).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect
    .poll(() => graph.evaluate((el) => el.contains(document.activeElement)))
    .toBe(true);
  const area = await canvas.boundingBox();
  const controls = await closeControl.boundingBox();
  expect(area!.height).toBeGreaterThan(1000 - controls!.height - 30);
  await testInfo.attach("graph-bounds", {
    body: JSON.stringify({
      engine,
      inline,
      expanded: await canvas.boundingBox(),
      surface: await graph.boundingBox(),
    }),
    contentType: "application/json",
  });
  await page.goBack();
  await expect(enter).toBeFocused();
  await expect
    .poll(async () => (await canvas.boundingBox())?.height)
    .toBe(inline!.height);
  await expect
    .poll(() => page.evaluate(() => window.scrollY))
    .toBe(initialScroll);
  await page.goForward();
  await expect(closeControl).toBeFocused();
  await verifyBounds();
  await page.reload();
  const close = graph.getByRole("button", { name: "Close fullscreen" });

  await expect(close).toBeFocused();
  await close.click();
  await expect(page).toHaveURL(
    new RegExp(`node=${fx.currentNode}&inspector=closed$`),
  );
  await expect(enter).toBeFocused();
  await enter.click();
  await expect(close).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(enter).toBeFocused();
});
