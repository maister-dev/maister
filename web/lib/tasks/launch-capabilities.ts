import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { ResolvedCapabilitySet } from "@/lib/db/schema";

import { and, asc, eq, isNull } from "drizzle-orm";

import { capabilityRecords } from "@/lib/db/schema";
import { buildResolvedCapabilitySet } from "@/lib/capabilities/resolver";
import { loadProjectMcpBindings } from "@/lib/mcp/binding-service";
import { retryDigest } from "@/lib/agents/retry-guards";

/** Retain reference identities and a configuration fence, never copy capability material or credentials. */
export async function resolveTaskLaunchCapabilities(
  db: Db,
  input: {
    projectId: string;
    flowRevisionId: string;
    flowSource: string;
  },
): Promise<{
  resolvedCapabilitySet: ResolvedCapabilitySet;
  capabilityResolutionDigest: string;
}> {
  const records = await db
    .select({
      id: capabilityRecords.id,
      capabilityRefId: capabilityRecords.capabilityRefId,
      kind: capabilityRecords.kind,
      source: capabilityRecords.source,
      revision: capabilityRecords.revision,
      agents: capabilityRecords.agents,
      material: capabilityRecords.material,
      enforceability: capabilityRecords.enforceability,
      selectedByDefault: capabilityRecords.selectedByDefault,
    })
    .from(capabilityRecords)
    .where(
      and(
        eq(capabilityRecords.projectId, input.projectId),
        isNull(capabilityRecords.disabledAt),
      ),
    )
    .orderBy(
      asc(capabilityRecords.kind),
      asc(capabilityRecords.capabilityRefId),
      asc(capabilityRecords.source),
      asc(capabilityRecords.id),
    );
  const bindings = [
    ...(await loadProjectMcpBindings(input.projectId, db)),
  ].sort((a, b) => a.refId.localeCompare(b.refId));

  return {
    resolvedCapabilitySet: buildResolvedCapabilitySet({
      records,
      flowRevisionId: input.flowRevisionId,
      flowOrigin: input.flowSource.startsWith("/") ? "authored" : "git",
      mcpBindings: bindings,
    }),
    capabilityResolutionDigest: retryDigest({ version: 1, records, bindings }),
  };
}
