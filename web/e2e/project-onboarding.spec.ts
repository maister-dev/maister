import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { test, expect, type Page } from "@playwright/test";

import { countRows, withE2EDb } from "./_seed/db";

// Register a new-empty (greenfield) project and land on its board. Returns the
// derived slug. The greenfield repo is git-initialized on `main` with a
// DB defaults; manifest creation requires an explicit reviewed save.
async function registerNewEmpty(page: Page, location: string): Promise<string> {
  const slug = path.basename(location);

  await page.goto("/projects/new");
  await page.getByRole("radio", { name: "New empty project" }).click();
  await page.locator('input[name="target"]').fill(location);
  await page.getByRole("button", { name: "Register project" }).click();
  const href = await page
    .getByRole("link", { name: /Open project/ })
    .getAttribute("href");

  expect(href).toBe(`/projects/${slug}`);
  await page.goto(href!);

  return slug;
}

// ADR-093 onboarding redesign. Runs as the seeded admin (authed storageState).
// Covers the two behaviors the headless component tests cannot drive:
//   1. live URL→name/key prefill (onChange) + dirty-stop,
//   2. the new-empty (greenfield) mode end-to-end.

test("prefills name + task key from the Git URL; a manual edit stops prefill", async ({
  page,
}) => {
  await page.goto("/projects/new");

  // Default mode is "clone" → the URL field is shown.
  await page
    .locator('input[name="repoUrl"]')
    .fill("git@github.com:org/my-cool-repo.git");

  await expect(page.locator('input[name="name"]')).toHaveValue("my-cool-repo");
  await expect(page.locator('input[name="taskKey"]')).toHaveValue("MYC");

  // A manual name edit marks the field dirty; later URL changes no longer
  // overwrite it.
  await page.locator('input[name="name"]').fill("Custom Name");
  await page
    .locator('input[name="repoUrl"]')
    .fill("git@github.com:org/other-repo.git");

  await expect(page.locator('input[name="name"]')).toHaveValue("Custom Name");
});

test("registers a new empty project without writing maister.yaml", async ({
  page,
}) => {
  // Absolute path under the e2e runtime root → mkdir stays out of ~/.maister.
  const location = path.resolve(`e2e/.runtime/greenfield-${Date.now()}`);
  const expectedSlug = path.basename(location);

  await page.goto("/projects/new");

  // Switch to greenfield mode → the URL field disappears.
  await page.getByRole("radio", { name: "New empty project" }).click();
  await expect(page.locator('input[name="repoUrl"]')).toHaveCount(0);

  await page.locator('input[name="target"]').fill(location);

  const registerResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/projects") &&
      response.request().method() === "POST",
  );

  await page.getByRole("button", { name: "Register project" }).click();
  expect((await registerResponse).status()).toBe(201);

  // gitStatus "initialized" → success state (not the remote redirect).
  await expect(page.getByText("Project registered")).toBeVisible();
  await expect(
    page.getByRole("link", { name: /Open project/ }),
  ).toHaveAttribute("href", `/projects/${expectedSlug}`);

  await expect(
    readFile(path.join(location, "maister.yaml"), "utf8"),
  ).rejects.toMatchObject({ code: "ENOENT" });

  const count = await countRows(
    "projects",
    "slug = $1 AND maister_yaml_path IS NULL",
    [expectedSlug],
  );

  expect(count).toBe(1);
});

test("renders a classified, collapsible error when a clone fails", async ({
  page,
}) => {
  await page.goto("/projects/new");

  // Unique repo name → a fresh clone is attempted; a refused localhost URL
  // fails fast → a classified clone PRECONDITION carrying advisory detail.
  await page
    .locator('input[name="repoUrl"]')
    .fill(`https://127.0.0.1:1/x/clonefail-${Date.now()}.git`);

  const res = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/projects") &&
      response.request().method() === "POST",
  );

  await page.getByRole("button", { name: "Register project" }).click();
  expect((await res).status()).toBe(409);

  // The collapsible git-output block is unique to the clone-error surface.
  await expect(page.getByText("Show git output")).toBeVisible();
});

