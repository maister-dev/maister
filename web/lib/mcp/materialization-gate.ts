import "server-only";

import type { AgentMcpServer } from "@/lib/capabilities/agent-map";
import type { McpConfigOverlay, WithheldMcp } from "@/lib/db/schema";

import { inArray, sql, type SQL } from "drizzle-orm";

import { platformMcpServers } from "@/lib/db/schema";
import {
  assertOverlayAgainstSlots,
  loadProjectMcpOverlays,
} from "@/lib/mcp/binding-service";

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

function bareName(k: string): string {
  return k.startsWith("env:") ? k.slice(4) : k;
}

// ADR-129 (W-C): apply per-binding overlays to the materialized servers by
// rewriting env/header/arg/url NAMES only — the ACP wire shape is unchanged and
// the supervisor still resolves values from `process.env`. NO secret VALUE is
// ever introduced. The overlay is re-validated against the server's declared
// slots (defensive; unknown slot → CONFIG), so a stale binding cannot smuggle an
// unknown slot past the write-time check.
export function applyMcpOverlays(
  mcpServers: readonly AgentMcpServer[],
  overlaysByRef: Map<string, McpConfigOverlay>,
): AgentMcpServer[] {
  return mcpServers.map((server) => {
    const overlay = overlaysByRef.get(server.name);

    if (!overlay) return server;

    assertOverlayAgainstSlots(overlay, {
      env: server.envKeys ?? [],
      header: server.headerKeys ?? [],
    });

    const next: AgentMcpServer = { ...server };

    if (overlay.envRemap && server.envKeys) {
      next.envKeys = server.envKeys.map((k) => {
        const remap = overlay.envRemap?.[bareName(k)];

        return remap !== undefined ? bareName(remap) : k;
      });
    }
    if (overlay.headerRemap && server.headerKeys) {
      next.headerKeys = server.headerKeys.map((k) => {
        const remap = overlay.headerRemap?.[bareName(k)];

        return remap !== undefined ? bareName(remap) : k;
      });
    }
    if (overlay.argsOverride !== undefined)
      next.args = [...overlay.argsOverride];
    if (overlay.urlOverride !== undefined) next.url = overlay.urlOverride;

    return next;
  });
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

// ADR-129: the ONE gate+overlay composition shared by every launch surface
// (flow node, agent, scratch) — do not fork it (spec §13). Partitions the
// materialized MCP servers into the executable set + withheld list (platform
// trust then exec-trust), persists the withheld to the run-level sink, and
// applies the per-binding NAME-only overlays to the kept set. `overlaidRefs` and
// `withheld` are returned so each caller can add its own granularity
// (`node_attempts.materialization_plan.withheldMcps` for flows) and logging.
export async function gateAndOverlayMcpServers(args: {
  db: GateDb;
  projectId: string;
  runId: string;
  supported: ReadonlyArray<{
    kind: string;
    capabilityRefId: string;
    source: string;
  }>;
  mcpServers: readonly AgentMcpServer[];
  execTrust: "untrusted" | "trusted";
}): Promise<{
  mcpServers: AgentMcpServer[];
  withheld: WithheldMcp[];
  overlaidRefs: string[];
}> {
  const mcpEntries = args.supported
    .filter((e) => e.kind === "mcp")
    .map((e) => ({ refId: e.capabilityRefId, source: e.source }));
  const { kept, withheld } = partitionWithheldMcps({
    mcpServers: args.mcpServers,
    sourceByRef: new Map(mcpEntries.map((e) => [e.refId, e.source])),
    platformTrustedByRef: await loadPlatformTrustByRef(mcpEntries, args.db),
    execTrust: args.execTrust,
  });

  if (withheld.length > 0) {
    await mergeRunWithheldMcps(args.db, args.runId, withheld);
  }

  const overlays = await loadProjectMcpOverlays(
    args.projectId,
    args.db as never,
  );

  return {
    mcpServers: overlays.size > 0 ? applyMcpOverlays(kept, overlays) : kept,
    withheld,
    overlaidRefs: [...overlays.keys()],
  };
}
