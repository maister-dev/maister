import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

type Db = NodePgDatabase;

type ColumnRow = {
  table_name: string;
  column_name: string;
  is_nullable: "YES" | "NO";
  column_default: string | null;
  data_type: string;
};

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: Db;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("maister_migration_0093_test")
    .withUsername("test")
    .withPassword("test")
    .start();

  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);

  await migrate(db, { migrationsFolder: "./lib/db/migrations" });
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

function id(): string {
  return randomUUID();
}

async function seedProject(): Promise<string> {
  const projectId = id();
  await db.execute(sql`
    INSERT INTO projects (id, slug, name, repo_path, task_key)
    VALUES (
      ${projectId},
      ${`proj-${projectId.slice(0, 8)}`},
      'MCP v2 project',
      ${`/tmp/proj-${projectId.slice(0, 8)}`},
      ${`T${projectId.slice(0, 8)}`.toUpperCase()}
    )
  `);

  return projectId;
}

async function seedPlatformMcp(args: {
  serverId: string;
  enabled: boolean;
  trustStatus: string;
}): Promise<void> {
  await db.execute(sql`
    INSERT INTO platform_mcp_servers (id, transport, enabled, trust_status)
    VALUES (${args.serverId}, 'stdio', ${args.enabled}, ${args.trustStatus})
  `);
}