test("adds a git remote from Settings → Git", async ({ page }) => {
  const slug = await registerNewEmpty(
    page,
    path.resolve(`e2e/.runtime/remotes-${Date.now()}`),
  );

  await page.goto(`/projects/${slug}?tab=settings`);
  await expect(
    page.getByRole("heading", { name: "Git remotes" }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Add remote" }).click();

  const dialog = page.getByRole("dialog");

  await dialog.getByPlaceholder("origin").fill("origin");
  await dialog
    .getByPlaceholder("git@github.com:org/app.git")
    .fill("https://github.com/e2e/added.git");

  const added = page.waitForResponse(
    (response) =>
      response.url().includes(`/projects/${slug}/remotes`) &&
      response.request().method() === "POST",
  );

  await dialog.getByRole("button", { name: "Add remote" }).click();
  expect((await added).status()).toBe(201);

  await expect(
    page.getByText("https://github.com/e2e/added.git"),
  ).toBeVisible();
});

async function openConfigReview(page: Page): Promise<void> {
  const response = page.waitForResponse(
    (value) =>
      value.url().endsWith("/persist-config/preview") &&
      value.request().method() === "POST",
  );

  await page.getByTestId("config-persist-open").click();
  const actual = await response;

  expect(actual.status(), JSON.stringify(await actual.json())).toBe(200);
}

test("E2E-CPC-02: review precedes first commit, cancellation is inert and the Settings action survives repeated saves", async ({
  page,
}) => {
  test.slow();
  const location = path.resolve(`e2e/.runtime/config-save-${Date.now()}`);
  const created = await page.request.post("/api/projects", {
    data: {
      mode: "new",
      target: location,
      taskKey: `C${Date.now().toString(36).slice(-7).toUpperCase()}`,
    },
  });

  expect(created.status()).toBe(201);
  const { slug } = (await created.json()) as { slug: string };

  await page.goto(`/projects/${slug}?tab=settings`);
  await openConfigReview(page);
  const dialog = page.getByTestId("config-persist-dialog");

  await dialog.locator("summary").click();
  await expect(dialog.getByTestId("config-persist-diff")).toHaveValue(
    /\+schemaVersion: 2/,
  );
  await expect(dialog.getByTestId("config-persist-diff-view")).toContainText(
    "schemaVersion: 2",
  );
  await expect(dialog.getByTestId("config-persist-diff")).toBeVisible();
  await expect(dialog).toContainText("chore(maister): persist project config");
  await expect(dialog).toContainText("main");
  await dialog.getByTestId("config-persist-close").click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId("config-persist-open")).toBeFocused();
  await expect(
    readFile(path.join(location, "maister.yaml"), "utf8"),
  ).rejects.toMatchObject({ code: "ENOENT" });
  await openConfigReview(page);
  let releaseConfirm!: () => void;
  let enteredConfirm!: () => void;
  const held = new Promise<void>((resolve) => {
    releaseConfirm = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    enteredConfirm = resolve;
  });
  let completedConfirm!: () => void;
  const completed = new Promise<void>((resolve) => {
    completedConfirm = resolve;
  });
  let submissions = 0;

  await page.route(`**/api/projects/${slug}/persist-config`, async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    submissions++;
    enteredConfirm();
    await held;
    await route.fulfill({ response: await route.fetch() });
    completedConfirm();
  });
  await dialog.getByTestId("config-persist-confirm").click();
  await entered;
  await expect(dialog.getByTestId("config-persist-confirm")).toBeDisabled();
  await expect(dialog.getByTestId("config-persist-close")).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Tab");
  expect(
    await dialog.evaluate((element) =>
      element.contains(document.activeElement),
    ),
  ).toBe(true);
  releaseConfirm();
  await completed;
  await expect(dialog.getByTestId("config-commit-success")).toBeVisible();
  expect(submissions).toBe(1);
  await page.unroute(`**/api/projects/${slug}/persist-config`);
  await dialog.getByTestId("config-persist-close").click();
  await openConfigReview(page);
  await expect(dialog.getByTestId("config-persist-noop")).toBeVisible();
  await expect(dialog.getByTestId("config-persist-confirm")).toHaveCount(0);
});

