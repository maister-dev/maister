import { randomUUID } from "node:crypto";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildResolvedCapabilitySet } from "@/lib/capabilities/resolver";
import { MaisterError } from "@/lib/errors";
import {
  connectPlatform,
  createBinding,
  deleteBinding,
  disconnectRef,
  loadProjectMcpBindings,
  updateBinding,
} from "@/lib/mcp/binding-service";

// ADR-129 (W-A/W-B/W-C): binding service + binding-aware resolution against real
// Postgres. Proves bind→load→snapshot provenance, disconnect→exclusion,
// grandfather zero-change, and the target/overlay validation contract.
//
// `platform_mcp_servers` is a GLOBAL (host-wide) catalog, so every test mints a
// UNIQUE platform server id; resolution matches the projected capability_records
// by source, so the binding always targets ref "github".

type Db = NodePgDatabase;

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: Db;

const catalog = [
  {
    capabilityRefId: "github",
    kind: "mcp",
    source: "platform",
    revision: "pf",
  },
  { capabilityRefId: "github", kind: "mcp", source: "project", revision: "pj" },
];

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("maister_binding_test")
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

const injected = () => ({
  execute: (q: Parameters<Db["execute"]>[0]) => db.execute(q),
});

async function seedProject(): Promise<string> {
  const projectId = randomUUID();

  await db.execute(sql`
    INSERT INTO projects (id, slug, name, repo_path, task_key)
    VALUES (${projectId}, ${`p-${projectId.slice(0, 8)}`}, 'Binding project',
            ${`/tmp/p-${projectId.slice(0, 8)}`}, ${`T${projectId.slice(0, 8)}`.toUpperCase()})
  `);

  return projectId;
}

async function seedPlatformServer(args: {
  enabled: boolean;
  trust: string;
  envKeys?: string[];
}): Promise<string> {
  const id = `srv-${randomUUID().slice(0, 8)}`;

  await db.execute(sql`
    INSERT INTO platform_mcp_servers (id, transport, command, env_keys, enabled, trust_status)
    VALUES (${id}, 'stdio', 'npx', ${JSON.stringify(args.envKeys ?? [])}::jsonb,
            ${args.enabled}, ${args.trust})
  `);

  return id;
}

async function seedProjectMcp(projectId: string, refId: string): Promise<void> {
  await db.execute(sql`
    INSERT INTO capability_records (
      id, project_id, capability_ref_id, kind, label, source, agents,
      enforceability, selected_by_default, selectable, material, created_at, updated_at
    )
    VALUES (${randomUUID()}, ${projectId}, ${refId}, 'mcp', ${refId}, 'project',
            ${JSON.stringify(["claude"])}::jsonb, 'enforced', true, true,
            ${JSON.stringify({ origin: "project-mcp", transport: "stdio", command: "npx", envKeys: ["GH_TOKEN"] })}::jsonb,
            now(), now())
  `);
}

function snapshotFor(
  mcpBindings: Awaited<ReturnType<typeof loadProjectMcpBindings>>,
) {
  return buildResolvedCapabilitySet({
    records: catalog,
    flowRevisionId: "r",
    flowOrigin: "git",
    mcpBindings,
  });
}

describe("binding-service — bind → load → resolve (W-A/W-B)", () => {
  it("an enabled binding to platform WINS over project precedence with provenance", async () => {
    const projectId = await seedProject();
    const serverId = await seedPlatformServer({
      enabled: true,
      trust: "trusted",
      envKeys: ["env:GITHUB_TOKEN"],
    });

    await seedProjectMcp(projectId, "github");

    // Grandfather (no binding) → project wins by precedence.
    const grandfather = snapshotFor(
      await loadProjectMcpBindings(projectId, injected()),
    );

    expect(grandfather.mcps).toEqual([
      {
        refId: "github",
        sha: "pj",
        scope: "project",
        provenance: "precedence",
      },
    ]);

    // Bind to platform → platform wins over precedence.
    await createBinding(
      projectId,
      { refId: "github", targetKind: "platform", targetId: serverId },
      injected(),
    );
    const bound = snapshotFor(
      await loadProjectMcpBindings(projectId, injected()),
    );

    expect(bound.mcps).toEqual([
      {
        refId: "github",
        sha: "pf",
        scope: "platform",
        provenance: "binding",
        boundTarget: { kind: "platform", id: serverId },
      },
    ]);
  });

  it("disconnect makes the ref unresolvable, delete reverts to grandfather", async () => {
    const projectId = await seedProject();
    const serverId = await seedPlatformServer({
      enabled: true,
      trust: "trusted",
    });

    await seedProjectMcp(projectId, "github");
    await connectPlatform(projectId, serverId, "github", null, injected());

    await disconnectRef(projectId, "github", null, injected());
    const bindings = await loadProjectMcpBindings(projectId, injected());

    expect(bindings.find((b) => b.refId === "github")?.enabled).toBe(false);
    expect(snapshotFor(bindings).mcps).toEqual([]);

    await deleteBinding(projectId, "github", injected());
    expect(
      snapshotFor(await loadProjectMcpBindings(projectId, injected())).mcps[0]
        ?.provenance,
    ).toBe("precedence");
  });
});

describe("binding-service — validation contract", () => {
  it("refuses binding a disabled/untrusted platform target as executable (CONFLICT)", async () => {
    const projectId = await seedProject();
    const serverId = await seedPlatformServer({
      enabled: false,
      trust: "untrusted",
    });

    await expect(
      createBinding(
        projectId,
        { refId: "serena", targetKind: "platform", targetId: serverId },
        injected(),
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("refuses a missing target (CONFIG) and a duplicate binding (CONFLICT)", async () => {
    const projectId = await seedProject();
    const serverId = await seedPlatformServer({
      enabled: true,
      trust: "trusted",
    });

    await expect(
      createBinding(
        projectId,
        { refId: "ghost", targetKind: "platform", targetId: "does-not-exist" },
        injected(),
      ),
    ).rejects.toMatchObject({ code: "CONFIG" });

    await createBinding(
      projectId,
      { refId: "github", targetKind: "platform", targetId: serverId },
      injected(),
    );
    await expect(
      createBinding(
        projectId,
        { refId: "github", targetKind: "platform", targetId: serverId },
        injected(),
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("validates the overlay against the target's declared slots (unknown slot → CONFIG)", async () => {
    const projectId = await seedProject();
    const serverId = await seedPlatformServer({
      enabled: true,
      trust: "trusted",
      envKeys: ["env:GITHUB_TOKEN"],
    });

    // Known slot → accepted.
    await createBinding(
      projectId,
      {
        refId: "github",
        targetKind: "platform",
        targetId: serverId,
        configOverlay: { envRemap: { GITHUB_TOKEN: "env:PROJ_A_GH" } },
      },
      injected(),
    );

    // Unknown slot → CONFIG.
    let threw: MaisterError | null = null;

    try {
      await updateBinding(
        projectId,
        "github",
        { configOverlay: { envRemap: { NOT_A_SLOT: "env:X" } } },
        injected(),
      );
    } catch (err) {
      threw = err as MaisterError;
    }
    expect(threw?.code).toBe("CONFIG");
  });
});
