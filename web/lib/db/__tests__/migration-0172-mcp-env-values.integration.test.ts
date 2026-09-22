import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  applyMainMigration,
  startMainPostgresTestDbUpTo,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

// ADR-179 migration `0172_mcp_env_values`: the platform name-list columns and
// the THREE legacy `capability_records.material` shapes collapse into ONE map
// shape. Seeded on the pre-migration schema and replayed, because a backfill
// asserted only against post-migration writers proves nothing.
//
// The trap this pins (C9): `env_keys` rows hold BOTH spellings — `GITHUB_TOKEN`
// and `env:GITHUB_TOKEN` — because the old key regex accepted both. A backfill
// that does not strip turns `env:X` into the map KEY `env:X`, which no server
// reads.

type Db = NodePgDatabase;

let testDatabase: StartedPostgresTestDb;
let db: Db;

const WITH_KEYS = "srv-with-keys";
const EMPTY_KEYS = "srv-empty-keys";

const PROJECT_ROW = randomUUID();
const PLATFORM_YAML_ROW = randomUUID();
const PACKAGE_REQUIREMENT_ROW = randomUUID();
const PACKAGE_TEMPLATE_ROW = randomUUID();
const BINDING_ROW = randomUUID();

let projectId: string;

async function one<T extends Record<string, unknown>>(
  query: ReturnType<typeof sql>,
): Promise<T> {
  const result = await db.execute(query);

  expect(result.rows).toHaveLength(1);

  return result.rows[0] as T;
}

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDbUpTo(
    { databaseName: "maister_migration_0172_test" },
    "0171_crash_recover_continuation_retry",
  );
  db = testDatabase.db;

  projectId = randomUUID();
  await db.execute(sql`
    INSERT INTO projects (id, slug, name, repo_path, task_key)
    VALUES (${projectId}, 'mig-0172', 'mig-0172', '/tmp/mig-0172', 'MIG0172')
  `);

  // Both stored key spellings, on both sides.
  await db.execute(sql`
    INSERT INTO platform_mcp_servers (id, transport, command, env_keys, header_keys)
    VALUES (
      ${WITH_KEYS}, 'stdio', 'github-mcp',
      ${JSON.stringify(["env:GITHUB_TOKEN", "GH_HOST"])}::jsonb,
      ${JSON.stringify(["env:MCP_AUTH"])}::jsonb
    )
  `);
  await db.execute(sql`
    INSERT INTO platform_mcp_servers (id, transport, command, env_keys, header_keys)
    VALUES (${EMPTY_KEYS}, 'stdio', 'noop', '[]'::jsonb, '[]'::jsonb)
  `);

  // The three legacy material shapes (C10), plus a package template that
  // already stores a map and must survive untouched.
  const materials: Array<[string, string, Record<string, unknown>]> = [
    [
      PROJECT_ROW,
      "proj-mcp",
      {
        origin: "project-mcp",
        transport: "stdio",
        command: "proj-mcp",
        args: [],
        envKeys: ["env:PROJ_TOKEN", "PROJ_HOST"],
        url: null,
        headerKeys: [],
        supportedAgents: ["claude"],
      },
    ],
    [
      PLATFORM_YAML_ROW,
      "yaml-mcp",
      {
        transport: "http",
        command: null,
        args: [],
        envKeys: [],
        url: "https://mcp.example.com/v1",
        headerKeys: ["YAML_AUTH"],
      },
    ],
    [
      PACKAGE_REQUIREMENT_ROW,
      "pkg-req",
      {
        origin: "package-attachment",
        requirement: true,
        envKeys: ["REQ_TOKEN"],
      },
    ],
    [
      PACKAGE_TEMPLATE_ROW,
      "pkg-tpl",
      {
        origin: "package-attachment",
        transport: "stdio",
        command: "tpl",
        args: [],
        env: { A: "env:A", LITERAL: "keep-me" },
      },
    ],
  ];

  for (const [rowId, refId, material] of materials) {
    await db.execute(sql`
      INSERT INTO capability_records (id, project_id, kind, capability_ref_id, label, agents, source, material)
      VALUES (${rowId}, ${projectId}, 'mcp', ${refId}, ${refId}, '["claude"]'::jsonb, 'project', ${JSON.stringify(material)}::jsonb)
    `);
  }

  await db.execute(sql`
    INSERT INTO project_mcp_bindings (id, project_id, ref_id, target_kind, target_id, config_overlay)
    VALUES (
      ${BINDING_ROW}, ${projectId}, 'github', 'platform', ${WITH_KEYS},
      ${JSON.stringify({ envRemap: { GITHUB_TOKEN: "env:PROJ_A_GH" } })}::jsonb
    )
  `);

  await applyMainMigration(db, "0172_mcp_env_values");
}, 300_000);

