-- Choose the effective native revision before checking readiness. An older
-- trusted version must not substitute for its blocked successor.
CREATE FUNCTION project_ready_capability_imports(target_project text)
RETURNS TABLE(id text, catalog_enabled boolean) LANGUAGE sql STABLE AS $$
  SELECT chosen.id,
    NOT (chosen.legacy_standalone AND EXISTS (
      SELECT 1 FROM capability_records r
      WHERE r.project_id=target_project AND r.capability_ref_id=chosen.capability_ref_id
        AND r.kind='agent_definition' AND r.source='flow-package'
        AND r.version=chosen.version_tag AND r.revision=chosen.resolved_revision
        AND r.material='{}'::jsonb AND r.disabled_at IS NOT NULL
    )) FROM (
    SELECT DISTINCT ON (i.capability_ref_id)
      i.id, i.capability_ref_id, i.version_tag, i.resolved_revision,
      (i.package_install_id IS NULL AND d.id IS NULL) AS legacy_standalone,
      i.package_status, i.trust_status, i.setup_status,
      i.package_install_id, p.trust_status AS supplier_trust, p.package_status AS supplier_status
    FROM capability_imports i
    LEFT JOIN project_dependency_declarations d
      ON d.project_id=i.project_id AND d.kind='capability_import' AND d.logical_id=i.capability_ref_id
    LEFT JOIN project_package_attachments a
      ON a.project_id=i.project_id AND a.package_install_id=i.package_install_id
    LEFT JOIN package_installs p ON p.id=a.package_install_id
    WHERE i.project_id=target_project
      AND ((i.package_install_id IS NULL AND (d.id IS NULL OR i.resolved_revision=d.effective_revision))
           OR a.id IS NOT NULL)
    ORDER BY i.capability_ref_id, i.created_at DESC, i.id
  ) chosen WHERE chosen.package_status='Installed'
    AND chosen.trust_status IN ('trusted','trusted_by_policy')
    AND chosen.setup_status IN ('done','not_required')
    AND (chosen.package_install_id IS NULL OR
         (chosen.supplier_status='Installed' AND chosen.supplier_trust IN ('trusted','trusted_by_policy')))
$$;
--> statement-breakpoint
-- Historical SET/CLEAR import projections used empty material. Prove native
-- ownership using the exact project, kind, source, version and revision.
UPDATE capability_records r
SET material=jsonb_build_object('origin','dependency-import','importId',i.id)
FROM capability_imports i
WHERE r.project_id=i.project_id AND r.capability_ref_id=i.capability_ref_id
  AND r.kind='agent_definition' AND r.source='flow-package' AND r.material='{}'::jsonb
  AND r.version=i.version_tag AND r.revision=i.resolved_revision
  AND r.disabled_at IS NULL;
--> statement-breakpoint
UPDATE capability_records r
SET disabled_at=coalesce(r.disabled_at,now()),selectable=false
WHERE r.material->>'origin'='dependency-import'
  AND NOT EXISTS (SELECT 1 FROM project_ready_capability_imports(r.project_id) e
                  WHERE e.id=r.material->>'importId' AND e.catalog_enabled)
  AND (r.disabled_at IS NULL OR r.selectable);
--> statement-breakpoint
UPDATE capability_records r
SET disabled_at=coalesce(r.disabled_at,now()),selectable=false
WHERE r.material->>'origin'='package-attachment'
  AND NOT EXISTS (SELECT 1 FROM project_package_attachments a JOIN package_installs i ON i.id=a.package_install_id
                  WHERE a.project_id=r.project_id AND i.id=r.material->>'packageInstallId'
                  AND i.package_status='Installed' AND i.trust_status IN ('trusted','trusted_by_policy'))
  AND (r.disabled_at IS NULL OR r.selectable);
