import "server-only";

import type { Db } from "@/lib/execution-host/db";

import { randomUUID } from "node:crypto";

import { and, asc, eq, isNotNull, notInArray, sql } from "drizzle-orm";

import { eligibleProjectImport } from "./eligible-imports";

import { ADAPTER_IDS } from "@/lib/acp-runners/adapter-support";
import {
  capabilityImports,
  capabilityRecords as records,
  projectPackageAttachments,
  projects,
} from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";

function memberConflict(ref: string): MaisterError {
  return new MaisterError(
    "CONFLICT",
    `Another dependency or catalog entry owns capability "${ref}".`,
    {
      details: { reason: "capability_member_conflict", memberRef: ref },
    },
  );
}

/** Historical material stays installed until a replacement deliberately takes a
 * ref cleared by legacy SET/CLEAR. Only the latest standalone revision owns it. */
function legacyCapabilityOwners(projectId: string, refs: readonly string[]) {
  return sql`SELECT i.id, i.ref, i.resolved_revision, r.id AS "recordId",
    (i.package_status='Removed' OR r.id IS NOT NULL) AS cleared FROM (
      SELECT DISTINCT ON (capability_ref_id) id, capability_ref_id AS ref, version_tag,resolved_revision,package_status
      FROM capability_imports WHERE project_id=${projectId} AND package_install_id IS NULL AND capability_ref_id IN ${refs}
      ORDER BY capability_ref_id,created_at DESC,id
    ) i LEFT JOIN capability_records r ON r.project_id=${projectId} AND r.capability_ref_id=i.ref
      AND r.kind='agent_definition' AND r.source='flow-package' AND r.material='{}'::jsonb
      AND r.version=i.version_tag AND r.revision=i.resolved_revision AND r.disabled_at IS NOT NULL`;
}

/** Retire cleared legacy projections only as part of the committed attachment.
 * Keep native import identity and existing selection records, so a later detach
 * cannot make the predecessor eligible again. */
export async function retireClearedCapabilityOwners(
  tx: Db,
  projectId: string,
  refs: readonly string[],
): Promise<void> {
  if (!refs.length) return;
  await tx.execute(sql`WITH cleared AS (
    SELECT id,"recordId" FROM (${legacyCapabilityOwners(projectId, refs)}) l WHERE cleared
  ), retired AS (
    UPDATE capability_imports i SET package_status='Removed', updated_at=now() FROM cleared c
    WHERE i.id=c.id AND i.package_status<>'Removed'
  ) UPDATE capability_records r SET material=jsonb_build_object('origin','dependency-import','importId',c.id)
    FROM cleared c WHERE r.id=c."recordId"`);
}

export async function assertCapabilityMemberOwnership(
  tx: Db,
  projectId: string,
  memberIds: readonly string[],
  incomingRevision: string,
  priorInstallId?: string,
): Promise<void> {
  if (!memberIds.length) return;
  const result = await tx.execute<{ ref: string }>(sql`
    WITH legacy AS (${legacyCapabilityOwners(projectId, memberIds)})
    SELECT ref FROM legacy WHERE NOT cleared
    UNION ALL SELECT capability_ref_id FROM capability_imports
      WHERE project_id=${projectId} AND capability_ref_id IN ${memberIds}
        AND package_install_id IS NULL AND resolved_revision=${incomingRevision}
    UNION ALL SELECT logical_id FROM project_dependency_declarations
      WHERE project_id=${projectId} AND kind='capability_import' AND logical_id IN ${memberIds}
    UNION ALL SELECT i.capability_ref_id FROM capability_imports i
      JOIN project_package_attachments a ON a.project_id=i.project_id AND a.package_install_id=i.package_install_id
      WHERE i.project_id=${projectId} AND i.capability_ref_id IN ${memberIds}
        ${priorInstallId ? sql`AND i.package_install_id<>${priorInstallId}` : sql``}
    LIMIT 1`);

  if (result.rows[0]) throw memberConflict(result.rows[0].ref);
}

