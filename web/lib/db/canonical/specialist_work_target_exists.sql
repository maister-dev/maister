CREATE OR REPLACE FUNCTION public.specialist_work_target_exists(target jsonb, company_owner text, project_owner text)
 RETURNS boolean
 LANGUAGE sql
 STABLE
AS $function$
  SELECT CASE target->>'kind'
    WHEN 'project_agent' THEN project_owner IS NOT NULL AND company_owner IS NULL AND target->>'projectId'=project_owner AND EXISTS (
      SELECT 1 FROM agent_project_links link JOIN agents role ON role.id=link.agent_id
      JOIN package_installs pin ON pin.id=target->'role'->>'packageInstallId' AND pin.name=role.package_name
      JOIN project_package_attachments attachment ON attachment.project_id=link.project_id AND attachment.package_install_id=pin.id
      WHERE link.id=target->>'attachmentId' AND link.project_id=project_owner AND link.enabled
        AND link.agent_id=target->'role'->>'agentId' AND pin.resolved_revision=target->'role'->>'packageRevision'
        AND pin.package_status='Installed' AND pin.trust_status='trusted'
    )
    WHEN 'project_flow' THEN project_owner IS NOT NULL AND company_owner IS NULL AND target->>'projectId'=project_owner AND EXISTS (
      SELECT 1 FROM flows flow JOIN flow_revisions revision ON revision.flow_ref_id=flow.flow_ref_id
      WHERE flow.id=target->>'flowId' AND flow.project_id=project_owner
        AND revision.id=target->'flow'->>'flowRevisionId' AND revision.flow_ref_id=target->'flow'->>'flowRefId'
        AND revision.resolved_revision=target->'flow'->>'resolvedRevision' AND revision.manifest_digest=target->'flow'->>'manifestSha256'
    )
    WHEN 'company_agent' THEN company_owner IS NOT NULL AND project_owner IS NULL AND target->>'companyId'=company_owner AND EXISTS (
      SELECT 1 FROM company_specialist_bindings binding JOIN company_specialist_binding_revisions history
        ON history.binding_id=binding.id AND history.revision=binding.revision
      JOIN package_installs pin ON pin.id=binding.package_install_id
      WHERE binding.id=target->'specialistBinding'->>'id' AND binding.company_id=company_owner AND binding.enabled AND binding.detached_at IS NULL
        AND binding.revision::text=target->'specialistBinding'->>'revision' AND history.snapshot_digest=target->'specialistBinding'->>'snapshotSha256'
        AND history.snapshot->>'agentId'=target->'role'->>'agentId' AND history.snapshot->>'packageInstallId'=target->'role'->>'packageInstallId'
        AND history.snapshot->>'packageRevision'=target->'role'->>'packageRevision' AND history.snapshot->>'definitionSha256'=target->'role'->>'definitionSha256'
        AND pin.package_status='Installed' AND pin.trust_status='trusted'
    )
    WHEN 'company_flow' THEN company_owner IS NOT NULL AND project_owner IS NULL AND target->>'companyId'=company_owner AND EXISTS (
      SELECT 1 FROM company_flow_bindings flow JOIN company_flow_binding_revisions history ON history.binding_id=flow.id AND history.revision=flow.revision
      JOIN company_specialist_bindings binding ON binding.id=flow.specialist_binding_id AND binding.company_id=flow.company_id
      JOIN company_specialist_binding_revisions role ON role.binding_id=binding.id AND role.revision=binding.revision
      JOIN flow_revisions revision ON revision.id=flow.flow_revision_id
      JOIN package_installs pin ON pin.id=flow.package_install_id
      WHERE flow.id=target->'coordinatorBinding'->>'id' AND flow.company_id=company_owner AND flow.enabled AND flow.detached_at IS NULL
        AND flow.revision::text=target->'coordinatorBinding'->>'revision' AND history.snapshot_digest=target->'coordinatorBinding'->>'snapshotSha256'
        AND binding.id=target->'specialistBinding'->>'id' AND binding.enabled AND binding.detached_at IS NULL
        AND binding.revision::text=target->'specialistBinding'->>'revision' AND role.snapshot_digest=target->'specialistBinding'->>'snapshotSha256'
        AND role.snapshot->>'agentId'=target->'role'->>'agentId' AND role.snapshot->>'packageInstallId'=target->'role'->>'packageInstallId'
        AND role.snapshot->>'packageRevision'=target->'role'->>'packageRevision' AND role.snapshot->>'definitionSha256'=target->'role'->>'definitionSha256'
        AND revision.id=target->'flow'->>'flowRevisionId' AND revision.flow_ref_id=target->'flow'->>'flowRefId'
        AND revision.resolved_revision=target->'flow'->>'resolvedRevision' AND revision.manifest_digest=target->'flow'->>'manifestSha256'
        AND pin.package_status='Installed' AND pin.trust_status='trusted'
    ) ELSE false END
$function$;
