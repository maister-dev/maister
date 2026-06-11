import { readFileSync } from "node:fs";
import path from "node:path";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const MIGRATION_PATH = path.resolve(
  "lib/db/migrations/0045_mcp_supported_agents_mimo.sql",
);
const LEGACY_SUPPORTED_AGENTS = [
  "claude",
  "codex",
  "gemini",
  "opencode",
] as const;
const MIMO_SUPPORTED_AGENTS = [...LEGACY_SUPPORTED_AGENTS, "mimo"] as const;
const CUSTOM_SUPPORTED_AGENTS = ["claude", "codex"] as const;

let container: StartedPostgreSqlContainer;
let pool: Pool;

type PlatformMcpServerRow = {
  id: string;
  supported_agents: string[];
  was_backfilled: boolean;
};

async function createLegacyPlatformMcpServersTable(): Promise<void> {
  await pool.query(`
    CREATE TABLE "platform_mcp_servers" (
      "id" text PRIMARY KEY,
      "supported_agents" jsonb NOT NULL DEFAULT '["claude","codex","gemini","opencode"]'::jsonb,
      "updated_at" timestamp NOT NULL DEFAULT TIMESTAMP '2026-01-01 00:00:00'
    )
  `);
}

async function seedLegacyRows(): Promise<void> {
  await pool.query(`INSERT INTO "platform_mcp_servers" ("id") VALUES ($1)`, [
    "default-row",
  ]);
  await pool.query(
    `INSERT INTO "platform_mcp_servers" ("id", "supported_agents")
     VALUES ($1, $2::jsonb)`,
    ["explicit-old-list", JSON.stringify(LEGACY_SUPPORTED_AGENTS)],
  );
  await pool.query(
    `INSERT INTO "platform_mcp_servers" ("id", "supported_agents")
     VALUES ($1, $2::jsonb)`,
    ["custom-subset", JSON.stringify(CUSTOM_SUPPORTED_AGENTS)],
  );
}

async function applyMigration0045(): Promise<void> {
  await pool.query(readFileSync(MIGRATION_PATH, "utf8"));
}

async function rowsById(): Promise<Map<string, PlatformMcpServerRow>> {
  const result = await pool.query<PlatformMcpServerRow>(`
    SELECT
      "id",
      "supported_agents",
      "updated_at" > TIMESTAMP '2026-01-01 00:00:00' AS "was_backfilled"
    FROM "platform_mcp_servers"
    ORDER BY "id"
  `);

  return new Map(result.rows.map((row) => [row.id, row]));
}

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("maister_test")
    .withUsername("test")
    .withPassword("test")
    .start();

  pool = new Pool({ connectionString: container.getConnectionUri() });
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

describe("migration 0045 — MiMo platform MCP defaults", () => {
  it("backfills only the legacy all-adapter list and leaves custom subsets unchanged", async () => {
    await createLegacyPlatformMcpServersTable();
    await seedLegacyRows();
    await applyMigration0045();
    await pool.query(`INSERT INTO "platform_mcp_servers" ("id") VALUES ($1)`, [
      "new-default",
    ]);

    const rows = await rowsById();

    expect(rows.get("default-row")).toMatchObject({
      supported_agents: [...MIMO_SUPPORTED_AGENTS],
      was_backfilled: true,
    });
    expect(rows.get("explicit-old-list")).toMatchObject({
      supported_agents: [...MIMO_SUPPORTED_AGENTS],
      was_backfilled: true,
    });
    expect(rows.get("custom-subset")).toMatchObject({
      supported_agents: [...CUSTOM_SUPPORTED_AGENTS],
      was_backfilled: false,
    });
    expect(rows.get("new-default")).toMatchObject({
      supported_agents: [...MIMO_SUPPORTED_AGENTS],
      was_backfilled: false,
    });
  });
});
