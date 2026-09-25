import type { Browser, Page, Response } from "@playwright/test";

import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import { withE2EDb } from "./_seed/db";
import { loadFixtures, type E2EUserFixture } from "./_seed/fixtures";

const EMPTY_STORAGE = { cookies: [], origins: [] };

// The admin refusal is served by a middleware REWRITE carrying status 403
// (`proxy.ts`). Chromium intermittently reports the navigation that PRODUCES
// such a document — and the one that LEAVES it — as net::ERR_ABORTED even
// though the response arrived, so a bare `goto` around this seam is flaky in
// both directions. Retry once; a genuine refusal failure still surfaces on the
// status assertion that follows.
async function gotoAcrossRewrite(
  page: Page,
  path: string,
): Promise<Response | null> {
  try {
    return await page.goto(path);
  } catch (error) {
    if (!String(error).includes("ERR_ABORTED")) throw error;

    return await page.goto(path);
  }
}

async function loginAs(browser: Browser, user: E2EUserFixture): Promise<Page> {
  const context = await browser.newContext({ storageState: EMPTY_STORAGE });
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

test("admin sees event-plane diagnostics, repair evidence, and both rail links", async ({
  page,
  context,
}) => {
  const runId = loadFixtures().runId;
  const eventId = randomUUID();
  const generation = randomUUID();
  const consumer = `e2e_projection_poison_${randomUUID()}`;
  // ADR-167 amendment 2026-09-25: a stream row of the spec's own (retired)
  // host, so the stream panel renders the subscriber pause/close cells.
  const streamHostId = randomUUID();

  await withE2EDb(async (pool) => {
    const client = await pool.connect();

    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [runId]);
      await client.query(
        `INSERT INTO execution_events (
           id, source, source_key, run_id, event_type, payload_schema,
           occurred_at, received_at, run_sequence, ingest_disposition
         )
         SELECT $1, 'manager', $2, $3, 'session.update', 'maister.e2e.v1',
                clock_timestamp(), clock_timestamp(),
                COALESCE(MAX(run_sequence), -1) + 1, 'accepted'
         FROM execution_events
         WHERE run_id = $3`,
        [eventId, `admin-lag-${eventId}`, runId],
      );
      await client.query(
        `INSERT INTO execution_event_consumers (
           consumer_name, run_id, last_run_sequence, state, poison_event_id,
           last_error, last_served_at
         ) VALUES ($1, $2, NULL, 'poisoned', $3, $4::jsonb, clock_timestamp())`,
        [
          consumer,
          runId,
          eventId,
          JSON.stringify({
            eventId,
            errorGeneration: generation,
            reason: "e2e_projection_failure",
          }),
        ],
      );
      await client.query(
        `INSERT INTO execution_hosts (id, host_key, kind, display_name, transport, retired_at)
         VALUES ($1, $2, 'local_direct', 'e2e stream host', '{"kind":"local_direct"}', clock_timestamp())`,
        [streamHostId, `eh_${streamHostId.replaceAll("-", "")}`],
      );
      await client.query(
        `INSERT INTO execution_event_streams (id, execution_host_id, stream_id, state)
         VALUES ($1, $2, $3, 'closed')`,
        [randomUUID(), streamHostId, randomUUID()],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });

  try {
    await page.goto("/admin/execution-host");
    await expect(
      page.getByRole("heading", { name: "Execution host", level: 1 }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Event streams" }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Projection consumers" }),
    ).toBeVisible();
    await expect(page.getByText("e2e_projection_failure")).toBeVisible();
    // The e2e supervisor reports no stream telemetry, so the cells read as
    // missing — never as a fabricated zero.
    await expect(page.getByText("pauses: unavailable").first()).toBeVisible();
    await expect(page.getByText("closes: unavailable").first()).toBeVisible();
    await expect(
      page.getByText(
        `pnpm --filter maister-web execution:projection:rearm --consumer '${consumer}' --run '${runId}' --event '${eventId}' --cursor 'null' --error-generation '${generation}'`,
        { exact: true },
      ),
    ).toBeVisible();

    await expect(page.getByTestId("rail-nav-executionHost")).toHaveAttribute(
      "href",
      "/admin/execution-host",
    );
    await page.getByTestId("rail-collapse-toggle").click();
    await expect(
      page.getByTestId("rail-platform-status-collapsed"),
    ).toHaveAttribute("href", "/admin/execution-host");

    await context.addCookies([
      {
        name: "NEXT_LOCALE",
        value: "ru",
        url: page.url(),
      },
    ]);
    await page.reload();
    await expect(
      page.getByRole("heading", { name: "Хост исполнения", level: 1 }),
    ).toBeVisible();
    await expect(page.getByText("паузы: недоступно").first()).toBeVisible();
    await expect(page.getByText("закрытия: недоступно").first()).toBeVisible();

    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByTestId("mobile-rail-toggle").click();
    await expect(
      page
        .getByTestId("mobile-rail-drawer")
        .getByTestId("rail-nav-executionHost"),
    ).toHaveAttribute("href", "/admin/execution-host");
  } finally {
    await withE2EDb(async (pool) => {
      await pool.query(
        "DELETE FROM execution_event_consumers WHERE consumer_name = $1 AND run_id = $2",
        [consumer, runId],
      );
      await pool.query("DELETE FROM execution_events WHERE id = $1", [eventId]);
      await pool.query(
        "DELETE FROM execution_event_streams WHERE execution_host_id = $1",
        [streamHostId],
      );
      await pool.query("DELETE FROM execution_hosts WHERE id = $1", [
        streamHostId,
      ]);
    });
  }
});

