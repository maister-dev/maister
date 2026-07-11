import "server-only";

import type { AgentMcpServer } from "@/lib/capabilities/agent-map";
import type { WithheldMcp } from "@/lib/db/schema";

import { inArray, sql, type SQL } from "drizzle-orm";

import { platformMcpServers } from "@/lib/db/schema";

// ADR-129 (W-E): the materialization gate makes platform `trust_status`
// load-bearing and unifies it with the exec-trust stdio gate into ONE structured
// withheld pass. An untrusted platform MCP is VISIBLE in the hub/ledger but
// excluded from the executable set (reason `platform-untrusted`); a stdio MCP on
// an exec-untrusted revision is withheld (`exec-untrusted-stdio`). No silent
// warn-only path — every withhold is a structured record persisted downstream.

type GateDb = {
  execute(query: SQL): Promise<{ rows?: unknown[] }>;
};

// Live platform trust for the winning source='platform' MCP refs. `trusted` or
// `trusted_by_policy` → true; anything else (incl. a missing row) → false
// (fail-closed). Read at materialization so an admin trust flip takes effect on
// the next launch (not snapshot-at-projection).
export async function loadPlatformTrustByRef(
  mcpEntries: ReadonlyArray<{ refId: string; source: string }>,
  db: GateDb,
): Promise<Map<string, boolean>> {
  const platformRefs = [
    ...new Set(
      mcpEntries.filter((e) => e.source === "platform").map((e) => e.refId),
    ),
  ];

  if (platformRefs.length === 0) return new Map();

  const result = await db.execute(
    sql`SELECT id, trust_status FROM ${platformMcpServers} WHERE ${inArray(
      platformMcpServers.id,
      platformRefs,
    )}`,
  );
  const rows = (result.rows ?? []) as Array<{
    id: string;
    trust_status: string;
  }>;
  const map = new Map<string, boolean>();

  for (const ref of platformRefs) map.set(ref, false);
  for (const row of rows) {
    map.set(
      row.id,
      row.trust_status === "trusted" ||
        row.trust_status === "trusted_by_policy",
    );
  }

  return map;
}

// Partition the materialized MCP servers into the executable set + the withheld
// list. Pure: platform-trust is checked FIRST (an untrusted platform server is
// withheld regardless of transport), then exec-trust for local stdio spawns.
export function partitionWithheldMcps(args: {
  mcpServers: readonly AgentMcpServer[];
  sourceByRef: Map<string, string>;
  platformTrustedByRef: Map<string, boolean>;
  execTrust: "untrusted" | "trusted";
}): { kept: AgentMcpServer[]; withheld: WithheldMcp[] } {
  const kept: AgentMcpServer[] = [];
  const withheld: WithheldMcp[] = [];

  for (const server of args.mcpServers) {
    const scope = args.sourceByRef.get(server.name) ?? "";

    if (
      scope === "platform" &&
      args.platformTrustedByRef.get(server.name) !== true
    ) {
      withheld.push({
        refId: server.name,
        transport: server.transport,
        reason: "platform-untrusted",
        scope,
      });
      continue;
    }

    if (server.transport === "stdio" && args.execTrust === "untrusted") {
      withheld.push({
        refId: server.name,
        transport: server.transport,
        reason: "exec-untrusted-stdio",
        scope,
      });
      continue;
    }

    kept.push(server);
  }

  return { kept, withheld };
}

// Merge a node's withheld MCPs into the run-level `runs.withheld_mcps` sink,
// deduped by (refId, reason). Flow runs also keep per-node granularity in
// `node_attempts.materialization_plan.withheldMcps`; this run-level record is the
// single row the run-detail panel reads. A no-op when nothing was withheld.
export async function mergeRunWithheldMcps(
  db: GateDb,
  runId: string,
  withheld: readonly WithheldMcp[],
): Promise<void> {
  if (withheld.length === 0) return;

  const current = ((
    await db.execute(
      sql`SELECT withheld_mcps FROM runs WHERE id = ${runId} LIMIT 1`,
    )
  ).rows ?? []) as Array<{ withheld_mcps: WithheldMcp[] | null }>;
  const existing = current[0]?.withheld_mcps ?? [];
  const byKey = new Map<string, WithheldMcp>();

  for (const w of [...existing, ...withheld]) {
    byKey.set(`${w.refId}::${w.reason}`, w);
  }

  await db.execute(
    sql`UPDATE runs SET withheld_mcps = ${JSON.stringify([...byKey.values()])}::jsonb WHERE id = ${runId}`,
  );
}