export async function assertStandaloneImportOwnership(
  tx: Db,
  projectId: string,
  ref: string,
): Promise<void> {
  const [prior] = await tx
    .select({ id: capabilityImports.id })
    .from(capabilityImports)
    .where(
      and(
        eq(capabilityImports.projectId, projectId),
        eq(capabilityImports.capabilityRefId, ref),
        isNotNull(capabilityImports.packageInstallId),
      ),
    )
    .limit(1);

  if (prior) throw memberConflict(ref);
}

/** Update only realized bundles. A declaration selects its exact effective revision.
 * Legacy standalone bundles retain the native newest-revision selection. */
export async function reconcileDependencyCatalog(
  tx: Db,
  projectId: string,
): Promise<void> {
  await tx
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.id, projectId))
    .for("update");
  const imports = await tx
    .select()
    .from(capabilityImports)
    .where(eligibleProjectImport(projectId))
    .orderBy(asc(capabilityImports.capabilityRefId));
  const eligible: string[] = [];

  for (const row of imports) {
    const entry = {
      version: row.versionTag,
      revision: row.resolvedRevision,
      material: { origin: "dependency-import", importId: row.id },
      disabledAt: null,
      selectable: true,
      updatedAt: new Date(),
    };
    const written = await tx
      .insert(records)
      .values({
        id: randomUUID(),
        projectId,
        kind: "agent_definition",
        source: "flow-package",
        label: row.capabilityRefId,
        capabilityRefId: row.capabilityRefId,
        agents: [...ADAPTER_IDS],
        ...entry,
      })
      .onConflictDoUpdate({
        target: [
          records.projectId,
          records.source,
          records.kind,
          records.capabilityRefId,
        ],
        set: entry,
        // Historical import projections lacked an origin. Adopt only an exact
        // native version/revision match; other unmarked rows belong to config.
        setWhere: sql`${records.material}->>'origin'='dependency-import' OR
        (${records.material}='{}'::jsonb AND ${records.version}=${row.versionTag} AND ${records.revision}=${row.resolvedRevision})`,
      })
      .returning({ id: records.id });

    if (!written.length) throw memberConflict(row.capabilityRefId);
    eligible.push(written[0].id);
  }
  await tx
    .update(records)
    .set({ disabledAt: new Date(), selectable: false, updatedAt: new Date() })
    .where(
      and(
        eq(records.projectId, projectId),
        sql`(${records.selectable} OR ${records.disabledAt} IS NULL)`,
        sql`${records.material}->>'origin'='dependency-import'`,
        eligible.length ? notInArray(records.id, eligible) : undefined,
      ),
    );
  await refreshProjectPackageSkills(tx, projectId);
}

/** Derive each exported skill from the ready provider(s) in this project. */
export async function refreshProjectPackageSkills(
  tx: Db,
  projectId: string,
): Promise<void> {
  await tx.execute(sql`SELECT refresh_project_package_skills(${projectId})`);
}

export async function refreshAttachedPackageSkills(
  tx: Db,
  installId: string,
): Promise<void> {
  await tx.execute(sql`SELECT refresh_project_package_skills(a.project_id)
    FROM project_package_attachments a WHERE a.package_install_id=${installId} ORDER BY a.project_id`);
}

/** A global package trust decision applies to typed material in all attached projects. */
export async function refreshPackageCapabilityTrust(
  tx: Db,
  installId: string,
): Promise<void> {
  await tx
    .update(records)
    .set({ selectable: true, disabledAt: null, updatedAt: new Date() })
    .where(
      and(
        eq(records.source, "flow-package"),
        sql`${records.kind}<>'skill'`,
        sql`${records.material}->>'origin'='package-attachment' AND ${records.material}->>'packageInstallId'=${installId}`,
        sql`exists (SELECT 1 FROM ${projectPackageAttachments} a JOIN package_installs i ON i.id=a.package_install_id
        WHERE a.project_id=${records.projectId} AND a.package_install_id=${installId}
        AND i.package_status='Installed' AND i.trust_status IN ('trusted','trusted_by_policy'))`,
        sql`(${records.disabledAt} IS NOT NULL OR NOT ${records.selectable})`,
      ),
    );
  await refreshAttachedPackageSkills(tx, installId);
}
