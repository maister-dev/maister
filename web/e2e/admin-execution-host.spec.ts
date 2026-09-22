import type { Browser, Page } from "@playwright/test";

import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import { withE2EDb } from "./_seed/db";
import { loadFixtures, type E2EUserFixture } from "./_seed/fixtures";

const EMPTY_STORAGE = { cookies: [], origins: [] };

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
    });
  }
});

test("authenticated member receives an HTTP 403 with no platform diagnostics", async ({
  browser,
}) => {
  test.slow();
  const page = await loginAs(browser, loadFixtures().users.memberCandidate);

  try {
    const response = await page.goto("/admin/execution-host");

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
    const denied = await page.goto("/admin/execution-host");

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
