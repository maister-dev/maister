import { test, expect } from "@playwright/test";

test.describe("i18n and theming", () => {
  test("theme toggle persists across page reload", async ({
    page,
    context,
    baseURL,
  }) => {
    await context.addCookies([{ name: "theme", value: "dark", url: baseURL! }]);
    await page.goto("/login");

    const html = page.locator("html");

    await expect(html).toHaveClass(/\bdark\b/);
    await page.getByRole("button", { name: "Switch to light mode" }).click();
    await expect(html).toHaveClass(/\blight\b/);
    await expect
      .poll(
        async () =>
          (await context.cookies()).find(({ name }) => name === "theme")?.value,
      )
      .toBe("light");

    await page.reload();

    await expect(html).toHaveClass(/\blight\b/);
    await expect(
      page.getByRole("button", { name: "Switch to dark mode" }),
    ).toBeVisible();
  });

  test("language toggle changes the login copy and persists across reload", async ({
    page,
    context,
    baseURL,
  }) => {
    await context.addCookies([
      { name: "NEXT_LOCALE", value: "en", url: baseURL! },
    ]);
    await page.goto("/login");
    await expect(
      page.getByRole("heading", { name: "Sign in.", exact: true }),
    ).toBeVisible();

    await page.getByRole("button", { name: "Switch language to RU" }).click();

    await expect(
      page.getByRole("heading", { name: "Вход.", exact: true }),
    ).toBeVisible();
    expect(
      (await context.cookies()).find(({ name }) => name === "NEXT_LOCALE")
        ?.value,
    ).toBe("ru");

    await page.reload();

    await expect(
      page.getByRole("heading", { name: "Вход.", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Switch language to EN" }),
    ).toBeVisible();
  });
});
