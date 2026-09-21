import "server-only";

import type { AgentMcpServer } from "@/lib/capabilities/agent-map";
import type { McpConfigOverlay, WithheldMcp } from "@/lib/db/schema";

import { inArray, sql, type SQL } from "drizzle-orm";

import {
  mcpTransportsForAdapter,
  type AdapterId,
} from "@/lib/acp-runners/adapter-support";
import { platformMcpServers } from "@/lib/db/schema";
import {
  assertOverlayAgainstSlots,
  loadProjectMcpOverlays,
} from "@/lib/mcp/binding-service";

// ADR-129 (W-E) + ADR-177: the materialization gate makes platform
// `trust_status` load-bearing and unifies it with the exec-trust stdio gate and
// the adapter transport gate into ONE structured withheld pass. An untrusted
// platform MCP is VISIBLE in the hub/ledger but excluded from the executable set
// (`platform-untrusted`); a stdio MCP on an exec-untrusted revision is withheld
// (`exec-untrusted-stdio`); a server whose transport the launch adapter cannot
// use is withheld (`agent-unsupported-transport`). No silent warn-only path —
// every withhold is a structured record persisted downstream.

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
// list. Pure. Pass order is `platform-untrusted` > `exec-untrusted-stdio` >
// `agent-unsupported-transport`, so the STRONGEST refusal names the withhold: an
// untrusted platform server stays `platform-untrusted` even when the adapter
// also cannot speak its transport.
export function partitionWithheldMcps(args: {
  mcpServers: readonly AgentMcpServer[];
  sourceByRef: Map<string, string>;
  platformTrustedByRef: Map<string, boolean>;
  execTrust: "untrusted" | "trusted";
  // Absent = no transport gate (a caller that does not know its adapter must
  // not silently withhold everything).
  adapter?: AdapterId | null;
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

    // ADR-177: codex-acp throws `invalidRequest` for `sse` while BUILDING the
    // session config, so one unusable server fails `session/new` for the whole
    // session. An ADDITIONAL ref is dropped here; a REQUIRED one refuses the
    // launch earlier, at the precondition, before any workspace exists.
    if (
      args.adapter &&
      !mcpTransportsForAdapter(args.adapter).includes(server.transport)
    ) {
      withheld.push({
        refId: server.name,
        transport: server.transport,
        reason: "agent-unsupported-transport",
        scope,
      });
      continue;
    }

    kept.push(server);
  }

  return { kept, withheld };
}

// Replace the VALUE for each declared key the overlay names, PRESERVING the key.
// Keys the overlay does not name keep their value.
function overlaidMap(
  current: Readonly<Record<string, string>> | undefined,
  remap: Readonly<Record<string, string>> | undefined,
): Record<string, string> {
  const next: Record<string, string> = { ...(current ?? {}) };

  if (!remap) return next;

  for (const key of Object.keys(next)) {
    const value = remap[key];

    if (value !== undefined) next[key] = value;
  }

  return next;
}

// ADR-129 (W-C), amended by ADR-177: apply per-binding overlays to the
// materialized servers by replacing the VALUE for a key the target declares and
// PRESERVING the key. The key is the SERVER's contract — renaming it (the
// pre-ADR-177 behavior) meant the server never received the variable it reads.
// The ACP wire shape is unchanged and the execution host still resolves each
// `env:NAME`. The overlay is re-validated against the server's declared slots
// (defensive; unknown slot → CONFIG), so a stale binding cannot smuggle an
// unknown slot past the write-time check.
export function applyMcpOverlays(
  mcpServers: readonly AgentMcpServer[],
  overlaysByRef: Map<string, McpConfigOverlay>,
): AgentMcpServer[] {
  return mcpServers.map((server) => {
    const overlay = overlaysByRef.get(server.name);

    if (!overlay) return server;

    assertOverlayAgainstSlots(overlay, {
      env: Object.keys(server.env ?? {}),
      header: Object.keys(server.headers ?? {}),
      transport: server.transport,
    });

    const next: AgentMcpServer = { ...server };

    if (overlay.envRemap && server.env) {
      next.env = overlaidMap(server.env, overlay.envRemap);
    }
    if (overlay.headerRemap && server.headers) {
      next.headers = overlaidMap(server.headers, overlay.headerRemap);
    }
    if (overlay.bearerTokenEnv !== undefined) {
      next.bearerTokenEnv = overlay.bearerTokenEnv;
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

// ADR-129 + ADR-177: the ONE gate+overlay composition taken by all THREE launch
// surfaces — the flow node (`runner-graph.ts`), the standalone agent
// (`agents/launch.ts`) and the scratch session (`scratch-runs/service.ts`). Do
// not fork it (spec §13). Partitions the materialized MCP servers into the
// executable set + withheld list (platform trust, then exec-trust, then adapter
// transport), persists the withheld to the run-level sink, and applies the
// per-binding VALUE overlays to the kept set. `overlaidRefs` and `withheld` are
// returned so each caller can add its own granularity
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
  // The launch adapter, for the transport gate. Threaded from all three
  // surfaces as the run's `capabilityAgent`.
  adapter?: AdapterId | null;
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
    adapter: args.adapter ?? null,
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