test("authenticated member receives an HTTP 403 with no platform diagnostics", async ({
  browser,
}) => {
  test.slow();
  const page = await loginAs(browser, loadFixtures().users.memberCandidate);

  try {
    // D6 negative FIRST: a member DOES get the coarse platform summary, and it
    // is never a link into the diagnostics page — in either rail state. Asserted
    // before the refusal so the test never navigates off the rewritten document.
    await page.goto("/");
    await expect(page.getByTestId("rail-nav-executionHost")).toHaveCount(0);
    await expect(
      page.getByTestId("rail-platform-status").first(),
    ).toBeVisible();
    await expect(page.getByTestId("rail-platform-status-link")).toHaveCount(0);

    await page.getByTestId("rail-collapse-toggle").click();
    const collapsed = page.getByTestId("rail-platform-status-collapsed");

    await expect(collapsed).toBeVisible();
    await expect(collapsed).not.toHaveAttribute("href", /.*/);

    const response = await gotoAcrossRewrite(page, "/admin/execution-host");

    expect(response?.status()).toBe(403);
    await expect(
      page.getByRole("heading", { name: "Admin access required" }),
    ).toBeVisible();
    await expect(page.getByRole("heading", { name: "Hosts" })).toHaveCount(0);
  } finally {
    await page.context().close();
  }
});

test("a live-demoted admin session loses access before diagnostic reads", async ({
  browser,
}) => {
  test.slow();
  const fixture = loadFixtures().users.memberCandidate;
  const userId = randomUUID();
  const user = {
    id: userId,
    email: `execution-host-demotion-${userId}@example.test`,
    name: "Execution Host Demotion",
    password: fixture.password,
  };

  await withE2EDb(async (pool) => {
    await pool.query(
      `INSERT INTO users (
         id, name, email, password_hash, role, account_status,
         must_change_password
       )
       SELECT $1, $2, $3, password_hash, 'admin', 'active', false
       FROM users
       WHERE id = $4`,
      [user.id, user.name, user.email, fixture.id],
    );
  });
  const page = await loginAs(browser, user);

  try {
    const allowed = await page.goto("/admin/execution-host");

    expect(allowed?.status()).toBe(200);
    await expect(
      page.getByRole("heading", { name: "Execution host", level: 1 }),
    ).toBeVisible();

    await withE2EDb(async (pool) => {
      await pool.query("UPDATE users SET role = 'member' WHERE id = $1", [
        user.id,
      ]);
    });
    const denied = await gotoAcrossRewrite(page, "/admin/execution-host");

    expect(denied?.status()).toBe(403);
    await expect(
      page.getByRole("heading", { name: "Admin access required" }),
    ).toBeVisible();
    await expect(page.getByRole("heading", { name: "Hosts" })).toHaveCount(0);
  } finally {
    await page.context().close();
    await withE2EDb(async (pool) => {
      await pool.query("DELETE FROM users WHERE id = $1", [user.id]);
    });
  }
});
