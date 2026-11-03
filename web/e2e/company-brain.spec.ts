import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import { loadFixtures } from "./_seed/fixtures";

test.use({ actionTimeout: 10000 });

// This is the native browser/session path. Live installed-package qualification has a separate lane.
test("E2E-CBU-01 an administrator explicitly enables company knowledge and reviews a captured assertion without implicitly confirming it", async ({
  page,
  context,
}, testInfo) => {
  test.setTimeout(120000);
  const { users } = loadFixtures();
  const surface = page.getByRole("main");
  const title = `Company runbook ${randomUUID()}`;
  const source =
    "Use the configured independent health observation after an allowed restart.";

  await page.goto("/settings/company-grants");
  await expect(
    surface.getByRole("heading", { name: "Company access" }),
  ).toBeVisible();
  await surface
    .getByRole("link", { name: "Grant access", exact: true })
    .click();
  await page
    .getByLabel("Principal", { exact: true })
    .selectOption(`user:${users.admin.id}`);
  for (const action of [
    "Read knowledge",
    "Propose knowledge",
    "Review knowledge",
    "Confirm knowledge",
  ])
    await surface.getByLabel(action, { exact: true }).check();
  await surface
    .getByRole("button", { name: "Grant access", exact: true })
    .click();
  await expect(page).toHaveURL(/\/settings\/company-grants$/);
  await page.goto("/knowledge");
  await expect(
    surface.getByRole("heading", { name: "Company Brain", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("link", { name: "Propose knowledge", exact: true })
    .click();
  await surface.getByLabel("Title", { exact: true }).fill(title);
  await surface.getByLabel("Assertion", { exact: true }).fill(source);
  await page
    .getByLabel("Source title", { exact: true })
    .fill("Configured maintenance runbook");
  await surface
    .getByLabel("Captured source text", { exact: true })
    .fill(source);
  await page
    .getByRole("button", { name: "Submit proposal", exact: true })
    .click();
  await expect(page).toHaveURL(/\/knowledge\/proposals\/[^/]+$/);
  await expect(
    surface.getByRole("heading", { name: title, exact: true }),
  ).toBeVisible();
  const originalProposalUrl = page.url();
  const competingReview = await context.newPage();

  await competingReview.goto(originalProposalUrl);
  await expect(
    competingReview
      .getByRole("main")
      .getByText("Pending review", { exact: true }),
  ).toBeVisible();
  await page.goto("/knowledge/proposals");
  await surface.getByRole("link", { name: title, exact: true }).click();
  await expect(page).toHaveURL(originalProposalUrl);

  await expect(
    surface.getByText("Pending review", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("link", { name: "Inspect evidence", exact: true })
    .click();
  await expect(surface.getByText(source, { exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/knowledge\/witnesses\/[^/]+$/);
  await page.goBack();
  await expect(page).toHaveURL(/\/knowledge\/proposals\/(?!new$)[^/]+$/);
  await page
    .getByLabel("Decision reason", { exact: true })
    .fill("Inspected the exact captured runbook version");
  await page
    .getByRole("button", { name: "Accept proposal", exact: true })
    .click();
  await expect(
    surface.getByRole("link", { name: "Published record", exact: true }),
  ).toBeVisible();
  const competingSurface = competingReview.getByRole("main");

  await competingSurface
    .getByLabel("Decision reason", { exact: true })
    .fill("A stale competing decision must preserve the accepted result.");
  await competingSurface
    .getByRole("button", { name: "Reject proposal", exact: true })
    .click();
  await expect(competingSurface.getByRole("alert")).toHaveText(
    "The revision or delivery changed. Reload and review the current record before retrying.",
  );
  await competingReview.reload();
  await expect(
    competingSurface.getByRole("link", {
      name: "Published record",
      exact: true,
    }),
  ).toBeVisible();
  await competingReview.close();
  await page
    .getByRole("link", { name: "Published record", exact: true })
    .click();
  await expect(surface.getByText("Unconfirmed", { exact: true })).toBeVisible();
  await surface
    .getByRole("link", { name: "Open current record", exact: true })
    .click();
  await surface.getByLabel("Use this supporting witness").check();
  await page
    .getByLabel("Confirmation reason", { exact: true })
    .fill("Confirm against the original available source witness");
  await page
    .getByRole("button", { name: "Confirm assertion", exact: true })
    .click();
  await expect(surface.getByText("Confirmed", { exact: true })).toBeVisible();
  const recordUrl = page.url();

  await page.goto(`/knowledge?q=${encodeURIComponent(title)}`);
  await expect(
    surface.getByRole("link", { name: title, exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    surface.getByRole("searchbox", { name: "Search knowledge", exact: true }),
  ).toHaveValue(title);
  await context.addCookies([
    { name: "NEXT_LOCALE", value: "ru", url: new URL(recordUrl).origin },
  ]);
  await page.goto(recordUrl);
  await expect(
    surface.getByText("Подтверждено", { exact: true }),
  ).toBeVisible();
  await surface
    .getByRole("link", { name: "Предложить исправление", exact: true })
    .click();
  const corrected = `${source} Preserve its original version witness.`;

  await surface.getByLabel("Утверждение", { exact: true }).fill(corrected);
  await surface
    .getByRole("button", { name: "Отправить предложение", exact: true })
    .click();
  await expect(
    surface.getByText("Ожидает рассмотрения", { exact: true }),
  ).toBeVisible();
  await surface
    .getByLabel("Обоснование решения", { exact: true })
    .fill(
      "Исправление сохраняет исходный источник и требует отдельного подтверждения.",
    );
  await surface
    .getByRole("button", { name: "Принять предложение", exact: true })
    .click();
  await surface
    .getByRole("link", { name: "Опубликованная запись", exact: true })
    .click();
  await surface
    .getByRole("link", { name: "Открыть текущую запись", exact: true })
    .click();
  await expect(page).toHaveURL(recordUrl);
  await expect(
    surface.getByText("Не подтверждено", { exact: true }),
  ).toBeVisible();
  await expect(surface.getByText(corrected, { exact: true })).toBeVisible();
  await surface
    .getByRole("heading", { name: title, exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({
    path: testInfo.outputPath("company-knowledge-ru.png"),
  });
  await page.goto(originalProposalUrl);
  await surface
    .getByRole("link", { name: "Опубликованная запись", exact: true })
    .click();
  await expect(page).toHaveURL(`${recordUrl}?revision=1`);
  await expect(
    surface.getByText("Подтверждено", { exact: true }),
  ).toBeVisible();
  await expect(
    surface.getByRole("link", { name: "Открыть текущую запись", exact: true }),
  ).toBeVisible();
  await page.goto(recordUrl);
  await surface.getByLabel("Использовать этот подтверждающий источник").check();
  await surface
    .getByLabel("Обоснование подтверждения", { exact: true })
    .fill("Проверен исходный доступный свидетель содержимого.");
  await surface
    .getByRole("button", { name: "Подтвердить утверждение", exact: true })
    .click();
  await expect(
    surface.getByText("Подтверждено", { exact: true }),
  ).toBeVisible();
  await surface
    .getByLabel("Обоснование подтверждения", { exact: true })
    .fill("Требуется повторная независимая проверка.");
  await surface
    .getByRole("button", { name: "Отозвать подтверждение", exact: true })
    .click();
  const confirmationDialog = page.getByRole("dialog");

  await confirmationDialog
    .getByRole("button", { name: "Отозвать подтверждение", exact: true })
    .click();
  await expect(confirmationDialog).toBeHidden();
  await expect(
    surface.getByText("Подтверждение отозвано", { exact: true }),
  ).toBeVisible();
  await page.goto("/settings/company-grants");
  const readGrant = surface
    .getByRole("row")
    .filter({ has: page.getByRole("cell", { name: /Читать знания/ }) });

  await readGrant
    .getByRole("button", { name: "Отозвать доступ", exact: true })
    .click();
  const grantDialog = page.getByRole("dialog");

  await grantDialog
    .getByLabel("Причина отзыва", { exact: true })
    .fill("Доступ к знаниям отозван для проверки действующих прав.");
  await grantDialog
    .getByRole("button", { name: "Отозвать доступ", exact: true })
    .click();
  await expect(grantDialog).toBeHidden();
  await page.goto(recordUrl);
  await expect(
    surface.getByRole("heading", { name: "Знание недоступно", exact: true }),
  ).toBeVisible();
  await expect(surface.getByText(corrected, { exact: true })).toBeHidden();
  await page.goto(`/knowledge?q=${encodeURIComponent(title)}`);
  await expect(
    surface.getByText("Нет доступных знаний по этим фильтрам.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    surface.getByRole("link", { name: title, exact: true }),
  ).toBeHidden();
  await page.goto(`/knowledge/witnesses/${randomUUID()}`);
  await expect(
    surface.getByRole("heading", { name: "Знание недоступно", exact: true }),
  ).toBeVisible();
});
