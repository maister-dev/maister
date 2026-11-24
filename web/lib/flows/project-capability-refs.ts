import "server-only";

import type { CapabilityRefIdSets, CapabilityRefRecord } from "@/lib/config";
import type { FlowYamlV1 } from "@/lib/config.schema";
import type { SqlTransaction } from "@/lib/db/sql-types";

import { inArray, sql } from "drizzle-orm";
import { z } from "zod";

import { capabilityKindSchema } from "@/lib/config.schema";
import {
  capabilityRefIdSetsFromRecords,
  firstUnknownCapabilityRef,
  firstUnknownPackageMcpRef,
} from "@/lib/config";
import {
  capabilityImports,
  capabilityRecords,
  projectDependencyDeclarations,
  projectPackageAttachments,
} from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";

export const emptyCapabilityRefs = capabilityRefIdSetsFromRecords([]);

export function missingFlowCapability(
  manifest: FlowYamlV1,
  refs: CapabilityRefIdSets,
): ReturnType<typeof firstUnknownCapabilityRef> {
  for (const node of manifest.nodes) {
    if (
      node.type === "ai_coding" ||
      node.type === "judge" ||
      node.type === "orchestrator"
    ) {
      const missing = firstUnknownCapabilityRef(node.type, node.settings, refs);

      if (missing) return missing;
    }
  }

  const mcp = firstUnknownPackageMcpRef(manifest.mcps, refs.mcp);

  return mcp ? { kind: "mcp", ref: mcp } : null;
}

const capabilityRefRow = z.object({
  projectId: z.string(),
  capabilityRefId: z.string(),
  kind: capabilityKindSchema,
  source: z.string(),
});

export async function readProjectCapabilityRefs(
  db: SqlTransaction,
  projectIds: string[],
): Promise<ReadonlyMap<string, CapabilityRefIdSets>> {
  const result = await db.execute(sql`
    SELECT project_id AS "projectId", capability_ref_id AS "capabilityRefId", kind, source
    FROM ${capabilityRecords}
    WHERE ${inArray(capabilityRecords.projectId, projectIds)} AND disabled_at IS NULL
  `);
  const rows = capabilityRefRow.array().parse(result.rows);
  const byProject = new Map<string, CapabilityRefRecord[]>();

  for (const row of rows) {
    const group = byProject.get(row.projectId);

    if (group) group.push(row);
    else byProject.set(row.projectId, [row]);
  }

  return new Map(
    Array.from(byProject, ([id, records]) => [
      id,
      capabilityRefIdSetsFromRecords(records),
    ]),
  );
}

export async function assertProjectFlowCapabilities(
  db: SqlTransaction,
  projectId: string,
  manifest: FlowYamlV1,
): Promise<void> {
  if (!missingFlowCapability(manifest, emptyCapabilityRefs)) return;
  const catalog = await readProjectCapabilityRefs(db, [projectId]);
  const missing = missingFlowCapability(
    manifest,
    catalog.get(projectId) ?? emptyCapabilityRefs,
  );

  if (!missing) return;

  // A declared import or an effective package member can become available
  // through installation or trust. An unknown ordinary ref is a manifest
  // configuration error, including references to disabled catalog records.
  const managed = await db.execute(sql`
    SELECT 1 FROM ${projectDependencyDeclarations}
    WHERE project_id=${projectId} AND kind='capability_import' AND logical_id=${missing.ref}
    UNION ALL
    SELECT 1 FROM ${capabilityImports} i
    JOIN ${projectPackageAttachments} a ON a.package_install_id=i.package_install_id AND a.project_id=i.project_id
    WHERE i.project_id=${projectId} AND i.capability_ref_id=${missing.ref}
    UNION ALL
    SELECT 1 FROM ${capabilityRecords} r
    JOIN ${projectPackageAttachments} a ON a.project_id=r.project_id AND a.package_install_id=r.material->>'packageInstallId'
    WHERE r.project_id=${projectId} AND r.kind=${missing.kind} AND r.capability_ref_id=${missing.ref}
      AND r.material->>'origin'='package-attachment'
    LIMIT 1
  `);

  if (!managed.rows.length) {
    throw new MaisterError(
      "CONFIG",
      `Unknown ${missing.kind} capability ref "${missing.ref}" in Flow "${manifest.name}".`,
    );
  }
  throw new MaisterError(
    "PRECONDITION",
    `Flow requires unavailable ${missing.kind} capability "${missing.ref}".`,
    { details: { reason: "flow_capability_unavailable", ref: missing.ref } },
  );
}
