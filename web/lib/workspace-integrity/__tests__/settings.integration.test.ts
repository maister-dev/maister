import {
  integritySettingsPageView,
  readIntegrityCheckSettings,
} from "@/lib/workspace-integrity/settings";
import { seedWorkspaceIntegritySettings } from "@/test-support/workspace-integrity-settings";
import { NextRequest } from "next/server";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";

import type { Db } from "@/lib/execution-host/db";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

let database: StartedPostgresTestDb;
let db: Db;
let route: typeof import("@/app/api/admin/platform/workspace-integrity/route");
const sizeEnv = "MAISTER_WORKSPACE_INTEGRITY_MAX_SIZE_MIB";

vi.mock("@/lib/authz", () => ({
  requireGlobalRole: async () => ({ id: "settings-admin" }),
}));
vi.mock("@/lib/db/client", () => ({ getDb: () => db }));

beforeAll(async () => {
  database = await startMainPostgresTestDb({
    databaseName: "workspace_integrity_settings",
  });
  db = database.db as unknown as Db;
  await seedWorkspaceIntegritySettings(database);
  route = await import("@/app/api/admin/platform/workspace-integrity/route");
}, 120_000);

afterEach(() => vi.unstubAllEnvs());
afterAll(async () => database?.stop());

async function patch(body: unknown): Promise<Response> {
  return route.PATCH(
    new NextRequest("http://localhost/api/admin/platform/workspace-integrity", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

it("WI-02 resolves independent sources, validates, commits and resets atomically", async () => {
  vi.stubEnv(sizeEnv, "512");
  expect(await (await route.GET()).json()).toEqual({
    maxSizeMiB: { value: 512, source: "environment" },
    maxDurationSeconds: { value: 120, source: "default" },
    maxEntries: { value: 100000, source: "default" },
  });
  const saved = await patch({ maxSizeMiB: 1024, maxEntries: 25000 });
  expect(saved.status).toBe(200);
  expect(saved.headers.get("cache-control")).toBe("private, no-store");
  expect(await saved.json()).toMatchObject({
    maxSizeMiB: { value: 1024, source: "platform" },
    maxEntries: { value: 25000, source: "platform" },
  });
  for (const body of [
    {},
    [],
    { scope: "project" },
    { maxSizeMiB: "1" },
    { maxSizeMiB: 0 },
    { maxEntries: 500001 },
    { maxDurationSeconds: 1.25 },
  ]) {
    expect((await patch(body)).status).toBe(422);
  }

  vi.stubEnv(sizeEnv, "bad");
  const before = (
    await database.pool.query("SELECT * FROM platform_runtime_settings")
  ).rows;
  const invalid = await patch({ maxSizeMiB: null, maxEntries: 9 });
  expect(invalid.status).toBe(422);
  expect(await invalid.json()).toMatchObject({
    code: "CONFIG",
    details: { reason: "invalid_environment", field: "maxSizeMiB" },
  });
  expect(
    (await database.pool.query("SELECT * FROM platform_runtime_settings")).rows,
  ).toEqual(before);

  vi.stubEnv(sizeEnv, "512");
  const edits = await Promise.all([
    patch({ maxSizeMiB: null }),
    patch({ maxDurationSeconds: 44 }),
  ]);
  expect(edits.map((response) => response.status)).toEqual([200, 200]);
  expect(await (await route.GET()).json()).toEqual({
    maxSizeMiB: { value: 512, source: "environment" },
    maxDurationSeconds: { value: 44, source: "platform" },
    maxEntries: { value: 25000, source: "platform" },
  });
  vi.stubEnv(sizeEnv, "bad");
  expect((await route.GET()).status).toBe(422);
  expect(
    integritySettingsPageView({
      maxSizeMiB: null,
      maxDurationSeconds: 44,
      maxEntries: 25000,
    }),
  ).toMatchObject({
    invalidFields: ["maxSizeMiB"],
    settings: {
      maxDurationSeconds: { value: 44, source: "platform" },
      maxEntries: { value: 25000, source: "platform" },
    },
  });
  const repaired = await patch({ maxSizeMiB: 2 });
  expect(repaired.status).toBe(200);
  expect(await repaired.json()).toMatchObject({
    maxSizeMiB: { value: 2, source: "platform" },
  });
});

it("WI-02 rejects admin reads and mutations before singleton bootstrap", async () => {
  await database.pool.query(
    "DELETE FROM platform_runtime_settings WHERE id='singleton'",
  );

  try {
    const missing = await route.GET();
    expect(missing.status).toBe(422);
    expect(await missing.json()).toMatchObject({
      code: "CONFIG",
      details: { reason: "settings_missing" },
    });
    expect((await patch({ maxEntries: 90000 })).status).toBe(422);
    expect(await readIntegrityCheckSettings(db)).toMatchObject({
      maxEntries: { value: 100000, source: "default" },
    });
  } finally {
    await seedWorkspaceIntegritySettings(database);
  }
});

it("WI-02 commits same-field changes in PostgreSQL row-lock order", async () => {
  const connection = await database.pool.connect();
  const waiting = async (): Promise<number> => {
    const { rows } = await database.pool.query<{ count: number }>(`
      SELECT count(*)::int AS count FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock'
        AND query LIKE 'update "platform_runtime_settings"%'
    `);
    return rows[0].count;
  };
  const updates: Promise<Response>[] = [];
  let committed = false;
  try {
    await connection.query("BEGIN");
    await connection.query(
      "SELECT id FROM platform_runtime_settings WHERE id='singleton' FOR UPDATE",
    );
    updates.push(patch({ maxEntries: 41 }));
    await expect.poll(waiting).toBe(1);
    updates.push(patch({ maxEntries: 42 }));
    await expect.poll(waiting).toBe(2);
    await connection.query("COMMIT");
    committed = true;
    const responses = await Promise.all(updates);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(await (await route.GET()).json()).toMatchObject({
      maxEntries: { value: 42, source: "platform" },
    });
  } finally {
    if (!committed) await connection.query("ROLLBACK");
    connection.release();
    await Promise.allSettled(updates);
  }
});

it("WI-02 reports transient storage failure and preserves the committed row", async () => {
  expect((await patch({ maxEntries: 5000 })).status).toBe(200);
  const connection = await database.pool.connect();
  let pending: Promise<Response> | undefined;
  try {
    await connection.query("BEGIN");
    await connection.query(
      "SELECT id FROM platform_runtime_settings WHERE id='singleton' FOR UPDATE",
    );
    pending = patch({ maxEntries: 90000 });
    await expect
      .poll(async () => {
        const { rows } = await database.pool.query<{ cancelled: boolean }>(`
        SELECT pg_cancel_backend(pid) AS cancelled FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'
          AND query LIKE 'update "platform_runtime_settings"%'
      `);
        return rows.some(({ cancelled }) => cancelled);
      })
      .toBe(true);
    const refused = await pending;
    expect(refused.status).toBe(503);
    expect(await refused.json()).toMatchObject({
      code: "EXECUTOR_UNAVAILABLE",
    });
    expect(await (await route.GET()).json()).toMatchObject({
      maxEntries: { value: 5000, source: "platform" },
    });
  } finally {
    await connection.query("ROLLBACK");
    connection.release();
    await pending;
  }
});
