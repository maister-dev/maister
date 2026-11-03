import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { ResolvedCapabilitySet } from "@/lib/db/schema";

import { and, asc, eq, isNull } from "drizzle-orm";

import { capabilityRecords, capabilityImports } from "@/lib/db/schema";
import { buildResolvedCapabilitySet } from "@/lib/capabilities/resolver";
import { loadProjectMcpBindings } from "@/lib/mcp/binding-service";
import { retryDigest } from "@/lib/agents/retry-guards";
import { localDirectoryContentDigest } from "@/lib/flows";
import { MaisterError } from "@/lib/errors";

/** Filesystem hashing is performed only in preflight, outside the acceptance transaction. */
export async function captureTaskLaunchCapabilityBundles(
  db: Db,
  projectId: string,
): Promise<
  ReadonlyArray<
    Readonly<{
      id: string;
      revision: string;
      manifestDigest: string;
      contentDigest: string;
    }>
  >
> {
  const imports = await db
    .select()
    .from(capabilityImports)
    .where(
      and(
        eq(capabilityImports.projectId, projectId),
        eq(capabilityImports.packageStatus, "Installed"),
      ),
    )
    .orderBy(asc(capabilityImports.id))
    .limit(65);

  if (imports.length > 64)
    throw new MaisterError(
      "CONFIG",
      "Task launch exceeds the supported capability bundle count",
      { details: { reason: "launch_input_limit" } },
    );

  return Promise.all(
    imports.map(async (bundle) => ({
      id: bundle.id,
      revision: bundle.resolvedRevision,
      manifestDigest: bundle.manifestDigest,
      contentDigest: await localDirectoryContentDigest(bundle.installedPath),
    })),
  );
}

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
  const imports = await db
    .select({
      id: capabilityImports.id,
      revision: capabilityImports.resolvedRevision,
      manifestDigest: capabilityImports.manifestDigest,
      installedPath: capabilityImports.installedPath,
      setupStatus: capabilityImports.setupStatus,
      trustStatus: capabilityImports.trustStatus,
    })
    .from(capabilityImports)
    .where(
      and(
        eq(capabilityImports.projectId, input.projectId),
        eq(capabilityImports.packageStatus, "Installed"),
      ),
    )
    .orderBy(asc(capabilityImports.id));

  return {
    resolvedCapabilitySet: buildResolvedCapabilitySet({
      records,
      flowRevisionId: input.flowRevisionId,
      flowOrigin: input.flowSource.startsWith("/") ? "authored" : "git",
      mcpBindings: bindings,
    }),
    capabilityResolutionDigest: retryDigest({
      version: 2,
      records,
      bindings,
      imports,
    }),
  };
}
