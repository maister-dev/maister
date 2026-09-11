/**
 * `E2E-NTF` — the push opt-in flow, a delivered notification, and revocation
 * (ADR-172).
 *
 * Chromium's real service worker registers and the real
 * `POST /api/push/subscribe` stores the endpoint. What a test cannot have is a
 * push service, so the endpoint this suite registers is SYNTHETIC
 * (`push.e2e.invalid`) and `pushManager.subscribe()` is never reached — see the
 * note above the opt-in test. "A delivered notification" is therefore asserted
 * where the sender actually reaches it, the delivery ledger, by
 * `IT-NTF-04`/`IT-NTF-05`. The VAPID variables in `playwright.config.ts` are
 * placeholders whose only job is to be PRESENT, so the subscribe route stops
 * answering CONFIG.
 *
 * Chromium needs no permission prompt under Playwright: the context is granted
 * `notifications` up front, which is what a reader clicking "Allow" produces.
 */

import type { Browser, Page } from "@playwright/test";

import { test, expect } from "@playwright/test";

import { loadFixtures, type E2EUserFixture } from "./_seed/fixtures";

const EMPTY_STORAGE = { cookies: [], origins: [] };

async function signIn(
  browser: Browser,
  user: Pick<E2EUserFixture, "email" | "password">,
): Promise<Page> {
  const context = await browser.newContext({
    storageState: EMPTY_STORAGE,
    // What "Allow" produces. Without it `Notification.requestPermission()`
    // resolves `default` under automation and the opt-in silently no-ops.
    permissions: ["notifications"],
  });
  const page = await context.newPage();

  await page.goto("/login");
  await page.locator('input[name="email"]').fill(user.email);
  await page.locator('input[name="password"]').fill(user.password);
  await page.locator('form button[type="submit"]').click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), {
    timeout: 60_000,
  });

  return page;
}

test("the service worker is served at / with the scope-widening header", async ({
  page,
}) => {
  const response = await page.goto("/sw.js");

  expect(response?.status()).toBe(200);
  expect(response?.headers()["content-type"]).toContain("text/javascript");
  // T7.3: the header is asserted here, and the REGISTERED SCOPE below — a header
  // alone does not prove the browser honoured it.
  expect(response?.headers()["service-worker-allowed"]).toBe("/");

  const body = await response?.text();

  expect(body).toContain('self.addEventListener("push"');
  expect(body).toContain("showNotification");
});

test("E2E-NTF the worker registers at scope / in a real browser", async ({
  page,
}) => {
  await page.goto("/");

  const scope = await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.register("/sw.js");

    await navigator.serviceWorker.ready;

    return registration.scope;
  });

  // The claim T7.3 makes: scope is the whole origin, not `/sw.js`'s directory.
  expect(new URL(scope).pathname).toBe("/");
});

/**
 * The OPT-IN ROUND TRIP, asserted at the boundary this environment can actually
 * reach.
 *
 * Two things are out of reach here and are covered elsewhere rather than faked:
 *
 *   - `pushManager.subscribe()` cannot complete. Headless Chromium has no
 *     connection to a push service, so the real call never resolves (the first
 *     cut of this test timed out at exactly that line), and stubbing
 *     `navigator.serviceWorker` is not possible either — the property is not
 *     configurable, and redefining it breaks hydration before the panel renders.
 *   - An actually-delivered push needs a push service. The DELIVERY ledger —
 *     intent before send, `delivered_at` after, 410 deleting the endpoint — is
 *     owned by `IT-NTF-04` / `IT-NTF-05`, against a real database.
 *
 * What IS real here: the session-authenticated POST and DELETE, the owner coming
 * from `auth-context`, the opaque storage, and the account page reading the
 * stored endpoints back.
 */
test("E2E-NTF opt in stores the endpoint for the session user, and revoking removes it", async ({
  browser,
}) => {
  const fx = loadFixtures().byKey.activityFeed;
  const page = await signIn(browser, fx.member);

  try {
    await page.goto("/account");
    await expect(page.getByTestId("notifications-panel")).toBeVisible();

    const endpoints = [
      `https://push.e2e.invalid/${Date.now()}-a`,
      `https://push.e2e.invalid/${Date.now()}-b`,
    ];

    const created = await page.evaluate(async (urls: string[]) => {
      const out: number[] = [];

      for (const endpoint of urls) {
        const response = await fetch("/api/push/subscribe", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            endpoint,
            keys: { p256dh: "e2e-p256dh", auth: "e2e-auth" },
          }),
        });

        out.push(response.status);
      }

      return out;
    }, endpoints);

    expect(created).toEqual([201, 201]);

    // The page reads the stored endpoints back: two browsers registered means
    // one "other" besides this one.
    await page.reload();
    await expect(page.getByTestId("notifications-panel")).toContainText(
      "1 other browser",
    );

    // Re-registering the same endpoint is idempotent, not cumulative.
    const again = await page.evaluate(async (endpoint: string) => {
      const response = await fetch("/api/push/subscribe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          endpoint,
          keys: { p256dh: "rotated", auth: "rotated" },
        }),
      });

      return response.status;
    }, endpoints[0]);

    expect(again).toBe(201);
    await page.reload();
    await expect(page.getByTestId("notifications-panel")).toContainText(
      "1 other browser",
    );

    // REVOKE both.
    const removed = await page.evaluate(async (urls: string[]) => {
      const out: number[] = [];

      for (const endpoint of urls) {
        const response = await fetch("/api/push/subscribe", {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ endpoint }),
        });

        out.push(response.status);
      }

      return out;
    }, endpoints);

    expect(removed).toEqual([204, 204]);
    await page.reload();
    await expect(page.getByTestId("notifications-panel")).not.toContainText(
      "other browser",
    );
  } finally {
    await page.context().close();
  }
});

test("E2E-NTF the subscribe route refuses a body naming an owner", async ({
  page,
}) => {
  // ADR-172 D9 at the wire: the owner is `auth-context` only. The strict zod
  // schema refuses the extra key rather than ignoring it.
  await page.goto("/account");

  const result = await page.evaluate(async () => {
    const response = await fetch("/api/push/subscribe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ownerUserId: "somebody-else",
        endpoint: "https://push.example.invalid/e2e",
        keys: { p256dh: "k", auth: "a" },
      }),
    });

    return { status: response.status, code: (await response.json()).code };
  });

  expect(result.status).toBe(400);
  expect(result.code).toBe("PRECONDITION");
});

test("E2E-NTF a member sees their own panel and no one else's subscriptions", async ({
  browser,
}) => {
  const fx = loadFixtures().byKey.activityFeed;
  const page = await signIn(browser, fx.member);

  try {
    await page.goto("/account");
    await expect(page.getByTestId("notifications-panel")).toBeVisible();

    // The panel is per-reader: it never names another account's browsers.
    await expect(page.getByTestId("notifications-panel")).not.toContainText(
      "other browser",
    );
  } finally {
    await page.context().close();
  }
});
