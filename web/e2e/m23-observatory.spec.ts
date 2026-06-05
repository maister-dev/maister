import { test, expect } from "@playwright/test";

import { loadFixtures, type E2EM23Fixture } from "./_seed/fixtures";

function loadM23(): E2EM23Fixture {
  return loadFixtures().byKey.m23;
}

test.describe("M23 Observatory", () => {
  test("portfolio and project dashboards render metrics, signals, filters, and node detail", async ({
    page,
  }) => {
    const fx = loadM23();

    await page.goto("/observatory");

    await expect(
      page.getByRole("heading", { name: "Observatory" }),
    ).toBeVisible();
    await expect(page.getByText("Correction rate")).toBeVisible();
    await expect(page.getByText("Autonomy Score")).toBeVisible();
    await expect(page.getByText("Repeated unit gate failed")).toBeVisible();
    await expect(
      page.getByText("access_token=[redacted] failed"),
    ).toBeVisible();

    await page.goto(
      `/projects/${fx.projectSlug}/observatory?flowId=${fx.flowId}&nodeId=${fx.nodeId}`,
    );

    await expect(
      page.getByRole("heading", { name: /Observatory/ }),
    ).toBeVisible();
    await expect(page.getByLabel("Flow")).toHaveValue(fx.flowId);
    await expect(page.getByLabel("Node")).toHaveValue(fx.nodeId);
    await expect(page.getByText("Latest attempt by run")).toBeVisible();
    await expect(page.getByText("#2 · Succeeded").first()).toBeVisible();

    await page.goto(`/projects/${fx.projectSlug}/observatory?nodeId=missing`);

    await expect(
      page.getByText("No node attempts in this window.").first(),
    ).toBeVisible();
  });

  test("RU locale renders Observatory labels", async ({ page, context }) => {
    await context.addCookies([
      {
        name: "NEXT_LOCALE",
        value: "ru",
        url: process.env.E2E_BASE_URL ?? "http://localhost:3100",
      },
    ]);

    await page.goto("/observatory");

    await expect(
      page.getByRole("heading", { name: "Обсерватория" }),
    ).toBeVisible();
    await expect(page.getByText("Метрики только для чтения")).toBeVisible();
  });
});
