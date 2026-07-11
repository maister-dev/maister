import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { test, expect, type Page } from "@playwright/test";

import { loadFixtures } from "./_seed/fixtures";
import { withE2EDb } from "./_seed/db";

// ADR-129 — the forked-package loop through the UI. The heavy git/DB
// semantics are integration-proven (runs-launch-pin / package-pin /
// fork-cut / sync / publish integration suites); this spec walks the UI
// journey those tests cannot: source → install → fork → edit → commit →
// cut (dialog) → attach-beside-upstream rename explainer → experiment lab
// provenance → upstream re-tag → install & sync with conflicts → resolve →
// publish with a configured base → "upstream moved — sync first" refusal.
//
// Infra (shared-infra trap): ports 3100/7788 + the maister_e2e DB are shared
// across ALL worktrees — kill stale listeners before a run and
// baseline-prove a red run before blaming this branch.
//
// Assertion style: stable labels/testids only, never implementation text.

const RUN_TAG = `e2efpl${Date.now().toString(36)}`;
const FLOW_ID = `${RUN_TAG}-flow`;

let repo: string;
let upstreamInstallId: string;
let cut1InstallId: string;
let fork1Id: string;

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

function gitOut(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function buildPackageRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "maister-e2e-fpl-"));

  git(dir, "init", "-b", "main");
  const pkgDir = join(dir, "packages", RUN_TAG);

  mkdirSync(join(pkgDir, "flows/e2e-flow"), { recursive: true });
  mkdirSync(join(pkgDir, "docs"), { recursive: true });
  writeFileSync(
    join(pkgDir, "maister-package.yaml"),
    `schemaVersion: 1\nname: ${RUN_TAG}\nflows:\n  - { id: ${FLOW_ID}, path: flows/e2e-flow }\n`,
  );
  writeFileSync(
    join(pkgDir, "flows/e2e-flow/flow.yaml"),
    `schemaVersion: 1\nname: ${FLOW_ID}\nsteps:\n  - id: s1\n    type: cli\n    command: echo hi\n`,
  );
  writeFileSync(join(pkgDir, "docs/README.md"), "upstream readme v1\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-m", "init");
  git(dir, "tag", `${RUN_TAG}/v1.0.0`);

  return dir;
}

async function addGitSource(
  page: Page,
  url: string,
  baseBranch?: string,
): Promise<void> {
  await page.goto("/studio/sources");
  await page.getByRole("button", { name: "Add package source" }).click();
  const dialog = page.getByRole("dialog");

  await dialog.getByLabel("Git monorepo URL").fill(url);
  if (baseBranch !== undefined) {
    await dialog.getByLabel("Publish base branch").fill(baseBranch);
  }
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText(url)).toBeVisible();
}

async function refreshSource(page: Page, url: string): Promise<void> {
  await page.goto("/studio/sources");
  await page
    .locator("tr", { hasText: url })
    .getByRole("button", { name: "Refresh", exact: true })
    .click();
}

async function installTag(page: Page, tag: string): Promise<void> {
  await page.getByRole("button", { name: `${tag} · install` }).click();
  await expect(
    page.getByRole("button", { name: `${tag} · installed` }),
  ).toBeVisible({ timeout: 30_000 });
}

// The admin installs list — resolve install ids without leaning on markup.
async function findInstall(
  page: Page,
  match: (i: { id: string; name: string; versionLabel: string }) => boolean,
): Promise<{ id: string; name: string; versionLabel: string }> {
  const res = await page.request.get("/api/admin/package-installs");

  expect(res.ok()).toBeTruthy();
  const body = (await res.json()) as {
    installs: { id: string; name: string; versionLabel: string }[];
  };
  const hit = body.installs.find(match);

  expect(hit, "expected install not found").toBeTruthy();

  return hit!;
}

