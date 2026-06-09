// M27/T-C7 (setup-resolve, ADR-069): pure, unit-testable classifier for the
// setup-time "do I already have this MCP?" question. Given a flow package's
// REQUIRED mcp ref ids and the project's mcp capability records, classify each
// id as "present" (a winner record exists → reuse/dedupe, no silent duplicate)
// or "absent" (→ propose-to-configure via the C5 create route). NOT server-only:
// no I/O here, only set logic.

export type McpResolution =
  | { refId: string; status: "present"; recordId: string; scope: string }
  | { refId: string; status: "absent" };

type McpRecord = { id: string; capabilityRefId: string; source: string };

// R-CONTRACT: mirrors lib/capabilities/resolver.ts SOURCE_PRECEDENCE exactly
// (it is module-private there, not exported). Lower number wins. A project
// record shadows a platform record of the same refId, which shadows a
// flow-package record — same local-first precedence used everywhere else.
const SOURCE_PRECEDENCE: Record<string, number> = {
  project: 0,
  platform: 1,
  "flow-package": 2,
};

function sourceRank(source: string): number {
  return SOURCE_PRECEDENCE[source] ?? Number.MAX_SAFE_INTEGER;
}

// Local-first winner per refId: exactly ONE record by source precedence, tie-
// broken on the unique row id for determinism (matches resolver.ts).
function pickWinner(records: readonly McpRecord[]): McpRecord {
  return [...records].sort((a, b) => {
    const bySource = sourceRank(a.source) - sourceRank(b.source);

    return bySource !== 0 ? bySource : a.id.localeCompare(b.id);
  })[0];
}

export function resolveRequiredMcps(
  requiredIds: readonly string[],
  mcpRecords: ReadonlyArray<McpRecord>,
): McpResolution[] {
  const byRef = new Map<string, McpRecord[]>();

  for (const record of mcpRecords) {
    const bucket = byRef.get(record.capabilityRefId) ?? [];

    bucket.push(record);
    byRef.set(record.capabilityRefId, bucket);
  }

  const seen = new Set<string>();
  const resolutions: McpResolution[] = [];

  for (const refId of requiredIds) {
    if (seen.has(refId)) continue;
    seen.add(refId);

    const records = byRef.get(refId);

    if (!records || records.length === 0) {
      resolutions.push({ refId, status: "absent" });
      continue;
    }

    const winner = pickWinner(records);

    resolutions.push({
      refId,
      status: "present",
      recordId: winner.id,
      scope: winner.source,
    });
  }

  return resolutions;
}
