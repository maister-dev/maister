import "server-only";

import type { Db } from "@/lib/execution-host/db";

import { randomUUID } from "node:crypto";

import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNotNull,
  notInArray,
  sql,
} from "drizzle-orm";

import { ADAPTER_IDS } from "@/lib/acp-runners/adapter-support";
import {
  capabilityImports,
  capabilityRecords as records,
  projectDependencyDeclarations as declarations,
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
    .select({
      row: capabilityImports,
      head: declarations.id,
      effective: declarations.effectiveRevision,
      attached: projectPackageAttachments.id,
    })
    .from(capabilityImports)
    .leftJoin(
      declarations,
      and(
        eq(declarations.projectId, capabilityImports.projectId),
        eq(declarations.kind, "capability_import"),
        eq(declarations.logicalId, capabilityImports.capabilityRefId),
      ),
    )
    .leftJoin(
      projectPackageAttachments,
      and(
        eq(projectPackageAttachments.projectId, capabilityImports.projectId),
        eq(
          projectPackageAttachments.packageInstallId,
          capabilityImports.packageInstallId,
        ),
      ),
    )
    .where(eq(capabilityImports.projectId, projectId))
    .orderBy(
      asc(capabilityImports.capabilityRefId),
      desc(capabilityImports.createdAt),
      asc(capabilityImports.id),
    );
  const seen = new Set<string>();
  const eligible: string[] = [];
  for (const { row, head, effective, attached } of imports) {
    if (row.packageInstallId && !attached) continue;
    if (!row.packageInstallId && head && row.resolvedRevision !== effective)
      continue;
    if (seen.has(row.capabilityRefId)) continue;
    seen.add(row.capabilityRefId);
    if (
      row.packageStatus !== "Installed" ||
      row.trustStatus === "untrusted" ||
      (row.setupStatus !== "done" && row.setupStatus !== "not_required")
    )
      continue;
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
        eq(records.selectable, true),
        sql`${records.material}->>'origin'='dependency-import'`,
        eligible.length ? notInArray(records.id, eligible) : undefined,
      ),
    );
}
