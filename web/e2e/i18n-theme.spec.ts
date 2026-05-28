import { test, expect } from "@playwright/test";

test.describe("i18n and theming", () => {
  test("theme toggle persists across page reload", async ({ page }) => {
    await page.goto("/login");

    const htmlElement = page.locator("html");
    const initialClass = await htmlElement.getAttribute("class");

    const themeToggle = page.locator('button[aria-label*="theme" i]');

    if (await themeToggle.isVisible()) {
      await themeToggle.click();

      await page.waitForTimeout(500);

      const afterToggleClass = await htmlElement.getAttribute("class");

      expect(afterToggleClass).not.toBe(initialClass);

      await page.reload();

      const afterReloadClass = await htmlElement.getAttribute("class");

      expect(afterReloadClass).toBe(afterToggleClass);
    }
  });

  test("language toggle switches visible copy", async ({ page }) => {
    await page.goto("/login");

    const localeToggle = page.locator('button[aria-label*="language" i]');

    if (await localeToggle.isVisible()) {
      const initialContent = await page.content();

      await localeToggle.click();

      await page.waitForTimeout(500);

      const afterToggleContent = await page.content();

      expect(afterToggleContent).not.toBe(initialContent);
    }
  });

  test("locale preference persists in NEXT_LOCALE cookie", async ({
    page,
    context,
  }) => {
    await page.goto("/login");

    const localeToggle = page.locator('button[aria-label*="language" i]');

    if (await localeToggle.isVisible()) {
      await localeToggle.click();

      await page.waitForTimeout(500);

      const cookies = await context.cookies();
      const localeCookie = cookies.find((c) => c.name === "NEXT_LOCALE");

      expect(localeCookie).toBeDefined();
      expect(localeCookie?.value).toBeTruthy();

      await page.reload();

      const newCookies = await context.cookies();
      const newLocaleCookie = newCookies.find((c) => c.name === "NEXT_LOCALE");

      expect(newLocaleCookie?.value).toBe(localeCookie?.value);
    }
  });
});
