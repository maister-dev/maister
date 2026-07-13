import type { AgentMcpServer } from "@/lib/capabilities/agent-map";
import type { WithheldMcp } from "@/lib/db/schema";

import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  loadPlatformTrustByRef,
  mergeRunWithheldMcps,
  partitionWithheldMcps,
} from "@/lib/mcp/materialization-gate";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

// ADR-129 (W-E): platform trust is load-bearing at materialization. An untrusted
// platform MCP is withheld (visible-but-not-executable); trusting it via the
// admin route makes it materializable on the next launch (live-join). Withheld is
// durably persisted to runs.withheld_mcps.

type Db = NodePgDatabase;

let testDatabase: StartedPostgresTestDb;
let db: Db;

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "maister_trust_gate_test",
  });
  db = testDatabase.db;
}, 180_000);

afterAll(async () => {
  await testDatabase?.stop();
});

const gateDb = () => ({
  execute: (q: Parameters<Db["execute"]>[0]) => db.execute(q),
});

async function seedPlatformServer(trust: string): Promise<string> {
  const id = `srv-${randomUUID().slice(0, 8)}`;

  await db.execute(sql`
    INSERT INTO platform_mcp_servers (id, transport, command, enabled, trust_status)
    VALUES (${id}, 'stdio', 'npx', true, ${trust})
  `);

  return id;
}

async function seedRun(): Promise<string> {
  const projectId = randomUUID();
  const taskId = randomUUID();
  const userId = randomUUID();
  const runId = randomUUID();

  await db.execute(sql`
    INSERT INTO users (id, email, role, account_status)
    VALUES (${userId}, ${`u-${userId.slice(0, 8)}@x.test`}, 'member', 'active')
  `);
  await db.execute(sql`
    INSERT INTO projects (id, slug, name, repo_path, task_key)
    VALUES (${projectId}, ${`p-${projectId.slice(0, 8)}`}, 'P',
            ${`/tmp/p-${projectId.slice(0, 8)}`}, ${`T${projectId.slice(0, 8)}`.toUpperCase()})
  `);
  await db.execute(sql`
    INSERT INTO tasks (id, project_id, number, title, prompt, created_by_user_id)
    VALUES (${taskId}, ${projectId}, 1, 'T', 'p', ${userId})
  `);
  await db.execute(sql`
    INSERT INTO runs (id, task_id, project_id, flow_version)
    VALUES (${runId}, ${taskId}, ${projectId}, 'test')
  `);

  return runId;
}

const srv = (name: string): AgentMcpServer => ({ name, transport: "stdio" });

describe("materialization trust gate (W-E, real postgres)", () => {
  it("withholds an untrusted platform MCP and materializes a trusted one; a trust flip takes effect", async () => {
    const untrusted = await seedPlatformServer("untrusted");
    const trusted = await seedPlatformServer("trusted");

    const entries = [
      { refId: untrusted, source: "platform" },
      { refId: trusted, source: "platform" },
    ];
    const trustMap = await loadPlatformTrustByRef(entries, gateDb());

    expect(trustMap.get(untrusted)).toBe(false);
    expect(trustMap.get(trusted)).toBe(true);

    const { kept, withheld } = partitionWithheldMcps({
      mcpServers: [srv(untrusted), srv(trusted)],
      sourceByRef: new Map(entries.map((e) => [e.refId, e.source])),
      platformTrustedByRef: trustMap,
      execTrust: "trusted",
    });

    expect(kept.map((s) => s.name)).toEqual([trusted]);
    expect(withheld).toEqual([
      {
        refId: untrusted,
        transport: "stdio",
        reason: "platform-untrusted",
        scope: "platform",
      },
    ]);

    // Admin trusts the previously-untrusted server → next materialization keeps it.
    await db.execute(
      sql`UPDATE platform_mcp_servers SET trust_status = 'trusted' WHERE id = ${untrusted}`,
    );
    const reTrust = await loadPlatformTrustByRef(entries, gateDb());

    expect(reTrust.get(untrusted)).toBe(true);
  });

  it("persists withheld to runs.withheld_mcps, deduped by (refId, reason)", async () => {
    const runId = await seedRun();
    const withheld: WithheldMcp[] = [
      {
        refId: "serena",
        transport: "stdio",
        reason: "platform-untrusted",
        scope: "platform",
      },
    ];

    await mergeRunWithheldMcps(gateDb(), runId, withheld);
    // Re-merging the same record is idempotent (deduped).
    await mergeRunWithheldMcps(gateDb(), runId, withheld);

    const rows = ((
      await db.execute(sql`SELECT withheld_mcps FROM runs WHERE id = ${runId}`)
    ).rows ?? []) as Array<{ withheld_mcps: WithheldMcp[] | null }>;

    expect(rows[0].withheld_mcps).toEqual(withheld);
  });
});