afterAll(async () => {
  await testDatabase?.stop();
});

describe("migration 0172_mcp_env_values", () => {
  it("backfills both stored key spellings into env:NAME maps", async () => {
    const row = await one<{
      env: Record<string, string>;
      headers: Record<string, string>;
      bearer_token_env: string | null;
      description: string | null;
    }>(sql`
      SELECT env, headers, bearer_token_env, description
      FROM platform_mcp_servers WHERE id = ${WITH_KEYS}
    `);

    expect(row.env).toEqual({
      GITHUB_TOKEN: "env:GITHUB_TOKEN",
      GH_HOST: "env:GH_HOST",
    });
    expect(row.headers).toEqual({ MCP_AUTH: "env:MCP_AUTH" });
    expect(row.bearer_token_env).toBeNull();
    expect(row.description).toBeNull();
  });

  it("turns empty name lists into empty maps, not nulls", async () => {
    const row = await one<{
      env: Record<string, string>;
      headers: Record<string, string>;
    }>(sql`
      SELECT env, headers FROM platform_mcp_servers WHERE id = ${EMPTY_KEYS}
    `);

    expect(row.env).toEqual({});
    expect(row.headers).toEqual({});
  });

  it("drops the two pre-ADR-179 name-list columns", async () => {
    const result = await db.execute(sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'platform_mcp_servers'
        AND column_name IN ('env_keys', 'header_keys')
    `);

    expect(result.rows).toHaveLength(0);
  });

  it("rewrites all three legacy material shapes to one map shape", async () => {
    const rows = await db.execute(sql`
      SELECT id, material FROM capability_records WHERE project_id = ${projectId}
    `);
    const byId = new Map(
      (
        rows.rows as Array<{ id: string; material: Record<string, unknown> }>
      ).map((r) => [r.id, r.material]),
    );

    for (const [rowId, material] of byId) {
      expect(material, rowId).not.toHaveProperty("envKeys");
      expect(material, rowId).not.toHaveProperty("headerKeys");
    }

    expect(byId.get(PROJECT_ROW)).toMatchObject({
      env: { PROJ_TOKEN: "env:PROJ_TOKEN", PROJ_HOST: "env:PROJ_HOST" },
      headers: {},
      // Untouched fields survive the rewrite.
      origin: "project-mcp",
      command: "proj-mcp",
    });

    expect(byId.get(PLATFORM_YAML_ROW)).toMatchObject({
      env: {},
      headers: { YAML_AUTH: "env:YAML_AUTH" },
      url: "https://mcp.example.com/v1",
    });

    // C10: a requirement row's declared slots become the KEYS of `env`, which
    // is what `resolveBindTarget` reads — the defect closes by construction.
    expect(byId.get(PACKAGE_REQUIREMENT_ROW)).toMatchObject({
      env: { REQ_TOKEN: "env:REQ_TOKEN" },
      headers: {},
      requirement: true,
    });
  });

  it("leaves a template row's declared VALUES untouched", async () => {
    const row = await one<{ material: Record<string, unknown> }>(sql`
      SELECT material FROM capability_records WHERE id = ${PACKAGE_TEMPLATE_ROW}
    `);

    expect(row.material).toMatchObject({
      env: { A: "env:A", LITERAL: "keep-me" },
      headers: {},
    });
  });

  it("leaves overlay rows byte-identical — the keys never changed", async () => {
    const row = await one<{ config_overlay: Record<string, unknown> }>(sql`
      SELECT config_overlay FROM project_mcp_bindings WHERE id = ${BINDING_ROW}
    `);

    // A stored {GITHUB_TOKEN: "env:PROJ_A_GH"} now MEANS what the operator
    // meant: use PROJ_A_GH as the value of the key GITHUB_TOKEN.
    expect(row.config_overlay).toEqual({
      envRemap: { GITHUB_TOKEN: "env:PROJ_A_GH" },
    });
  });
});
