import type { Locator, Page } from "@playwright/test";

import { expect } from "@playwright/test";

const reviewLabels = {
  en: {
    link: "Open reviews in Inbox",
    close: "Close proposal",
    group: "Knowledge & memory",
    reason: "Reason (required)",
  },
  ru: {
    link: "Открыть предложения во входящих",
    close: "Закрыть предложение",
    group: "Знания и память",
    reason: "Причина (обязательно)",
  },
} as const;

export async function prepareKnowledgeReview(
  page: Page,
  title: string,
  reason: string,
  locale: keyof typeof reviewLabels,
  expectedAssertion?: string,
): Promise<Locator> {
  const labels = reviewLabels[locale];

  await page.getByRole("link", { name: labels.link, exact: true }).click();
  const preview = page.getByRole("dialog", { name: title, exact: true });

  await expect(preview).toBeVisible();
  if (expectedAssertion !== undefined) {
    await expect(
      preview.getByText(expectedAssertion, { exact: true }),
    ).toBeVisible({ timeout: 20_000 });
  }
  await preview
    .getByRole("button", { name: labels.close, exact: true })
    .click();
  const reviews = page.getByRole("region", { name: labels.group, exact: true });

  await reviews.getByRole("checkbox", { name: title, exact: true }).check();
  await reviews.getByLabel(labels.reason, { exact: true }).fill(reason);

  return reviews;
}
