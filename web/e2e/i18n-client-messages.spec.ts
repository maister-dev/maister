// CMSG-08 (ADR-225, docs/system-analytics/client-messages.md) —
// visits every major route in EN and RU with pruned root client messages,
// asserts zero `MISSING_MESSAGE` console/page errors, and records `/` HTML
// payload bytes as test annotations.
import type { ConsoleMessage, Page } from "@playwright/test";

import { expect, test } from "@playwright/test";

import { loadFixtures } from "./_seed/fixtures";

const EMPTY_STORAGE = { cookies: [], origins: [] };
const LOCALES = ["en", "ru"] as const;

interface MissingMessageHit {
  locale: string;
  route: string;
  source: "console" | "pageerror";
  text: string;
}

function attachMissingMessageWatcher(
  page: Page,
  locale: string,
  currentRoute: () => string,
  hits: MissingMessageHit[],
): void {
  page.on("console", (msg: ConsoleMessage) => {
    const text = msg.text();

    if (text.includes("MISSING_MESSAGE")) {
      hits.push({
        locale,
        route: currentRoute(),
        source: "console",
        text,
      });
    }
  });
  page.on("pageerror", (err: Error) => {
    const text = err.message ?? String(err);

    if (text.includes("MISSING_MESSAGE")) {
      hits.push({
        locale,
        route: currentRoute(),
        source: "pageerror",
        text,
      });
    }
  });
}

async function setLocaleCookie(
  page: Page,
  baseURL: string,
  locale: (typeof LOCALES)[number],
): Promise<void> {
  const url = new URL(baseURL);

  await page.context().addCookies([
    {
      name: "NEXT_LOCALE",
      value: locale,
      domain: url.hostname,
      path: "/",
    },
  ]);
}

test.describe("CMSG-08 root client i18n messages (EN / RU)", () => {
  for (const locale of LOCALES) {
    test(`CMSG-08 no MISSING_MESSAGE across covered routes (${locale})`, async ({
      browser,
      page,
      baseURL,
    }, testInfo) => {
      test.setTimeout(120_000);
      const fixtures = loadFixtures();
      const resolvedBase = baseURL ?? "http://localhost:3100";
      const hits: MissingMessageHit[] = [];
      let routeLabel = "/";

      attachMissingMessageWatcher(page, locale, () => routeLabel, hits);
      await setLocaleCookie(page, resolvedBase, locale);

      // 1. Desk (`/`) + record HTML byte size + open librarian panel
      routeLabel = "/";
      const deskResp = await page.goto("/", { waitUntil: "domcontentloaded" });

      expect(deskResp?.ok()).toBe(true);
      const deskHtmlBytes = (await deskResp!.body()).byteLength;

      testInfo.annotations.push({
        type: `desk-html-bytes-${locale}`,
        description: String(deskHtmlBytes),
      });
      await expect(page.locator("html")).toHaveAttribute("lang", locale);
      await expect(page.getByRole("main").first()).toBeVisible();

      routeLabel = "/ (librarian panel)";
      const librarianTrigger = page.getByTestId("librarian-trigger");

      await expect(librarianTrigger).toBeVisible();
      await librarianTrigger.click();
      await expect(page.getByTestId("librarian-panel")).toBeVisible();
      await page.getByTestId("librarian-close").click();

      // 2. Authenticated app routes
      const authedRoutes = [
        "/inbox",
        `/projects/${fixtures.projectSlug}`,
        `/projects/${fixtures.projectSlug}?tab=settings`,
        `/projects/${fixtures.projectSlug}?tab=webhooks`,
        `/runs/${fixtures.runId}`,
        `/scratch-runs/${fixtures.byKey.m23.scratchRunId}`,
        "/studio",
        "/knowledge",
        "/settings",
        "/specialist-assignments",
        "/account",
        "/account/password",
      ];

      for (const route of authedRoutes) {
        routeLabel = route;
        const resp = await page.goto(route, { waitUntil: "domcontentloaded" });

        expect(resp?.status(), `HTTP status for ${route}`).toBeLessThan(400);
        await expect(page.getByRole("main").first()).toBeVisible({
          timeout: 20_000,
        });
      }

      // 3. Unauthenticated `/login` + forced `/change-password` flow
      const unauthContext = await browser.newContext({
        baseURL: resolvedBase,
        storageState: EMPTY_STORAGE,
      });

      try {
        const unauthPage = await unauthContext.newPage();

        attachMissingMessageWatcher(unauthPage, locale, () => routeLabel, hits);
        await setLocaleCookie(unauthPage, resolvedBase, locale);

        routeLabel = "/login";
        const loginResp = await unauthPage.goto("/login", {
          waitUntil: "domcontentloaded",
        });

        expect(loginResp?.ok()).toBe(true);
        await expect(unauthPage.locator('input[name="email"]')).toBeVisible();

        // Sign in as mustChange user -> redirects to /change-password
        routeLabel = "/change-password";
        await unauthPage
          .locator('input[name="email"]')
          .fill(fixtures.users.mustChange.email);
        await unauthPage
          .locator('input[name="password"]')
          .fill(fixtures.users.mustChange.password);
        await unauthPage.locator('form button[type="submit"]').click();
        await unauthPage.waitForURL("**/change-password", { timeout: 30_000 });
        await expect(unauthPage.getByRole("main")).toBeVisible();
      } finally {
        await unauthContext.close();
      }

      expect(hits, `MISSING_MESSAGE hits in ${locale}`).toEqual([]);
    });
  }
});
