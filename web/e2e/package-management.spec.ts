import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { test, expect } from "@playwright/test";

import { createE2EDbPool, withE2EDb } from "./_seed/db";
import { loadFixtures } from "./_seed/fixtures";

import { resolvePostgresDbUrl } from "@/lib/db/postgres-url";

// (ADR-088) End-to-end package management: add a platform source (local git
// monorepo fixture built by THIS spec), refresh discovery, install a tag,
// attach to a project, see member flows, detach. One serial test — the steps
// share state and the e2e DB is shared across worktrees (no parallel reruns
// of intermediate state). Package name is unique per run so a crashed prior
// run can never collide on (project, package_name).
const RUN_TAG = `e2epkg${Date.now().toString(36)}`;

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
  const repo = mkdtempSync(join(tmpdir(), "maister-e2e-pkg-"));

  git(repo, "init", "-b", "main");
  const pkgDir = join(repo, "packages", RUN_TAG);

  mkdirSync(join(pkgDir, "flows/e2e-flow"), { recursive: true });
  writeFileSync(
    join(pkgDir, "maister-package.yaml"),
    `schemaVersion: 1\nname: ${RUN_TAG}\nflows:\n  - { id: ${RUN_TAG}-flow, path: flows/e2e-flow }\n`,
  );
  writeFileSync(
    join(pkgDir, "flows/e2e-flow/flow.yaml"),
    `schemaVersion: 1\nname: ${RUN_TAG}-flow\ncompat:\n  engine_min: 1.1.0\nnodes:\n  - id: s1\n    type: cli\n    action:\n      command: echo hi\n    transitions:\n      success: done\n`,
  );
  git(repo, "add", "-A");
  git(repo, "commit", "-m", "init");
  git(repo, "tag", `${RUN_TAG}/v1.0.0`);

  return repo;
}

