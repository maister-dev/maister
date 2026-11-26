CREATE OR REPLACE FUNCTION public.project_ready_capability_imports(target_project text)
 RETURNS TABLE(id text, catalog_enabled boolean)
 LANGUAGE sql
 STABLE
AS $function$
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
$function$;
