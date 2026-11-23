import "server-only";

import type { ProjectDependencyView } from "./view";
import type { getDb } from "@/lib/db/client";

import { sql } from "drizzle-orm";

import { assertDependencySource } from "./source";

type DbReader = Pick<ReturnType<typeof getDb>, "execute">;

/** One statement observes the desired generation, latest attempt and effective trust together. */
export async function readProjectDeclarations(
  db: DbReader,
  projectId: string,
  mayInstall: boolean,
  declarationId?: string,
): Promise<ProjectDependencyView[]> {
  const result = await db.execute<Omit<ProjectDependencyView, "actions">>(sql`
    SELECT d.id, d.kind, d.logical_id AS ref, d.generation,
      d.desired->>'source' AS source, d.desired->>'version' AS version,
      d.desired->>'path' AS path, a.attempt_no AS attempt, a.status AS state,
      a.stage, a.reason, a.member_ref AS "memberRef", a.resolved_revision AS "resolvedRevision",
      CASE WHEN pi.id IS NOT NULL THEN p.id WHEN fr.id IS NOT NULL THEN f.id ELSE c.id END AS "effectiveAttachmentId",
      coalesce(pi.resolved_revision, fr.resolved_revision, c.resolved_revision) AS "effectiveRevision",
      CASE WHEN (d.effective_generation IS NULL OR d.effective_generation = d.generation)
                  AND a.status = 'recovery_required' THEN 'recovery_required'
        WHEN (d.effective_generation IS NULL OR d.effective_generation = d.generation)
                  AND a.status = 'failed' AND a.stage = 'setup' THEN 'setup_failed'
        WHEN coalesce(pi.id, fr.id, c.id) IS NULL THEN 'unresolved'
        WHEN fr.setup_status = 'failed' OR c.setup_status = 'failed' OR
          (pi.id IS NOT NULL AND (
            EXISTS (SELECT 1 FROM flows mf JOIN flow_revisions mr
              ON mr.flow_ref_id = mf.flow_ref_id AND mr.resolved_revision = mf.revision
              WHERE mf.project_id = d.project_id AND mf.package_install_id = pi.id AND mr.setup_status = 'failed')
            OR EXISTS (SELECT 1 FROM capability_imports mc WHERE mc.project_id = d.project_id
              AND mc.package_install_id = pi.id AND mc.setup_status = 'failed')
          )) THEN 'setup_failed'
        WHEN coalesce(pi.package_status, fr.package_status, c.package_status) <> 'Installed' THEN 'unresolved'
        WHEN coalesce(pi.trust_status, f.trust_status, c.trust_status) = 'untrusted' THEN 'awaiting_trust'
        ELSE 'installed' END AS readiness
    FROM project_dependency_declarations d
    LEFT JOIN LATERAL (
      SELECT * FROM project_dependency_attempts
      WHERE declaration_id = d.id AND generation = d.generation
      ORDER BY attempt_no DESC LIMIT 1
    ) a ON true
    LEFT JOIN project_package_attachments p ON p.id = d.effective_attachment_id AND p.project_id = d.project_id
    LEFT JOIN package_installs pi ON pi.id = p.package_install_id AND pi.resolved_revision = d.effective_revision
    LEFT JOIN flows f ON d.kind = 'flow' AND f.project_id = d.project_id AND f.flow_ref_id = d.logical_id AND f.revision = d.effective_revision
    LEFT JOIN flow_revisions fr ON fr.flow_ref_id = f.flow_ref_id AND fr.resolved_revision = f.revision
    LEFT JOIN capability_imports c ON d.kind = 'capability_import' AND c.project_id = d.project_id AND c.capability_ref_id = d.logical_id AND c.resolved_revision = d.effective_revision
    WHERE d.project_id = ${projectId} ${declarationId === undefined ? sql`` : sql`AND d.id = ${declarationId}`}
    ORDER BY CASE d.kind WHEN 'flow' THEN 1 WHEN 'package' THEN 2 ELSE 3 END, d.ordinal, d.logical_id
  `);

  return result.rows.map((row) => {
    assertDependencySource(row.source);

    return {
      ...row,
      actions: {
        edit: mayInstall && row.kind === "package",
        retry: mayInstall && row.state === "failed",
        recoverSetup:
          mayInstall &&
          row.state === "recovery_required" &&
          !!row.memberRef &&
          !!row.resolvedRevision,
      },
    };
  });
}
