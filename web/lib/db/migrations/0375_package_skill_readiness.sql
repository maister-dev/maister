-- Typed skills come from individual capability members. Shared skills need one
-- eligible provider; a flat legacy inventory proves availability only when
-- every declared provider is ready.
CREATE FUNCTION refresh_project_package_skills(target_project text)
RETURNS void LANGUAGE sql AS $$
  SELECT pg_advisory_xact_lock(hashtextextended('project-package-skills:' || target_project, 0));
  WITH attached AS MATERIALIZED (
    SELECT p.id, p.manifest
    FROM project_package_attachments a JOIN package_installs p ON p.id=a.package_install_id
    WHERE a.project_id=target_project AND p.package_status='Installed'
      AND p.trust_status IN ('trusted','trusted_by_policy')
  ), ready_members AS MATERIALIZED (
    SELECT i.package_install_id AS package_id, i.capability_ref_id AS member
    FROM project_ready_capability_imports(target_project) e
    JOIN capability_imports i ON i.id=e.id
    WHERE e.catalog_enabled AND i.package_install_id IS NOT NULL
  ), available AS (
    SELECT p.id, s.skill FROM attached p JOIN ready_members m ON m.package_id=p.id
    CROSS JOIN LATERAL jsonb_array_elements_text(p.manifest->'inventory'->'skillsByCapability'->m.member) s(skill)
    UNION
    SELECT p.id, s.skill FROM attached p
    CROSS JOIN LATERAL jsonb_array_elements_text(p.manifest->'inventory'->'skills') s(skill)
    WHERE p.manifest->'inventory'->'skillsByCapability' IS NULL
      AND jsonb_array_length(p.manifest->'spec'->'capabilities')>0
      AND NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(p.manifest->'spec'->'capabilities') c
        WHERE NOT EXISTS (SELECT 1 FROM ready_members m WHERE m.package_id=p.id AND m.member=c->>'id')
      )
  ), eligibility AS (
    SELECT r.id, EXISTS(SELECT 1 FROM available s WHERE s.id=r.material->>'packageInstallId'
      AND s.skill=r.capability_ref_id) AS ready
    FROM capability_records r WHERE r.project_id=target_project AND r.kind='skill'
      AND r.source='flow-package' AND r.material->>'origin'='package-attachment'
  )
  UPDATE capability_records r SET selectable=e.ready,
    disabled_at=CASE WHEN e.ready THEN NULL ELSE coalesce(r.disabled_at,now()) END,updated_at=now()
  FROM eligibility e WHERE r.id=e.id AND (r.selectable<>e.ready OR (r.disabled_at IS NULL)<>e.ready)
$$;
--> statement-breakpoint
SELECT refresh_project_package_skills(p.project_id)
FROM (SELECT DISTINCT project_id FROM capability_records
  WHERE source='flow-package' AND kind='skill' AND material->>'origin'='package-attachment') p;