test("E2E-CPC-03: RU stale review, lost receipt reload, explicit push failure and dismissed banner preserve the local commit", async ({
  page,
  context,
}) => {
  test.slow();
  const location = path.resolve(`e2e/.runtime/config-recovery-${Date.now()}`);
  const created = await page.request.post("/api/projects", {
    data: {
      mode: "new",
      target: location,
      taskKey: `R${Date.now().toString(36).slice(-7).toUpperCase()}`,
    },
  });

  expect(created.status()).toBe(201);
  const { slug, projectId } = (await created.json()) as {
    slug: string;
    projectId: string;
  };

  await context.addCookies([
    { name: "NEXT_LOCALE", value: "ru", url: new URL(created.url()).origin },
  ]);
  await page.goto(`/projects/${slug}?tab=settings`);
  await expect(page.getByTestId("config-persist-cached-status")).toHaveCount(0);
  await openConfigReview(page);
  const dialog = page.getByTestId("config-persist-dialog");

  await expect(dialog.getByTestId("config-persist-diff-view")).toBeVisible();
  await withE2EDb(async (pool) => {
    await pool.query("UPDATE projects SET name=$1 WHERE id=$2", [
      "Changed after review",
      projectId,
    ]);
  });
  await dialog.getByTestId("config-persist-confirm").click();
  await expect(dialog.getByRole("alert")).toContainText("изменились");
  await expect(dialog.getByTestId("config-persist-confirm")).toHaveCount(0);
  await dialog.getByTestId("config-persist-refresh").click();
  await dialog.locator("summary").click();
  await expect(dialog.getByTestId("config-persist-diff")).toHaveValue(
    /Changed after review/,
  );

  const base = `**/api/projects/${slug}/persist-config`;
  let serverFinished!: () => void;
  const finished = new Promise<void>((resolve) => {
    serverFinished = resolve;
  });
  let committedSha = "";
  let operationId = "";

  await page.route(`${base}**`, async (route) => {
    if (
      route.request().method() === "POST" &&
      route.request().url().endsWith("persist-config")
    ) {
      const response = await route.fetch();

      expect(response.status()).toBe(200);
      const receipt = (await response.json()) as {
        commitSha: string;
        operationId: string;
      };

      committedSha = receipt.commitSha;
      operationId = receipt.operationId;
      serverFinished();

      return route.abort("failed");
    }

    return route.abort("failed");
  });
  await dialog.getByTestId("config-persist-confirm").click();
  await finished;
  await expect(dialog.getByRole("alert")).toBeVisible();
  expect(committedSha).not.toBe("");
  expect(
    await page.evaluate(
      (key) => sessionStorage.getItem(key),
      `maister.config-operation.${slug}`,
    ),
  ).toBe(operationId);
  await page.unroute(`${base}**`);
  await page.reload();
  await page.getByTestId("config-persist-open").click();
  await expect(dialog.getByTestId("config-commit-success")).toContainText(
    committedSha,
  );
  expect(
    execFileSync("git", ["-C", location, "rev-list", "--count", "HEAD"], {
      encoding: "utf8",
    }).trim(),
  ).toBe("1");

  const remote = `${location}-origin.git`;

  execFileSync("git", ["init", "--bare", remote], { stdio: "pipe" });
  execFileSync(
    "git",
    ["-C", location, "remote", "add", "origin", `file://${remote}`],
    {
      stdio: "pipe",
    },
  );
  await writeFile(
    path.join(remote, "hooks/pre-receive"),
    "#!/bin/sh\nexit 1\n",
    { mode: 0o755 },
  );
  const pushedPreview = page.waitForResponse((value) =>
    value.url().endsWith("/push/preview"),
  );

  await dialog.getByTestId("config-push-review").click();
  const reviewedPush = await pushedPreview;

  expect(reviewedPush.status(), JSON.stringify(await reviewedPush.json())).toBe(
    200,
  );
  await expect(
    dialog.getByRole("textbox", { name: "Отправляемые коммиты" }),
  ).toHaveValue(committedSha);
  await page.route(
    `**/api/projects/${slug}/persist-config/${operationId}`,
    async (route) => {
      if (route.request().method() === "GET") return route.abort("failed");

      return route.continue();
    },
  );
  const pushResponse = page.waitForResponse(
    (value) =>
      value.url().endsWith(`/${operationId}/push`) &&
      value.request().method() === "POST",
  );

  await dialog.getByTestId("config-push-confirm").click();
  const acknowledgedPush = await pushResponse;

  expect(acknowledgedPush.status()).toBe(200);
  expect(await acknowledgedPush.json()).toMatchObject({
    state: "failed",
    localCommitPreserved: true,
  });
  await expect(dialog.getByTestId("config-push-state")).toContainText(
    "Push не удался",
  );
  await expect(dialog.getByTestId("config-commit-success")).toContainText(
    committedSha,
  );
  expect(
    execFileSync("git", ["-C", location, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim(),
  ).toBe(committedSha);
  await dialog.getByTestId("config-persist-close").click();
  await withE2EDb(async (pool) => {
    await pool.query("UPDATE projects SET name=$1 WHERE id=$2", [
      "Applied only",
      projectId,
    ]);
  });
  await page.goto(`/projects/${slug}`);
  await page.getByRole("button", { name: "Скрыть", exact: true }).click();
  await page.reload();
  await expect(page.getByTestId("config-persist-open")).toHaveCount(0);
  await page.goto(`/projects/${slug}?tab=settings`);
  await expect(page.getByTestId("config-persist-open")).toHaveCount(1);
  await expect(page.getByTestId("config-persist-open")).toBeVisible();
  await expect(page.getByTestId("config-persist-status")).toContainText(
    "отличается от Git",
  );
  await page.unroute(`**/api/projects/${slug}/persist-config/${operationId}`);
  const pendingReview = await page.request.post(
    `/api/projects/${slug}/persist-config/${operationId}/push/preview`,
    { data: {} },
  );

  expect(pendingReview.status()).toBe(200);
  const pending = (await pendingReview.json()) as { pushPreviewId: string };

  // Represent the accepted-before-child-ownership crash window; real transport
  // uncertainty/recovery is owned by the push integration suite.
  await withE2EDb(async (pool) => {
    await pool.query(
      "UPDATE project_config_push_intents SET state='pending',accepted_at=now(),owner_token=$2,owner_process_id=$3 WHERE id=$1",
      [pending.pushPreviewId, randomUUID(), process.pid],
    );
    await pool.query(
      "UPDATE project_config_push_intents SET state='unknown',error_reason='push_failed' WHERE id=$1",
      [pending.pushPreviewId],
    );
  });
  await page.reload();
  await page.getByTestId("config-persist-open").click();
  await expect(dialog.getByTestId("config-push-state")).toContainText(
    "Результат push неизвестен",
  );
  await expect(dialog.getByTestId("config-persist-refresh")).toBeVisible();
  await dialog.getByTestId("config-persist-refresh").click();
  await dialog.locator("summary").click();
  await expect(dialog.getByTestId("config-persist-diff")).toHaveValue(
    /Applied only/,
  );
  const nextSave = page.waitForResponse(
    (value) =>
      value.url().endsWith("/persist-config") &&
      value.request().method() === "POST",
  );

  await dialog.getByTestId("config-persist-confirm").click();
  expect((await nextSave).status()).toBe(200);
  await expect(dialog.getByTestId("config-commit-success")).toBeVisible();
  expect(
    execFileSync("git", ["-C", location, "rev-list", "--count", "HEAD"], {
      encoding: "utf8",
    }).trim(),
  ).toBe("2");
  await withE2EDb(async (pool) => {
    expect(
      (
        await pool.query(
          "SELECT state FROM project_config_push_intents WHERE id=$1",
          [pending.pushPreviewId],
        )
      ).rows[0].state,
    ).toBe("unknown");
  });
});

test("E2E-CPC-04: board save retains its receipt and push review across status refreshes", async ({
  page,
}) => {
  test.slow();
  const location = path.resolve(`e2e/.runtime/config-banner-${Date.now()}`);
  const created = await page.request.post("/api/projects", {
    data: {
      mode: "new",
      target: location,
      taskKey: `B${Date.now().toString(36).slice(-7).toUpperCase()}`,
    },
  });

  expect(created.status()).toBe(201);
  const { slug } = (await created.json()) as { slug: string };
  const base = `**/api/projects/${slug}/persist-config`;
  const remote = `${location}-origin.git`;

  execFileSync("git", ["init", "--bare", remote], { stdio: "pipe" });
  execFileSync(
    "git",
    ["-C", location, "remote", "add", "origin", `file://${remote}`],
    { stdio: "pipe" },
  );
  await page.goto(`/projects/${slug}`);
  await openConfigReview(page);
  const dialog = page.getByTestId("config-persist-dialog");
  const saved = page.waitForResponse(
    (response) =>
      response.url().endsWith("/persist-config") &&
      response.request().method() === "POST",
  );

  await dialog.getByTestId("config-persist-confirm").click();
  const receipt = await saved;

  expect(receipt.status()).toBe(200);
  const { commitSha } = (await receipt.json()) as { commitSha: string };
  const refreshed = page.waitForResponse(
    (response) =>
      response.url().endsWith("/persist-config") &&
      response.request().method() === "GET",
  );

  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  expect(await (await refreshed).json()).toMatchObject({
    exportState: "in_sync",
  });
  await expect(dialog.getByTestId("config-commit-success")).toContainText(
    commitSha,
  );
  await dialog.getByTestId("config-push-review").click();
  await expect(dialog.getByTestId("config-push-confirm")).toBeVisible();

  await page.route(base, (route) =>
    route.fulfill({ status: 503, json: { code: "INTERNAL" } }),
  );
  const unavailable = page.waitForResponse(
    (response) =>
      response.url().endsWith("/persist-config") && response.status() === 503,
  );

  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await unavailable;
  await expect(
    dialog.getByRole("textbox", { name: "Commits to publish" }),
  ).toHaveValue(commitSha);
  await page.unroute(base);

  let releasePush!: () => void;
  let enteredPush!: () => void;
  const held = new Promise<void>((resolve) => {
    releasePush = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    enteredPush = resolve;
  });

  await page.route(`${base}/*/push`, async (route) => {
    enteredPush();
    await held;
    await route.fulfill({ response: await route.fetch() });
  });
  try {
    await dialog.getByTestId("config-push-confirm").click();
    await entered;
    const duringPush = page.waitForResponse(
      (response) =>
        response.url().endsWith("/persist-config") &&
        response.request().method() === "GET",
    );

    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    expect(await (await duringPush).json()).toMatchObject({
      exportState: "in_sync",
    });
    await expect(dialog.getByTestId("config-persist-close")).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeVisible();
  } finally {
    releasePush();
  }
  await expect(dialog.getByTestId("config-push-state")).toContainText(
    "Reviewed commit published successfully.",
  );
  expect(
    execFileSync("git", ["--git-dir", remote, "rev-parse", "refs/heads/main"], {
      encoding: "utf8",
    }).trim(),
  ).toBe(commitSha);
  await dialog.getByTestId("config-persist-close").click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId("config-persist-open")).toBeFocused();
  await page.getByRole("button", { name: "Dismiss", exact: true }).click();
  await expect(page.getByTestId("config-persist-open")).toHaveCount(0);
});
