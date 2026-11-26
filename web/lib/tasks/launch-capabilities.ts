import "server-only";

import type { FlowDeliverySnapshot } from "@/lib/capabilities/package-delivery";
import type { PackageDeliveryCapture } from "@/lib/capabilities/capture-package-delivery";
import type { Db } from "@/lib/execution-host/db";
import type { ResolvedCapabilitySet } from "@/lib/db/schema";

import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";

import { eligibleProjectImport } from "@/lib/project-dependencies/eligible-imports";
import { capabilityRecords, capabilityImports } from "@/lib/db/schema";
import { capturePackageDelivery } from "@/lib/capabilities/capture-package-delivery";
import { includeCapturedPlatformMcpTargets } from "@/lib/capabilities/package-delivery";
import { buildResolvedCapabilitySet } from "@/lib/capabilities/resolver";
import { loadProjectMcpBindings } from "@/lib/mcp/binding-service";
import { retryDigest } from "@/lib/agents/retry-guards";
import { localDirectoryContentDigest } from "@/lib/flows";
import { MaisterError } from "@/lib/errors";

export function taskLaunchCapabilityChanged(cause?: unknown): MaisterError {
  return new MaisterError(
    "PRECONDITION",
    "The selected capability bundle cannot be reproduced; review the installed bundle and launch again",
    {
      details: {
        reason: "launch_capabilities_changed",
        stage: "capability_capture",
      },
      ...(cause === undefined ? {} : { cause }),
    },
  );
}

async function capabilityContentDigest(directory: string): Promise<string> {
  try {
    return await localDirectoryContentDigest(directory);
  } catch (cause) {
    throw taskLaunchCapabilityChanged(cause);
  }
}

/** Filesystem hashing is performed only in preflight, outside the acceptance transaction. */
export async function captureTaskLaunchCapabilityBundles(
  db: Db,
  projectId: string,
  acceptedIds?: readonly string[],
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
  if (acceptedIds?.length === 0) return [];
  const imports = await db
    .select()
    .from(capabilityImports)
    .where(
      and(
        eligibleProjectImport(projectId),
        acceptedIds && inArray(capabilityImports.id, [...acceptedIds]),
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
      contentDigest: await capabilityContentDigest(bundle.installedPath),
    })),
  );
}

/** Package attachment revisions may advance after binding. The original release grant and independent project policy still govern dispatch. */
export async function taskLaunchBoundCapabilityAuthority(
  db: Db,
  projectId: string,
  delivery: FlowDeliverySnapshot,
): Promise<string> {
  const pins = delivery.packages
    .filter((p) => !p.installId.startsWith("import:"))
    .map((p) => p.installId);
  const { rows } = await db.execute(sql`
    SELECT
      (SELECT jsonb_agg(jsonb_build_array(i.id,i.name,i.resolved_revision,i.manifest_digest,i.package_status,i.trust_status) ORDER BY i.id)
         FROM package_installs i JOIN project_package_attachments a ON a.project_id=${projectId} AND a.package_name=i.name
        WHERE i.id=ANY(${sql.param(pins)}::text[])) AS releases,
      (SELECT jsonb_agg(jsonb_build_array(c.id,c.kind,c.source,c.capability_ref_id,c.revision,c.agents,c.enforceability,c.selected_by_default,c.selectable,c.material) ORDER BY c.id)
         FROM capability_records c WHERE c.project_id=${projectId} AND c.disabled_at IS NULL
         AND (c.source<>'flow-package' OR (
           c.material->>'packageInstallId' IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM capability_imports i
             WHERE c.material->>'origin'='dependency-import' AND i.project_id=c.project_id
               AND i.id=c.material->>'importId' AND i.package_install_id IS NOT NULL
           )
         ))) AS records,
      (SELECT jsonb_agg(jsonb_build_array(b.ref_id,b.target_kind,b.target_id,b.enabled,b.config_overlay) ORDER BY b.ref_id)
         FROM project_mcp_bindings b WHERE b.project_id=${projectId} AND b.target_kind<>'package') AS bindings,
      (SELECT jsonb_agg(jsonb_build_array(i.id,i.resolved_revision,i.manifest_digest,i.installed_path,i.setup_status,i.trust_status) ORDER BY i.id)
         FROM capability_imports i WHERE i.project_id=${projectId} AND i.package_status='Installed' AND i.package_install_id IS NULL) AS imports
  `);

  return retryDigest(rows[0]);
}

/** Retain reference identities and a configuration fence, never copy capability material or credentials. */
export async function resolveTaskLaunchCapabilities(
  db: Db,
  input: {
    projectId: string;
    flowRevisionId: string;
    flowSource: string;
    flowPackageInstallId: string | null;
    flowManifest: unknown;
    historical?: true;
  },
  captureDelivery: PackageDeliveryCapture = capturePackageDelivery,
): Promise<{
  resolvedCapabilitySet: ResolvedCapabilitySet;
  capabilityResolutionDigest: string;
  boundCapabilityAuthorityDigest?: string;
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
    .where(eligibleProjectImport(input.projectId))
    .orderBy(asc(capabilityImports.id));

  const delivery = input.historical
    ? undefined
    : await captureDelivery(db, {
        projectId: input.projectId,
        flowPackageInstallId: input.flowPackageInstallId,
        flowManifest: input.flowManifest,
        nonPackageMcpRefs: records
          .filter(
            (r) =>
              r.kind === "mcp" &&
              r.selectedByDefault &&
              r.source !== "flow-package",
          )
          .map((r) => r.capabilityRefId),
      });

  return {
    resolvedCapabilitySet: {
      ...buildResolvedCapabilitySet({
        records: includeCapturedPlatformMcpTargets(records, delivery),
        flowRevisionId: input.flowRevisionId,
        flowOrigin: input.flowSource.startsWith("/") ? "authored" : "git",
        mcpBindings: bindings,
      }),
      ...(delivery ? { delivery } : {}),
    },
    ...(delivery && {
      boundCapabilityAuthorityDigest: await taskLaunchBoundCapabilityAuthority(
        db,
        input.projectId,
        delivery,
      ),
    }),
    capabilityResolutionDigest: retryDigest({
      version: 2,
      ...(delivery ? { delivery } : {}),
      records,
      bindings,
      imports,
    }),
  };
}
