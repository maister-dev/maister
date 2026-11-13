import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

test("E2E-CBU-02 opens specialist work from Work and keeps unavailable assignments private in both locales", async ({
  page,
  context,
}) => {
  await page.goto("/work");
  await page
    .getByRole("link", { name: "Specialist assignments", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Specialist assignments", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "My assignments", exact: true }),
  ).toBeVisible();
  const hidden = await page.request.get(
    `/api/specialist-assignments/${randomUUID()}`,
  );

  expect(hidden.status()).toBe(404);
  await context.addCookies([
    { name: "NEXT_LOCALE", value: "ru", url: new URL(page.url()).origin },
  ]);
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Поручения специалистам", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Мои поручения", exact: true }),
  ).toBeVisible();
});
