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

import { probeAndCache, resolveProbeTarget } from "@/lib/mcp/probe-service";

// ADR-129 (W-F, T5.5): the web-side probe. The D4 trust gate refuses an
// untrusted-source stdio probe (no override in v1); a probe result caches only a
// status/reason — never a secret value.

type Db = NodePgDatabase;

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: Db;

const SECRET = "ghp_MUST_NOT_PERSIST_9999";

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("maister_probe_test")
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

const gateDb = () => ({
  execute: (q: Parameters<Db["execute"]>[0]) => db.execute(q),
});

async function seedProject(): Promise<string> {
  const id = randomUUID();

  await db.execute(sql`
    INSERT INTO projects (id, slug, name, repo_path, task_key)
    VALUES (${id}, ${`p-${id.slice(0, 8)}`}, 'P', ${`/tmp/p-${id.slice(0, 8)}`}, ${`T${id.slice(0, 8)}`.toUpperCase()})
  `);

  return id;
}

async function seedPlatform(args: {
  transport: string;
  trust: string;
}): Promise<string> {
  const id = `srv-${randomUUID().slice(0, 8)}`;

  await db.execute(sql`
    INSERT INTO platform_mcp_servers (id, transport, command, url, env_keys, enabled, trust_status)
    VALUES (${id}, ${args.transport}, 'npx', 'https://x/mcp',
            ${JSON.stringify(["env:GH_TOKEN"])}::jsonb, true, ${args.trust})
  `);

  return id;
}

describe("probe-service — D4 trust gate + no-secret cache", () => {
  it("REFUSES probing an untrusted-source stdio MCP (CONFIG, no override)", async () => {
    const projectId = await seedProject();
    const serverId = await seedPlatform({
      transport: "stdio",
      trust: "untrusted",
    });

    await expect(
      resolveProbeTarget(
        projectId,
        { targetKind: "platform", targetId: serverId },
        gateDb(),
      ),
    ).rejects.toMatchObject({ code: "CONFIG" });
  });

  it("allows an untrusted-source HTTP MCP (no local exec) and resolves NAMES only", async () => {
    const projectId = await seedProject();
    const serverId = await seedPlatform({
      transport: "http",
      trust: "untrusted",
    });

    const { request } = await resolveProbeTarget(
      projectId,
      { targetKind: "platform", targetId: serverId },
      gateDb(),
    );

    expect(request.transport).toBe("http");
    // env NAMES only — never a value.
    expect(request.envKeys).toEqual(["GH_TOKEN"]);
    expect(JSON.stringify(request)).not.toContain(SECRET);
  });

  it("probes a trusted stdio MCP and caches Ok status without any secret value", async () => {
    const projectId = await seedProject();
    const serverId = await seedPlatform({
      transport: "stdio",
      trust: "trusted",
    });

    const result = await probeAndCache(
      projectId,
      { targetKind: "platform", targetId: serverId },
      gateDb(),
      // Stub the supervisor call — no real spawn; return a value-free result.
      async () => ({
        ok: true,
        latencyMs: 12,
        serverInfo: { name: "srv", version: "1" },
      }),
    );

    expect(result.ok).toBe(true);

    const [row] = (
      await db.execute(
        sql`SELECT last_probe_status, last_probe_reason FROM platform_mcp_servers WHERE id = ${serverId}`,
      )
    ).rows as Array<{
      last_probe_status: string;
      last_probe_reason: string | null;
    }>;

    expect(row.last_probe_status).toBe("Ok");
    // The whole cached row carries no secret value.
    expect(JSON.stringify(row)).not.toContain(SECRET);
  });

  it("probes a bound ref via its enabled binding", async () => {
    const projectId = await seedProject();
    const serverId = await seedPlatform({
      transport: "http",
      trust: "trusted",
    });

    await db.execute(sql`
      INSERT INTO project_mcp_bindings (id, project_id, ref_id, target_kind, target_id, enabled)
      VALUES (${randomUUID()}, ${projectId}, 'github', 'platform', ${serverId}, true)
    `);

    let sentTransport = "";
    const result = await probeAndCache(
      projectId,
      { refId: "github" },
      gateDb(),
      async (req) => {
        sentTransport = req.transport;

        return { ok: true };
      },
    );

    expect(result.ok).toBe(true);
    expect(sentTransport).toBe("http");
  });
});