// Fork the installed package from the viewer; a prior fork of the same
// install surfaces the dedup dialog — take "Fork a new copy".
async function forkFromViewer(page: Page): Promise<string> {
  await page.goto(`/studio/packages/${RUN_TAG}`);
  await page.getByTestId("package-fork").click();
  const newCopy = page.getByRole("button", { name: "Fork a new copy" });

  if (await newCopy.isVisible().catch(() => false)) {
    await newCopy.click();
  }
  await page.waitForURL(/\/studio\/edit\//, { timeout: 30_000 });

  return new URL(page.url()).pathname.split("/")[3]!;
}

// Working-dir writes as API plumbing under our OWN lock session (the file
// editor UI is covered by studio-diff.spec.ts). Release so the editor page
// can re-acquire afterwards.
async function withEditSession(
  page: Page,
  packageId: string,
  work: (sessionId: string) => Promise<void>,
): Promise<void> {
  const sessionId = `e2e-fpl-${Math.random().toString(36).slice(2, 10)}`;
  const lock = await page.request.post(
    `/api/studio/local-packages/${packageId}/lock-refresh`,
    { data: { sessionId } },
  );

  expect(lock.ok()).toBeTruthy();
  expect(((await lock.json()) as { heldByMe: boolean }).heldByMe).toBe(true);
  try {
    await work(sessionId);
  } finally {
    await page.request.post(
      `/api/studio/local-packages/${packageId}/lock-release`,
      { data: { sessionId } },
    );
  }
}

async function putFile(
  page: Page,
  packageId: string,
  sessionId: string,
  path: string,
  content: string,
): Promise<void> {
  const res = await page.request.put(
    `/api/studio/local-packages/${packageId}/files/${path}`,
    { data: { sessionId, content } },
  );

  expect(res.ok()).toBeTruthy();
}

async function commitWorkingDir(
  page: Page,
  packageId: string,
  sessionId: string,
  message: string,
): Promise<void> {
  const res = await page.request.post(
    `/api/studio/local-packages/${packageId}/commit`,
    { data: { sessionId, message } },
  );

  expect(res.ok()).toBeTruthy();
}

// Cut through the T16 dialog on /studio/local, scoped to the package row.
async function cutViaDialog(
  page: Page,
  localName: string,
  expectNoAdoptTargets: boolean,
): Promise<void> {
  await page.goto("/studio/local");
  await page
    .locator('[data-testid="local-list"] li', { hasText: localName })
    .getByTestId("local-cut")
    .click();
  const dialog = page.getByRole("dialog");

  if (expectNoAdoptTargets) {
    // The board project is attached to the UPSTREAM install of the same
    // name — eligibility is the back-edge, so it is NOT offered here.
    await expect(
      dialog.getByText("No project is attached to a cut of this package yet", {
        exact: false,
      }),
    ).toBeVisible();
  }
  await dialog.getByTestId("cut-dialog-submit").click();
  await expect(dialog.getByText("Cut local-", { exact: false })).toBeVisible({
    timeout: 30_000,
  });
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
}

test.describe.configure({ mode: "serial" });

test("install → fork → edit → cut → experiment lab shows fork-vs-upstream provenance", async ({
  page,
}) => {
  test.setTimeout(300_000);
  const fx = loadFixtures().byKey.board;

  repo = buildPackageRepo();

  // Source + discovery + install v1 (UI).
  await addGitSource(page, repo);
  await refreshSource(page, repo);
  await expect(page.getByText(RUN_TAG, { exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await installTag(page, `${RUN_TAG}/v1.0.0`);
  upstreamInstallId = (await findInstall(page, (i) => i.name === RUN_TAG)).id;

  // Attach the UPSTREAM install to the seeded project + trust it (API
  // plumbing — the attach/trust UI is package-management.spec.ts's ground).
  const attach = await page.request.post(
    `/api/projects/${fx.projectSlug}/packages`,
    { data: { packageInstallId: upstreamInstallId } },
  );

  expect(attach.status()).toBe(201);
  const { attachmentId } = (await attach.json()) as { attachmentId: string };
  const trust = await page.request.post(
    `/api/projects/${fx.projectSlug}/packages/${attachmentId}/trust`,
    { data: {} },
  );

  expect(trust.ok()).toBeTruthy();

  // Fork to local (UI) + give the local row a unique, targetable name.
  fork1Id = await forkFromViewer(page);
  const rename = await page.request.patch(
    `/api/studio/local-packages/${fork1Id}`,
    { data: { name: `fpl1-${RUN_TAG}` } },
  );

  expect(rename.ok()).toBeTruthy();

  // Edit the flow in the editor (CodeMirror) → save → commit (UI idiom).
  const lockReacquired = page.waitForResponse(
    (r) =>
      new URL(r.url()).pathname.endsWith("/lock-refresh") &&
      r.request().method() === "POST" &&
      r.ok(),
  );

  await page.goto(`/studio/edit/${fork1Id}/flows/e2e-flow/flow.yaml`);
  await lockReacquired;
  await page.getByTestId("flow-tab-yaml").click();
  const yaml = page
    .getByTestId("flow-yaml-editor")
    .locator(".cm-content")
    .first();

  await yaml.click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.insertText("\n# forked variant\n");
  await page.getByTestId("topbar-save").click();
  await expect(page.getByTestId("local-editor-saved")).toBeVisible({
    timeout: 30_000,
  });
  await page.getByTestId("flow-tab-diff").click();
  await page.getByTestId("lp-diff-commit").click();
  await expect(page.getByTestId("lp-diff-changed")).toContainText("0", {
    timeout: 30_000,
  });
  await page.getByTestId("local-editor-end-edit").click();
  await page.waitForURL(/\/studio\/local$/, { timeout: 15_000 });

  // Cut #1 (T16 dialog; upstream-pinned project NOT offered as adopt target).
  await cutViaDialog(page, `fpl1-${RUN_TAG}`, true);
  cut1InstallId = (
    await findInstall(
      page,
      (i) => i.name === RUN_TAG && i.versionLabel.startsWith("local-"),
    )
  ).id;

  // Task bound to the package's flow → experiment A=upstream / B=fork cut.
  // createTask validates the flows ROW id (not the ref id) — resolve it.
  let flowRowId = "";

  await withE2EDb(async (pool) => {
    const { rows } = await pool.query(
      `SELECT f.id FROM flows f
       JOIN projects p ON p.id = f.project_id
       WHERE p.slug = $1 AND f.flow_ref_id = $2`,
      [fx.projectSlug, FLOW_ID],
    );

    flowRowId = rows[0]?.id ?? "";
  });
  expect(flowRowId).toBeTruthy();

  const task = await page.request.post(
    `/api/projects/${fx.projectSlug}/tasks`,
    {
      data: {
        title: `Forked-package loop ${RUN_TAG}`,
        prompt: "Compare upstream vs fork cut.",
        flowId: flowRowId,
      },
    },
  );

  expect(task.status()).toBe(201);
  const { taskId } = (await task.json()) as { taskId: string };
  const created = await page.request.post(
    `/api/projects/${fx.projectSlug}/experiments`,
    {
      data: {
        taskId,
        title: `Fork vs upstream ${RUN_TAG}`,
        description: "ADR-129 packagePin axis.",
        baseBranch: "main",
        variants: [
          { key: "control", label: "Upstream", config: {} },
          {
            key: "candidate",
            label: "Fork cut",
            config: { packagePin: { packageInstallId: cut1InstallId } },
          },
        ],
        rubric: {
          criteria: [
            {
              id: "correctness",
              label: "Correctness",
              guidance: "Works as requested",
              scale: { min: 1, max: 5 },
              weight: 1,
            },
          ],
        },
      },
    },
  );

  expect(created.status()).toBe(201);
  const { id: experimentId } = (await created.json()) as { id: string };
  const launch = await page.request.post(
    `/api/projects/${fx.projectSlug}/experiments/${experimentId}/launch`,
    { data: { variants: "all", replicates: 1 } },
  );

  expect(launch.status()).toBe(200);
  const launched = (await launch.json()) as {
    outcomes: { runId: string }[];
  };
  const runIds = launched.outcomes.map((o) => o.runId);

  expect(runIds).toHaveLength(2);

  // Force both members comparable (the runs' execution is not this spec's
  // subject) and open the lab.
  await withE2EDb(async (pool) => {
    await pool.query(
      `UPDATE runs
       SET status = 'Review',
           started_at = coalesce(started_at, now() - interval '1 minute'),
           ended_at = now()
       WHERE id = ANY($1::text[])`,
      [runIds],
    );
  });

  await page.goto(`/projects/${fx.projectSlug}/experiments/${experimentId}`);
  await expect(
    page.getByRole("heading", { name: `Fork vs upstream ${RUN_TAG}` }),
  ).toBeVisible();

  // ADR-129 provenance: per-variant chips + the cross-variant delta marker.
  await expect(page.getByText("package versions differ")).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByText("local cut", { exact: true })).toBeVisible();
  await expect(page.getByText("upstream", { exact: true })).toBeVisible();

  // The six comparison tabs render.
  for (const tab of [
    "Diff",
    "Diff of diffs",
    "Files",
    "Gates",
    "Cost",
    "Verdict",
  ]) {
    await expect(
      page.getByRole("tab", { name: tab, exact: true }).first(),
    ).toBeVisible();
  }
});

test("attach the fork beside its upstream: rename explainer → rename + re-cut → attached", async ({
  page,
}) => {
  test.setTimeout(240_000);
  const fx = loadFixtures().byKey.board;

  // Picking the name-colliding cut surfaces the explainer and blocks Attach.
  await page.goto(`/projects/${fx.projectSlug}?tab=packages`);
  await page.getByLabel("Attach").selectOption({ value: cut1InstallId });
  await expect(
    page.getByText("fork shares its upstream's package name", {
      exact: false,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Attach", exact: true }),
  ).toBeDisabled();

  // The Studio rename journey: manifest name + flow id → commit → re-cut.
  await withEditSession(page, fork1Id, async (sessionId) => {
    await putFile(
      page,
      fork1Id,
      sessionId,
      "maister-package.yaml",
      `schemaVersion: 1\nname: ${RUN_TAG}fork\nflows:\n  - { id: ${FLOW_ID}-fork, path: flows/e2e-flow }\n`,
    );
    await commitWorkingDir(page, fork1Id, sessionId, "rename fork");
  });
  await cutViaDialog(page, `fpl1-${RUN_TAG}`, false);

  // The renamed cut attaches beside the upstream.
  const renamedCut = await findInstall(
    page,
    (i) => i.name === `${RUN_TAG}fork` && i.versionLabel.startsWith("local-"),
  );

  await page.goto(`/projects/${fx.projectSlug}?tab=packages`);
  await page.getByLabel("Attach").selectOption({ value: renamedCut.id });
  await expect(
    page.getByRole("button", { name: "Attach", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Attach", exact: true }).click();
  await expect(
    page.getByRole("link", { name: `${RUN_TAG}fork`, exact: true }),
  ).toBeVisible({ timeout: 30_000 });
  await expect(
    page.getByRole("link", { name: RUN_TAG, exact: true }),
  ).toBeVisible();
});

test("upstream re-tag → install & sync with conflict → resolve → publish base + sync-first refusal", async ({
  page,
}) => {
  test.setTimeout(300_000);

  // fork1's lineage still points at the UPSTREAM v1 install (the T15 rename
  // touched only the manifest), so it is the sync subject. Give it a
  // conflicting committed edit first.
  await withEditSession(page, fork1Id, async (sessionId) => {
    await putFile(
      page,
      fork1Id,
      sessionId,
      "docs/README.md",
      "fork readme edit\n",
    );
    await commitWorkingDir(page, fork1Id, sessionId, "fork readme edit");
  });

  // Upstream moves: v2 changes the SAME file → re-tag → re-discover.
  writeFileSync(
    join(repo, "packages", RUN_TAG, "docs/README.md"),
    "upstream readme v2\n",
  );
  git(repo, "add", "-A");
  git(repo, "commit", "-m", "v2");
  git(repo, "tag", `${RUN_TAG}/v2.0.0`);
  await refreshSource(page, repo);
  await expect(
    page.getByRole("button", { name: `${RUN_TAG}/v2.0.0 · install` }),
  ).toBeVisible({ timeout: 30_000 });

  // Editor → Sync from upstream → install & sync the fresh tag → conflict.
  const lockReacquired = page.waitForResponse(
    (r) =>
      new URL(r.url()).pathname.endsWith("/lock-refresh") &&
      r.request().method() === "POST" &&
      r.ok(),
  );

  await page.goto(`/studio/edit/${fork1Id}`);
  await lockReacquired;
  await page.getByTestId("local-editor-sync").click();
  await page
    .getByTestId("sync-target-select")
    .selectOption({ label: `Install & sync — ${RUN_TAG}/v2.0.0` });
  await page.getByTestId("sync-start").click();
  await expect(page.getByTestId("sync-notice")).toBeVisible({
    timeout: 60_000,
  });
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Close", exact: true })
    .click();

  // The pending banner lists the conflicted file.
  await page.reload();
  await expect(page.getByTestId("sync-banner")).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByTestId("sync-conflicted-file")).toContainText(
    "docs/README.md",
  );

  // Resolve the file (API plumbing under our own session). Leave the editor
  // first — its keepalive would re-steal the same-user lock mid-write.
  await page.goto("/studio/local");
  await withEditSession(page, fork1Id, async (sessionId) => {
    await putFile(
      page,
      fork1Id,
      sessionId,
      "docs/README.md",
      "merged readme: fork + v2\n",
    );
  });
  await page.goto(`/studio/edit/${fork1Id}`);
  await expect(page.getByTestId("sync-banner")).toBeVisible({
    timeout: 30_000,
  });
  await page.getByTestId("sync-resolve").click();
  await expect(page.getByTestId("sync-banner")).toHaveCount(0, {
    timeout: 30_000,
  });

  // Publish to a bare remote registered WITH a base branch (T14 field).
  const barePath = mkdtempSync(join(tmpdir(), "maister-e2e-fpl-bare-"));

  git(barePath, "init", "--bare");
  await addGitSource(page, barePath, "develop");

  await page.goto(`/studio/edit/${fork1Id}`);
  await page.getByTestId("local-editor-publish").click();
  await page.getByTestId("publish-source").selectOption({ label: barePath });
  await page.getByTestId("publish-submit").click();
  await expect(page.getByTestId("publish-result")).toBeVisible({
    timeout: 60_000,
  });
  await page.getByTestId("publish-cancel").click();

  // Move the remote maister/<slug> branch independently → the next publish
  // refuses with "upstream moved — sync first" and the sync CTA (canSync).
  const branch = gitOut(barePath, "for-each-ref", "--format=%(refname:short)")
    .split("\n")
    .find((name) => name.startsWith("maister/"))!;

  expect(branch).toBeTruthy();
  const parent = gitOut(barePath, "rev-parse", branch);
  const tree = gitOut(barePath, "rev-parse", `${branch}^{tree}`);
  const moved = gitOut(
    barePath,
    "commit-tree",
    tree,
    "-p",
    parent,
    "-m",
    "moved upstream",
  );

  git(barePath, "update-ref", `refs/heads/${branch}`, moved);

  await page.getByTestId("local-editor-publish").click();
  await page.getByTestId("publish-source").selectOption({ label: barePath });
  await page.getByTestId("publish-submit").click();
  await expect(page.getByTestId("publish-upstream-moved")).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.getByTestId("publish-close-and-sync")).toBeVisible();
  // The remote branch was NOT force-updated.
  expect(gitOut(barePath, "rev-parse", branch)).toBe(moved);
});
