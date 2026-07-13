import type { AgentMcpServer } from "@/lib/capabilities/agent-map";

import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createBinding,
  loadProjectMcpOverlays,
} from "@/lib/mcp/binding-service";
import { applyMcpOverlays } from "@/lib/mcp/materialization-gate";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

// ADR-129 (W-C, T4.3): the untouchable-invariant guard. Project A and project B
// remap the same MCP's env slot to DIFFERENT names; each session gets its own
// NAME, and a seeded secret VALUE appears in NO DB row, response, or log fixture.

type Db = NodePgDatabase;

// The literal token VALUE that must NEVER cross into any web-tier structure.
const SECRET_SENTINEL = "ghp_THIS_VALUE_MUST_NEVER_APPEAR_1234567890";

let testDatabase: StartedPostgresTestDb;
let db: Db;

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "maister_overlay_secret_test",
  });
  db = testDatabase.db;
  // The host env holds the real value under the REMAPPED name — supervisor-side
  // resolution territory. The web tier must never read it.
  process.env.PROJ_A_TOKEN = SECRET_SENTINEL;
  process.env.PROJ_B_TOKEN = SECRET_SENTINEL;
}, 180_000);

afterAll(async () => {
  delete process.env.PROJ_A_TOKEN;
  delete process.env.PROJ_B_TOKEN;
  await testDatabase?.stop();
});

const injected = () => ({
  execute: (q: Parameters<Db["execute"]>[0]) => db.execute(q),
});

async function seedProject(): Promise<string> {
  const projectId = randomUUID();

  await db.execute(sql`
    INSERT INTO projects (id, slug, name, repo_path, task_key)
    VALUES (${projectId}, ${`p-${projectId.slice(0, 8)}`}, 'P',
            ${`/tmp/p-${projectId.slice(0, 8)}`}, ${`T${projectId.slice(0, 8)}`.toUpperCase()})
  `);

  return projectId;
}

// One shared, host-wide `github` platform server. Its id IS its projected ref
// (projection.ts: capability_ref_id = <server id>), so binding ref "github" to
// it is the coherent shape (`target.refId === ref_id`). Idempotent: multiple
// projects overlay the SAME server with different NAMES.
async function seedGithubServer(): Promise<string> {
  await db.execute(sql`
    INSERT INTO platform_mcp_servers (id, transport, command, env_keys, enabled, trust_status)
    VALUES ('github', 'stdio', 'npx', ${JSON.stringify(["env:API_TOKEN"])}::jsonb, true, 'trusted')
    ON CONFLICT (id) DO NOTHING
  `);

  return "github";
}

const githubServer = (): AgentMcpServer => ({
  name: "github",
  transport: "stdio",
  command: "npx",
  args: ["-y", "server-github"],
  envKeys: ["API_TOKEN"],
});

describe("overlay secret invariant (W-C, real postgres)", () => {
  it("gives each project its own remapped NAME and never lets the secret VALUE cross", async () => {
    const projectA = await seedProject();
    const projectB = await seedProject();
    const serverA = await seedGithubServer();
    const serverB = await seedGithubServer();

    await createBinding(
      projectA,
      {
        refId: "github",
        targetKind: "platform",
        targetId: serverA,
        configOverlay: { envRemap: { API_TOKEN: "env:PROJ_A_TOKEN" } },
      },
      injected(),
    );
    await createBinding(
      projectB,
      {
        refId: "github",
        targetKind: "platform",
        targetId: serverB,
        configOverlay: { envRemap: { API_TOKEN: "env:PROJ_B_TOKEN" } },
      },
      injected(),
    );

    const [appliedA] = applyMcpOverlays(
      [githubServer()],
      await loadProjectMcpOverlays(projectA, injected()),
    );
    const [appliedB] = applyMcpOverlays(
      [githubServer()],
      await loadProjectMcpOverlays(projectB, injected()),
    );

    // Each session receives its OWN name.
    expect(appliedA.envKeys).toEqual(["PROJ_A_TOKEN"]);
    expect(appliedB.envKeys).toEqual(["PROJ_B_TOKEN"]);

    // The secret VALUE never appears in the materialized ACP server payloads.
    expect(JSON.stringify(appliedA)).not.toContain(SECRET_SENTINEL);
    expect(JSON.stringify(appliedB)).not.toContain(SECRET_SENTINEL);
  });

  it("stores only NAMES in the binding row — the secret VALUE is in no DB column", async () => {
    const projectId = await seedProject();
    const serverId = await seedGithubServer();

    await createBinding(
      projectId,
      {
        refId: "github",
        targetKind: "platform",
        targetId: serverId,
        configOverlay: { envRemap: { API_TOKEN: "env:PROJ_A_TOKEN" } },
      },
      injected(),
    );

    // Scan the entire binding table's serialized content for the secret value.
    const rows = ((
      await db.execute(
        sql`SELECT id, ref_id, target_kind, target_id, config_overlay FROM project_mcp_bindings WHERE project_id = ${projectId}`,
      )
    ).rows ?? []) as unknown[];

    expect(JSON.stringify(rows)).not.toContain(SECRET_SENTINEL);
    expect(JSON.stringify(rows)).toContain("env:PROJ_A_TOKEN");
  });
});
