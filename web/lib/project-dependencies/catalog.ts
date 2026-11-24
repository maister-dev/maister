import "server-only";

import type { Db } from "@/lib/execution-host/db";

import { randomUUID } from "node:crypto";

import { and, asc, eq, inArray, isNotNull, notInArray, sql } from "drizzle-orm";

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

export async function assertCapabilityMemberOwnership(
  tx: Db,
  projectId: string,
  memberIds: readonly string[],
  priorInstallId?: string,
): Promise<void> {
  if (!memberIds.length) return;
  const [prior] = await tx
    .select({ ref: capabilityImports.capabilityRefId })
    .from(capabilityImports)
    .where(
      and(
        eq(capabilityImports.projectId, projectId),
        inArray(capabilityImports.capabilityRefId, [...memberIds]),
        priorInstallId
          ? sql`${capabilityImports.packageInstallId} IS DISTINCT FROM ${priorInstallId}`
          : undefined,
      ),
    )
    .limit(1);

  if (prior) throw memberConflict(prior.ref);
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
        sql`${records.material}->>'origin'='package-attachment' AND ${records.material}->>'packageInstallId'=${installId}`,
        sql`exists (SELECT 1 FROM ${projectPackageAttachments} a JOIN package_installs i ON i.id=a.package_install_id
        WHERE a.project_id=${records.projectId} AND a.package_install_id=${installId}
        AND i.package_status='Installed' AND i.trust_status IN ('trusted','trusted_by_policy'))`,
        sql`(${records.disabledAt} IS NOT NULL OR NOT ${records.selectable})`,
      ),
    );
}
