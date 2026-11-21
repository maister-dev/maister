import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, test } from "@playwright/test";

import { git } from "@/test-support/git-fixture";

import { withE2EDb } from "./_seed/db";
import { loadFixtures } from "./_seed/fixtures";
import { seedManualTaskLaunchFixture } from "./_seed/manual-task-launch";
import { seedOperationalStopAgent } from "./_seed/operational-stop-agent";

const url = "/api/admin/platform/workspace-integrity";

test("WI-03 WI-07 saves, diagnoses, and resets workspace limits without restarting", async ({
  page,
  browser,
  baseURL,
}) => {
  test.setTimeout(120_000);
  const fixture = await seedManualTaskLaunchFixture();
  const agent = await seedOperationalStopAgent(fixture);
  await writeFile(join(fixture.repo, "large.bin"), Buffer.alloc(1536 * 1024));
  await git(fixture.repo, "add", "large.bin");
  await git(
    fixture.repo,
    "commit",
    "-m",
    "Seed workspace integrity threshold fixture",
  );
  await git(fixture.repo, "push", "origin", "main");
  const { memberCandidate: member } = loadFixtures().users;
  await withE2EDb(async (pool) => {
    await pool.query(
      "INSERT INTO project_members (id,project_id,user_id,role) VALUES ($1,$2,$3,'owner')",
      [randomUUID(), fixture.projectId, member.id],
    );
  });

  const index = async (runId: string) =>
    withE2EDb(
      async (pool) =>
        (
          await pool.query(
            `
      SELECT status, operational_terminal, operational_integrity_baseline,
        (SELECT count(*)::int FROM execution_commands c WHERE c.run_id=r.id AND c.kind='session.create') AS creates,
        (SELECT count(*)::int FROM run_session_incarnations i WHERE i.run_id=r.id) AS sessions
      FROM runs r WHERE id=$1
    `,
            [runId],
          )
        ).rows[0],
    );

  const launch = async (): Promise<string> => {
    const response = await page.request.post(
      `/api/projects/${fixture.slug}/agents/${encodeURIComponent(agent)}/launch`,
      { headers: { Origin: new URL(baseURL!).origin }, data: {} },
    );
    expect(response.status(), await response.text()).toBe(202);
    return (await response.json()).runId;
  };
  const context = page.context();
  await context.addCookies([
    { name: "NEXT_LOCALE", value: "en", url: baseURL! },
  ]);
  expect(await (await page.request.get(url)).json()).toMatchObject({
    maxSizeMiB: { value: 3, source: "environment" },
    maxDurationSeconds: { value: 120, source: "default" },
  });
  await page.goto("/settings");
  await page.getByLabel("Total size (MiB)", { exact: true }).fill("1.5");
  await page.getByRole("button", { name: "Save limits" }).click();
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: "Enter a whole number from 1 to 8,192." }),
  ).toBeVisible();
  await expect(
    page.getByLabel("Total size (MiB)", { exact: true }),
  ).toHaveValue("1.5");
  await page.getByLabel("Total size (MiB)", { exact: true }).fill("1");
  await page.getByLabel("Filesystem entries", { exact: true }).fill("1000");
  await page.getByRole("button", { name: "Save limits" }).click();
  await expect(
    page.getByText("Workspace integrity limits saved."),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByLabel("Total size (MiB)", { exact: true }),
  ).toHaveValue("1");

  const failed = await launch();
  await expect
    .poll(
      async () =>
        (await index(failed))?.operational_terminal?.infrastructureFailure
          ?.integrityLimit,
      {
        timeout: 45000,
      },
    )
    .toMatchObject({ stage: "baseline", limitAxis: "bytes", maximum: 1048576 });
  expect(await index(failed)).toMatchObject({
    status: "Failed",
    creates: 0,
    sessions: 0,
  });
  await page.goto(`/runs/${failed}`);
  await expect(
    page.getByTestId("workspace-integrity-refusal").first(),
  ).toContainText("against a 1 MiB limit");
  await page
    .getByRole("link", { name: /Open setting.*Total size/ })
    .first()
    .click();
  await expect(page).toHaveURL(/settings#workspace-integrity-size$/);
  await expect(page.locator("#workspace-integrity-size")).toHaveValue("1");
  await page.getByRole("button", { name: "Reset Total size (MiB)" }).click();
  await page.getByRole("button", { name: "Save limits" }).click();
  await expect(
    page.getByText("Workspace integrity limits saved."),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByLabel("Total size (MiB)", { exact: true }),
  ).toHaveValue("3");
  await expect(
    page.getByLabel("Filesystem entries", { exact: true }),
  ).toHaveValue("1000");

  const duration = page.getByLabel("Duration (seconds)", { exact: true });
  await duration.fill("90");
  await page.getByRole("button", { name: "Save limits" }).click();
  await expect(
    page.getByText("Effective value 90 from saved setting"),
  ).toBeVisible();
  await page.getByRole("button", { name: "Reset Duration (seconds)" }).focus();
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "Save limits" }).click();
  await expect(
    page.getByText("Effective value 120 from built-in default"),
  ).toBeVisible();

  const passed = await launch();
  await expect
    .poll(
      async () =>
        (await index(passed))?.operational_integrity_baseline?.generation,
      {
        timeout: 45000,
      },
    )
    .toBeGreaterThanOrEqual(1);
  await context.addCookies([
    { name: "NEXT_LOCALE", value: "ru", url: baseURL! },
  ]);
  await page.goto(`/runs/${failed}`);
  await expect(
    page.getByRole("link", { name: /Открыть настройку.*Общий размер/ }).first(),
  ).toBeVisible();
  await expect(
    page.getByTestId("workspace-integrity-refusal").first(),
  ).toContainText("лимите 1 МиБ");

  await page.goto("/settings");
  await expect(
    page.getByRole("heading", { name: "Проверки целостности рабочей области" }),
  ).toBeVisible();
  const localizedEntries = page.getByLabel("Объекты файловой системы", {
    exact: true,
  });
  await localizedEntries.fill("0");
  await page.getByRole("button", { name: "Сохранить лимиты" }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "Введите целое число" }),
  ).toBeVisible();
  await localizedEntries.fill("1000");
  await page.getByRole("button", { name: "Сохранить лимиты" }).click();
  await expect(
    page.getByText("Лимиты проверок целостности сохранены."),
  ).toBeVisible();

  const memberContext = await browser.newContext({
    baseURL,
    storageState: { cookies: [], origins: [] },
  });
  try {
    expect((await memberContext.request.get(url)).status()).toBe(401);
    expect(
      (
        await memberContext.request.patch(url, { data: { maxSizeMiB: null } })
      ).status(),
    ).toBe(401);
    const memberPage = await memberContext.newPage();
    await memberPage.goto("/login");
    await memberPage.locator('input[name="email"]').fill(member.email);
    await memberPage.locator('input[name="password"]').fill(member.password);
    await memberPage.locator('form button[type="submit"]').click();
    await memberPage.waitForURL((value) => value.pathname !== "/login");

    expect((await memberContext.request.get(url)).status()).toBe(403);
    expect(
      (
        await memberContext.request.patch(url, {
          headers: { "content-type": "application/json" },
          data: "malformed{",
        })
      ).status(),
    ).toBe(403);
    const settingsResponse = await memberPage.goto("/settings");
    await expect(
      memberPage.locator("#workspace-integrity-heading"),
    ).toHaveCount(0);
    expect(await settingsResponse!.text()).not.toContain(
      "workspace-integrity-size",
    );
    for (const value of [2, null])
      expect(
        (
          await memberContext.request.patch(url, {
            data: { maxSizeMiB: value },
          })
        ).status(),
      ).toBe(403);
    expect(await (await page.request.get(url)).json()).toMatchObject({
      maxSizeMiB: { value: 3, source: "environment" },
      maxEntries: { value: 1000, source: "platform" },
    });

    for (const locale of ["en", "ru"]) {
      await memberContext.addCookies([
        { name: "NEXT_LOCALE", value: locale, url: baseURL! },
      ]);
      await memberPage.goto(`/runs/${failed}`);
      const notice = memberPage
        .getByTestId("workspace-integrity-refusal")
        .first();
      await expect(notice).toContainText(
        locale === "en"
          ? "Ask a global administrator"
          : "Попросите глобального администратора",
      );
      await expect(notice).toContainText(failed);
      await expect(notice.locator('a[href^="/settings"]')).toHaveCount(0);
    }
  } finally {
    await memberContext.close();
  }
  await withE2EDb(async (pool) => {
    const admin = loadFixtures().users.admin;
    await pool.query("UPDATE users SET role='member' WHERE id=$1", [admin.id]);
    try {
      expect((await page.request.get(url)).status()).toBe(403);
      expect(
        (await page.request.patch(url, { data: { maxEntries: 1 } })).status(),
      ).toBe(403);
    } finally {
      await pool.query("UPDATE users SET role='admin' WHERE id=$1", [admin.id]);
    }
    const { rows } = await pool.query(`
      SELECT workspace_integrity_max_size_mib AS size,
        workspace_integrity_max_duration_seconds AS duration,
        workspace_integrity_max_entries AS entries
      FROM platform_runtime_settings WHERE id='singleton'
    `);
    expect(rows).toEqual([{ size: null, duration: null, entries: 1000 }]);
  });
  await test.info().attach("workspace-integrity-run-ids", {
    body: JSON.stringify({ failed, passed }),
    contentType: "application/json",
  });
});
