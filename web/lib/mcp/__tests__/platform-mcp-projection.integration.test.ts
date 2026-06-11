// M27/T-C3: an admin-created platform_mcp_servers row (T-C1) projects into a
// source='platform' capability_records row through the existing
// upsertCapabilitiesFromConfig pipeline — replacing the legacy .mcp.json
// registry. Verifies env NAME-only redaction reaches the material. Docker-only.
import { randomUUID } from "node:crypto";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { and, eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { upsertCapabilitiesFromConfig } from "@/lib/capabilities/catalog";
import * as schemaModule from "@/lib/db/schema";
import { loadPlatformMcpCapabilitiesFromDb } from "@/lib/mcp/projection";

const schema = schemaModule as unknown as Record<string, any>;
const { platformMcpServers, projects, capabilityRecords } = schema;

const EMPTY_CAPS = {
  mcps: [],
  skills: [],
  rules: [],
  restrictions: [],
  settings: [],
  tools: [],
  agent_definitions: [],
  env_profiles: [],
};

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("mcp_projection_test")
    .withUsername("test")
    .withPassword("test")
    .start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);
  await migrate(db, { migrationsFolder: "./lib/db/migrations" });
}, 120_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

describe("platform MCP → capability_records projection (real postgres)", () => {
  it("projects an enabled platform_mcp_servers row as a source=platform capability record", async () => {
    const projectId = `prj_${randomUUID().slice(0, 8)}`;

    await db.insert(projects).values({ taskKey: `T${crypto.randomUUID().slice(0, 8)}`.toUpperCase(),
      id: projectId,
      slug: `slug-${randomUUID().slice(0, 8)}`,
      name: "proj",
      repoPath: `/repos/${randomUUID().slice(0, 8)}`,
      maisterYamlPath: "/repos/x/maister.yaml",
    });
    await db.insert(platformMcpServers).values({
      id: "github",
      transport: "stdio",
      command: "github-mcp",
      args: ["-y"],
      envKeys: ["env:GITHUB_TOKEN"],
      supportedAgents: ["claude", "codex"],
    });
    // A disabled server MUST NOT project.
    await db.insert(platformMcpServers).values({
      id: "disabled-one",
      transport: "stdio",
      command: "noop",
      enabled: false,
    });

    const platformMcps = await loadPlatformMcpCapabilitiesFromDb(db);

    expect(platformMcps.map((m) => m.id)).toEqual(["github"]);

    await upsertCapabilitiesFromConfig({
      projectId,
      config: EMPTY_CAPS as never,
      platformMcps,
      db,
    });

    const rows = await db
      .select()
      .from(capabilityRecords)
      .where(
        and(
          eq(capabilityRecords.projectId, projectId),
          eq(capabilityRecords.source, "platform"),
          eq(capabilityRecords.kind, "mcp"),
        ),
      );

    expect(rows).toHaveLength(1);
    const record = rows[0] as {
      capabilityRefId: string;
      material: { command?: string; envKeys?: string[] };
    };

    expect(record.capabilityRefId).toBe("github");
    expect(record.material.command).toBe("github-mcp");
    // NAME-only — the secret value is never stored.
    expect(record.material.envKeys).toEqual(["GITHUB_TOKEN"]);
  });
});
