import { NextRequest } from "next/server";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";

import type { Db } from "@/lib/execution-host/db";
import { startMainPostgresTestDb, type StartedPostgresTestDb } from "@/test-support/pg-container";

let database: StartedPostgresTestDb;
let db: Db;
let route: typeof import("@/app/api/admin/platform/workspace-integrity/route");
const sizeEnv = "MAISTER_WORKSPACE_INTEGRITY_MAX_SIZE_MIB";

vi.mock("@/lib/authz", () => ({ requireGlobalRole: async () => ({ id: "settings-admin" }) }));
vi.mock("@/lib/db/client", () => ({ getDb: () => db }));

beforeAll(async () => {
  database = await startMainPostgresTestDb({ databaseName: "workspace_integrity_settings" });
  db = database.db as unknown as Db;
  await database.pool.query(`
    INSERT INTO platform_acp_runners (id, adapter, capability_agent, model, provider)
    VALUES ('integrity', 'codex', 'codex', 'test', '{}');
    INSERT INTO platform_runtime_settings (id, default_runner_id)
    VALUES ('singleton', 'integrity')
  `);
  route = await import("@/app/api/admin/platform/workspace-integrity/route");
}, 120_000);

afterEach(() => vi.unstubAllEnvs());
afterAll(async () => database?.stop());

async function patch(body: unknown): Promise<Response> {
  return route.PATCH(new NextRequest("http://localhost/api/admin/platform/workspace-integrity", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }));
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
  for (const body of [{}, [], { scope: "project" }, { maxSizeMiB: "1" },
    { maxSizeMiB: 0 }, { maxEntries: 500001 }, { maxDurationSeconds: 1.25 }]) {
    expect((await patch(body)).status).toBe(422);
  }

  vi.stubEnv(sizeEnv, "bad");
  const before = (await database.pool.query("SELECT * FROM platform_runtime_settings")).rows;
  const invalid = await patch({ maxSizeMiB: null, maxEntries: 9 });
  expect(invalid.status).toBe(422);
  expect(await invalid.json()).toMatchObject({
    code: "CONFIG", details: { reason: "invalid_environment", field: "maxSizeMiB" },
  });
  expect((await database.pool.query("SELECT * FROM platform_runtime_settings")).rows).toEqual(before);

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
});