describe("migration 0093 — MCP management v2 (ADR-129)", () => {
  it("adds project_mcp_bindings, platform probe columns, and runs.withheld_mcps with the documented shape", async () => {
    const columns = await db.execute<ColumnRow>(sql`
      SELECT table_name, column_name, is_nullable, column_default, data_type
      FROM information_schema.columns
      WHERE table_name IN ('project_mcp_bindings', 'platform_mcp_servers', 'runs')
      ORDER BY table_name, ordinal_position
    `);
    const byKey = new Map(
      columns.rows.map((row) => [`${row.table_name}.${row.column_name}`, row]),
    );

    // project_mcp_bindings columns + nullability + defaults
    expect(byKey.get("project_mcp_bindings.id")?.is_nullable).toBe("NO");
    expect(byKey.get("project_mcp_bindings.project_id")?.is_nullable).toBe("NO");
    expect(byKey.get("project_mcp_bindings.ref_id")?.is_nullable).toBe("NO");
    expect(byKey.get("project_mcp_bindings.target_kind")?.is_nullable).toBe(
      "NO",
    );
    expect(byKey.get("project_mcp_bindings.target_id")?.is_nullable).toBe("NO");
    expect(byKey.get("project_mcp_bindings.enabled")?.column_default).toContain(
      "true",
    );
    expect(byKey.get("project_mcp_bindings.config_overlay")?.data_type).toBe(
      "jsonb",
    );
    expect(byKey.get("project_mcp_bindings.recommended_hint")?.is_nullable).toBe(
      "YES",
    );
    expect(byKey.get("project_mcp_bindings.created_by")?.is_nullable).toBe(
      "YES",
    );

    // platform probe columns are all nullable
    expect(byKey.get("platform_mcp_servers.last_probe_status")?.is_nullable).toBe(
      "YES",
    );
    expect(byKey.get("platform_mcp_servers.last_probe_at")?.data_type).toBe(
      "timestamp with time zone",
    );
    expect(byKey.get("platform_mcp_servers.last_probe_reason")?.is_nullable).toBe(
      "YES",
    );

    // run-level withheld sink (nullable jsonb)
    expect(byKey.get("runs.withheld_mcps")?.data_type).toBe("jsonb");
    expect(byKey.get("runs.withheld_mcps")?.is_nullable).toBe("YES");

    // unique + check + index + FK exist
    const indexes = await db.execute<{ indexname: string }>(sql`
      SELECT indexname FROM pg_indexes WHERE tablename = 'project_mcp_bindings'
    `);
    const indexNames = new Set(indexes.rows.map((r) => r.indexname));
    expect(indexNames.has("project_mcp_bindings_project_ref_uq")).toBe(true);
    expect(indexNames.has("project_mcp_bindings_project_idx")).toBe(true);

    const cons = await db.execute<{ conname: string; contype: string }>(sql`
      SELECT conname, contype FROM pg_constraint
      WHERE conrelid = 'project_mcp_bindings'::regclass
    `);
    const conByName = new Map(cons.rows.map((r) => [r.conname, r.contype]));
    expect(conByName.get("project_mcp_bindings_target_kind_check")).toBe("c");
    expect(conByName.get("project_mcp_bindings_project_id_projects_id_fk")).toBe(
      "f",
    );
  });

  it("grandfather backfill flips enabled+untrusted platform MCPs to trusted, leaving disabled and already-trusted untouched", async () => {
    const enabledUntrusted = id();
    const serenaLike = id(); // disabled + untrusted
    const alreadyTrusted = id();
    await seedPlatformMcp({
      serverId: enabledUntrusted,
      enabled: true,
      trustStatus: "untrusted",
    });
    await seedPlatformMcp({
      serverId: serenaLike,
      enabled: false,
      trustStatus: "untrusted",
    });
    await seedPlatformMcp({
      serverId: alreadyTrusted,
      enabled: true,
      trustStatus: "trusted",
    });

    // Run the EXACT backfill statement the migration ships (idempotent), so the
    // test can never drift from the migration's grandfather predicate.
    const migrationSql = await readFile(
      "./lib/db/migrations/0093_mcp_management_v2.sql",
      "utf8",
    );
    const backfill = migrationSql
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .find((s) => s.startsWith("UPDATE"));
    expect(backfill).toBeDefined();
    await db.execute(sql.raw(backfill!));

    const rows = await db.execute<{ id: string; trust_status: string }>(sql`
      SELECT id, trust_status FROM platform_mcp_servers
      WHERE id IN (${enabledUntrusted}, ${serenaLike}, ${alreadyTrusted})
    `);
    const trust = new Map(rows.rows.map((r) => [r.id, r.trust_status]));
    expect(trust.get(enabledUntrusted)).toBe("trusted"); // grandfathered
    expect(trust.get(serenaLike)).toBe("untrusted"); // Serena stays gated
    expect(trust.get(alreadyTrusted)).toBe("trusted"); // no-op
  });

  it("round-trips a binding and enforces uniqueness, target_kind CHECK, and cascade delete", async () => {
    const projectId = await seedProject();
    const serverId = id();
    await seedPlatformMcp({
      serverId,
      enabled: true,
      trustStatus: "trusted",
    });

    const bindingId = id();
    await db.execute(sql`
      INSERT INTO project_mcp_bindings (id, project_id, ref_id, target_kind, target_id, config_overlay)
      VALUES (${bindingId}, ${projectId}, 'github', 'platform', ${serverId}, ${JSON.stringify({ envRemap: { GITHUB_TOKEN: "env:PROJ_A_GH" } })}::jsonb)
    `);

    const read = await db.execute<{
      ref_id: string;
      target_kind: string;
      enabled: boolean;
      config_overlay: { envRemap?: Record<string, string> };
    }>(sql`
      SELECT ref_id, target_kind, enabled, config_overlay
      FROM project_mcp_bindings WHERE id = ${bindingId}
    `);
    expect(read.rows[0].ref_id).toBe("github");
    expect(read.rows[0].target_kind).toBe("platform");
    expect(read.rows[0].enabled).toBe(true);
    expect(read.rows[0].config_overlay.envRemap?.GITHUB_TOKEN).toBe(
      "env:PROJ_A_GH",
    );

    // one binding per (project, ref)
    await expect(
      db.execute(sql`
        INSERT INTO project_mcp_bindings (id, project_id, ref_id, target_kind, target_id)
        VALUES (${id()}, ${projectId}, 'github', 'project', ${id()})
      `),
    ).rejects.toThrow(/project_mcp_bindings_project_ref_uq/);

    // target_kind CHECK
    await expect(
      db.execute(sql`
        INSERT INTO project_mcp_bindings (id, project_id, ref_id, target_kind, target_id)
        VALUES (${id()}, ${projectId}, 'other-ref', 'bogus', ${id()})
      `),
    ).rejects.toThrow(/project_mcp_bindings_target_kind_check/);

    // cascade on project delete removes the binding
    await db.execute(sql`DELETE FROM projects WHERE id = ${projectId}`);
    const after = await db.execute<{ count: string }>(sql`
      SELECT count(*)::text AS count FROM project_mcp_bindings WHERE project_id = ${projectId}
    `);
    expect(Number(after.rows[0].count)).toBe(0);
  });
});