test("package source → discovery → install → attach → detach round-trip", async ({
  browser,
  baseURL,
  page,
}) => {
  test.setTimeout(180_000);
  const fixtures = loadFixtures().byKey;
  const projectSlug = fixtures.board.projectSlug;
  const repo = buildPackageRepo();

  // 1. Add the source on /studio/sources (Sources relocated from /settings).
  await page.goto("/studio/sources");
  await expect(
    page.getByRole("heading", { name: "Package sources" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Add package source" }).click();
  const dialog = page.getByRole("dialog");

  // `file://` is REQUIRED, not cosmetic: `validateUrl` (`lib/repo-source.ts`)
  // admits only https/http/ssh/file plus scp-short `git@host:`, so a bare
  // absolute path is refused "repoUrl scheme not allowed" at the dialog. The
  // allow-list landed in `01c75594` (ADR-129 remediation) and these specs,
  // written before it, kept filling the raw temp path.
  await dialog.getByLabel("Git monorepo URL").fill(`file://${repo}`);
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText(repo)).toBeVisible();

  // 2. Refresh discovery → package + tag appear (scope to OUR source row —
  // other settings panels ship their own Refresh buttons).
  await page
    .locator("tr", { hasText: repo })
    .getByRole("button", { name: "Refresh", exact: true })
    .click();
  await expect(page.getByText(RUN_TAG, { exact: true })).toBeVisible({
    timeout: 30_000,
  });

  // 3. Install the discovered tag → installed revisions row.
  await page
    .getByRole("button", { name: `${RUN_TAG}/v1.0.0 · install` })
    .click();
  await expect(
    page.getByRole("button", { name: `${RUN_TAG}/v1.0.0 · installed` }),
  ).toBeVisible({ timeout: 30_000 });
  await expect(
    page.getByRole("heading", { name: "Installed package revisions" }),
  ).toBeVisible();

  // UX-01A/B: a local install can export the upstream package's name.
  const localRepo = buildPackageRepo();
  const localPackage = join(localRepo, "packages", RUN_TAG);
  const localManifest = join(localPackage, "flows/e2e-flow/flow.yaml");

  writeFileSync(
    localManifest,
    readFileSync(localManifest, "utf8").replace(
      "echo hi",
      "echo local-revision",
    ),
  );
  const local = await page.request.post("/api/admin/package-installs", {
    data: { localPath: localPackage },
  });

  expect(local.status(), await local.text()).toBe(201);
  const localInstall: { id: string } = await local.json();

  await page.goto(`/studio/packages/${RUN_TAG}`);
  const localChoice = page
    .getByTestId("studio-package-chooser")
    .locator(`a[href*="install=${localInstall.id}"]`);

  await expect(localChoice).toHaveCount(1);
  await localChoice.click();
  await expect(page).toHaveURL(new RegExp(`install=${localInstall.id}`));
  await page.reload();
  await expect(page.getByTestId("package-bom")).toBeVisible();
  await page.goBack();
  await expect(localChoice).toBeVisible();
  await page.goForward();
  await expect(page).toHaveURL(new RegExp(`install=${localInstall.id}`));
  const memberPath = `/studio/packages/${RUN_TAG}/flows/${RUN_TAG}-flow`;

  await page.goto(memberPath);
  const choices = page.getByTestId("studio-package-chooser").getByRole("link");
  const upstream = choices.and(
    page.locator(`a[href^="${memberPath}?"]:not([href*="${localInstall.id}"])`),
  );
  const upstreamHref = await upstream.getAttribute("href");

  expect(upstreamHref).toMatch(/\?install=/);
  const upstreamId = new URL(upstreamHref!, page.url()).searchParams.get(
    "install",
  );

  await page.goto("/studio/packages");
  for (const id of [localInstall.id, upstreamId]) {
    const packageHref = `/studio/packages/${RUN_TAG}?install=${id}`;

    await page.locator(`a[href="${packageHref}"]`).click();
    await expect(page).toHaveURL(new RegExp(`install=${id}`));
    await page.goBack();
  }
  for (const [href, command] of [
    [`${memberPath}?install=${localInstall.id}`, "echo local-revision"],
    [upstreamHref!, "echo hi"],
  ]) {
    await page.goto(href);
    await page.getByTestId("flow-yaml-toggle").click();
    await expect(page.getByTestId("flow-yaml-panel")).toContainText(command);
  }

  // UX-01C: whole-fork resolution uses the selected install and retains dedup.
  const forkPath = `/api/studio/packages/${RUN_TAG}/fork`;
  const elementPath = `${forkPath}-element`;
  const element = {
    elementName: "Local member",
    elementPath: "flows/e2e-flow",
  };
  const viewerContext = await browser.newContext({
    baseURL,
    storageState: { cookies: [], origins: [] },
  });

  try {
    const viewer = await viewerContext.newPage();

    await viewer.goto("/login");
    await viewer.locator('input[name="email"]').fill(fixtures.m22.viewerEmail);
    await viewer
      .locator('input[name="password"]')
      .fill(fixtures.m22.viewerPassword);
    await viewer.locator('form button[type="submit"]').click();
    await viewer.waitForURL((url) => !url.pathname.startsWith("/login"));
    expect(
      (
        await viewer.request.post(`${forkPath}?install=${localInstall.id}`)
      ).status(),
    ).toBe(403);
    expect(
      (
        await viewer.request.post(`${elementPath}?install=${localInstall.id}`, {
          data: element,
        })
      ).status(),
    ).toBe(403);
  } finally {
    await viewerContext.close();
  }

  for (const [ref, query] of [
    [RUN_TAG, ""],
    [RUN_TAG, "?install="],
    [RUN_TAG, "?install=unknown"],
    [RUN_TAG, `?install=${localInstall.id}&install=${localInstall.id}`],
    ["different-package", `?install=${localInstall.id}`],
  ]) {
    const invalidFork = `/api/studio/packages/${ref}/fork`;

    expect((await page.request.post(`${invalidFork}${query}`)).status()).toBe(
      404,
    );
    expect(
      (
        await page.request.post(`${invalidFork}-element${query}`, {
          data: element,
        })
      ).status(),
    ).toBe(404);
  }
  const forkElement = await page.request.post(
    `${elementPath}?install=${localInstall.id}`,
    { data: element },
  );

  expect(forkElement.status(), await forkElement.text()).toBe(201);
  const { localPackageId: elementForkId } = (await forkElement.json()) as {
    localPackageId: string;
  };
  const forkedFile = await page.request.get(
    `/api/studio/local-packages/${elementForkId}/files/flows/e2e-flow/flow.yaml`,
  );

  expect(forkedFile.ok(), await forkedFile.text()).toBe(true);
  expect(await forkedFile.json()).toMatchObject({
    content: expect.stringContaining("echo local-revision"),
  });
  const fork = await page.request.post(
    `${forkPath}?install=${localInstall.id}`,
  );

  expect(fork.status(), await fork.text()).toBe(201);
  const forked: { localPackageId: string } = await fork.json();
  const repeated = await page.request.post(
    `${forkPath}?install=${localInstall.id}`,
  );

  expect(repeated.status()).toBe(200);
  expect(await repeated.json()).toEqual({ ...forked, alreadyExists: true });

  for (const data of [undefined, "{", { ...element, unexpected: true }]) {
    const response = await page.request.post(
      `${elementPath}?install=${localInstall.id}`,
      { data, headers: { "content-type": "application/json" } },
    );

    expect(response.status()).toBe(422);
    expect(await response.json()).toMatchObject({ code: "CONFIG" });
  }
  const malformedWholeFork = await page.request.post(
    `${forkPath}?install=${localInstall.id}`,
    { data: "{", headers: { "content-type": "application/json" } },
  );

  expect(malformedWholeFork.status()).toBe(200);
  expect(await malformedWholeFork.json()).toEqual({
    ...forked,
    alreadyExists: true,
  });

  // 4. Attach to the seeded project from the packages tab.
  await page.goto(`/projects/${projectSlug}?tab=packages`);
  await expect(
    page.getByRole("heading", { name: "Attached packages" }),
  ).toBeVisible();
  await page
    .getByLabel("Attach")
    .selectOption({ label: `${RUN_TAG}@${RUN_TAG}/v1.0.0` });
  await page.getByRole("button", { name: "Attach", exact: true }).click();
  await expect(
    page.getByRole("link", { name: RUN_TAG, exact: true }),
  ).toBeVisible({ timeout: 30_000 });
  const attachmentHref = await page
    .getByRole("link", { name: RUN_TAG, exact: true })
    .getAttribute("href");

  expect(attachmentHref).toMatch(/\?install=/);
  expect(attachmentHref).not.toContain(localInstall.id);
  await expect(page.getByText(`${RUN_TAG}-flow`).first()).toBeVisible();
  await page
    .getByTestId("flow-preview-card")
    .getByRole("link", { name: `${RUN_TAG}-flow` })
    .click();
  await expect(page.getByTestId("open-flow-in-studio")).toHaveAttribute(
    "href",
    upstreamHref!,
  );
  const flowViewerPath = new URL(page.url()).pathname;

  // Installing a newer tag leaves the project's existing attachment on v1.
  const upstreamManifest = join(
    repo,
    "packages",
    RUN_TAG,
    "flows/e2e-flow/flow.yaml",
  );

  writeFileSync(
    upstreamManifest,
    readFileSync(upstreamManifest, "utf8")
      .replace("id: s1", "id: upgraded-step")
      .replace("echo hi", "echo upstream-v2"),
  );
  git(repo, "add", "-A");
  git(repo, "commit", "-m", "v2");
  git(repo, "tag", `${RUN_TAG}/v2.0.0`);
  await page.goto("/studio/sources");
  await page
    .locator("tr", { hasText: repo })
    .getByRole("button", { name: "Refresh", exact: true })
    .click();
  await page
    .getByRole("button", { name: `${RUN_TAG}/v2.0.0 · install` })
    .click();
  await expect(
    page.getByRole("button", { name: `${RUN_TAG}/v2.0.0 · installed` }),
  ).toBeVisible({ timeout: 30_000 });

  await page.goto(`/projects/${projectSlug}?tab=packages`);
  await page.getByRole("link", { name: RUN_TAG, exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`install=${upstreamId}`));
  const newer = page.getByRole("link", {
    name: `${RUN_TAG}/v2.0.0`,
    exact: true,
  });

  await expect(newer).toBeVisible();
  const newerHref = await newer.getAttribute("href");

  expect(newerHref).not.toBeNull();
  const newerInstallId = new URL(newerHref!, page.url()).searchParams.get(
    "install",
  );

  expect(newerInstallId).toBeTruthy();
  await newer.click();
  await expect(newer).toHaveAttribute("aria-current", "page");
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`install=${upstreamId}`));

  const runId = randomUUID();
  const beforeUpgrade = await withE2EDb(async (pool) => {
    const { rows } = await pool.query<{
      attachment_id: string;
      revision_id: string;
      source: string;
    }>(
      `SELECT a.id AS attachment_id, f.enabled_revision_id AS revision_id, f.source
         FROM projects p
         JOIN flows f ON f.project_id = p.id
         JOIN project_package_attachments a
           ON a.project_id = p.id AND a.package_install_id = f.package_install_id
        WHERE p.slug = $1 AND f.flow_ref_id = $2`,
      [projectSlug, `${RUN_TAG}-flow`],
    );
    const [pinned] = rows;

    expect(pinned?.revision_id).toBeTruthy();
    const retained = await pool.query(
      `INSERT INTO runs (id, project_id, flow_id, run_kind, status, flow_version, flow_revision, flow_revision_id)
       SELECT $1, f.project_id, f.id, 'flow', 'Done', f.version, r.resolved_revision, r.id
         FROM flows f JOIN flow_revisions r ON r.id = f.enabled_revision_id
         JOIN projects p ON p.id = f.project_id
        WHERE p.slug = $2 AND r.id = $3`,
      [runId, projectSlug, pinned.revision_id],
    );

    expect(retained.rowCount).toBe(1);

    return pinned;
  });

  try {
    const upgraded = await page.request.post(
      `/api/projects/${projectSlug}/packages/${beforeUpgrade.attachment_id}/upgrade`,
      { data: { packageInstallId: newerInstallId } },
    );

    expect(upgraded.ok(), await upgraded.text()).toBe(true);
    const afterUpgrade = await withE2EDb(async (pool) => {
      const { rows } = await pool.query<{ source: string }>(
        `SELECT f.source FROM flows f JOIN projects p ON p.id = f.project_id
          WHERE p.slug = $1 AND f.flow_ref_id = $2`,
        [projectSlug, `${RUN_TAG}-flow`],
      );

      return rows[0];
    });

    expect(afterUpgrade?.source).toBeTruthy();
    expect(afterUpgrade?.source).not.toBe(beforeUpgrade.source);

    await page.goto(flowViewerPath);
    const currentStudioLink = page.getByTestId("open-flow-in-studio");

    await expect(currentStudioLink).toHaveAttribute(
      "href",
      `${memberPath}?install=${newerInstallId}`,
    );
    await currentStudioLink.click();
    await expect(page).toHaveURL(`${memberPath}?install=${newerInstallId}`);
    await expect(page.getByRole("textbox", { name: "Command" })).toHaveValue(
      "echo upstream-v2",
    );

    await page.goto(`${flowViewerPath}?rev=${beforeUpgrade.revision_id}`);
    const historicalStudioLink = page.getByTestId("open-flow-in-studio");

    await expect(historicalStudioLink).toHaveAttribute("href", upstreamHref!);
    await expect(page.getByTestId("package-fork-slot")).toHaveCount(0);
    await expect(page.getByTestId("package-runner-bindings")).toHaveCount(0);
    await historicalStudioLink.click();
    await expect(page).toHaveURL(upstreamHref!);
    await expect(page.getByRole("textbox", { name: "Command" })).toHaveValue(
      "echo hi",
    );
  } finally {
    await withE2EDb((pool) =>
      pool.query("DELETE FROM runs WHERE id = $1", [runId]),
    );
  }

  const localProject = fixtures.m22.projectSlug;
  const localAttachment = await page.request.post(
    `/api/projects/${localProject}/packages`,
    {
      data: { packageInstallId: localInstall.id },
    },
  );

  expect(localAttachment.status(), await localAttachment.text()).toBe(201);
  const { attachmentId: localAttachmentId } =
    (await localAttachment.json()) as { attachmentId: string };

  await page.goto(`/projects/${localProject}?tab=packages`);
  await page.getByRole("link", { name: RUN_TAG, exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`install=${localInstall.id}`));
  const detached = await page.request.delete(
    `/api/projects/${localProject}/packages/${localAttachmentId}`,
  );

  expect(detached.ok(), await detached.text()).toBe(true);

  await page.goto(`/projects/${projectSlug}?tab=packages`);

  // 5. Detach → attachment gone (empty state or no link).
  // Scoped to THIS package's row. The bare `getByRole("button", …)` assumed
  // the project had exactly one attachment; the seed since gained another
  // (`e2e-mentions-pkg`), so the unscoped locator matched two Detach buttons
  // and died on strict mode. Row-scoping is also what the test means — it
  // detaches the package it attached, not whichever one renders first.
  await page
    .locator("tr", { hasText: RUN_TAG })
    .getByRole("button", { name: "Detach" })
    .click();
  await expect(
    page.getByRole("link", { name: RUN_TAG, exact: true }),
  ).toHaveCount(0, { timeout: 30_000 });

  const db = createE2EDbPool(resolvePostgresDbUrl());

  try {
    const removed = await db.query(
      "UPDATE package_installs SET package_status = 'Removed' WHERE id = $1",
      [localInstall.id],
    );

    expect(removed.rowCount).toBe(1);
    await page.goto(`${memberPath}?install=${localInstall.id}`);
    // Next can stream the app shell before the member lookup returns not-found.
    await expect(
      page.getByRole("heading", { name: "404", exact: true }),
    ).toBeVisible();
    await expect(page.getByTestId("flow-yaml-toggle")).toHaveCount(0);
    expect(
      (
        await page.request.post(`${forkPath}?install=${localInstall.id}`)
      ).status(),
    ).toBe(404);
    expect(
      (
        await page.request.post(`${elementPath}?install=${localInstall.id}`, {
          data: element,
        })
      ).status(),
    ).toBe(404);
  } finally {
    await db.end();
  }
});
