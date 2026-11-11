-- Extend the standalone credential guard to the current reviewed child appointment.
CREATE OR REPLACE FUNCTION guard_company_agent_credential() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' THEN
    IF OLD.company_id IS NULL AND NEW.company_id IS NULL AND OLD.company_run_id IS NULL AND NEW.company_run_id IS NULL THEN RETURN NEW; END IF;
    IF ROW(NEW.id,NEW.company_id,NEW.company_run_id,NEW.project_id,NEW.name,NEW.token_kind,NEW.agent_id,NEW.prefix,NEW.token_hash,NEW.scopes,NEW.expires_at,NEW.created_at)
      IS DISTINCT FROM ROW(OLD.id,OLD.company_id,OLD.company_run_id,OLD.project_id,OLD.name,OLD.token_kind,OLD.agent_id,OLD.prefix,OLD.token_hash,OLD.scopes,OLD.expires_at,OLD.created_at)
      OR (NEW.owner_user_id IS NOT NULL AND NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id)
      OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS NULL) THEN
      RAISE EXCEPTION 'Company run credentials cannot be retargeted, widened or reactivated; rotate the credential'
        USING ERRCODE='23514', CONSTRAINT='project_tokens_company_binding_immutable';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.company_id IS NULL THEN RETURN NEW; END IF;
  IF EXISTS(SELECT 1 FROM runs WHERE id=NEW.company_run_id AND run_kind='flow') THEN
    IF NOT EXISTS (
      SELECT 1 FROM runs execution
      JOIN specialist_run_links link ON link.run_id=execution.id AND link.role='coordinator'
      JOIN specialist_assignments assignment ON assignment.id=link.assignment_id AND assignment.company_id=execution.company_id AND assignment.project_id IS NULL
      JOIN specialist_input_revisions input ON input.assignment_id=assignment.id AND input.revision=link.input_revision
      JOIN company_specialist_bindings binding ON binding.id=assignment.specialist_binding_id AND binding.company_id=execution.company_id AND binding.enabled AND binding.detached_at IS NULL
      JOIN company_specialist_binding_revisions configuration ON configuration.binding_id=binding.id AND configuration.revision=binding.revision
      JOIN package_installs package ON package.id=binding.package_install_id AND package.package_status='Installed' AND package.trust_status IN ('trusted','trusted_by_policy')
      JOIN agents catalog ON catalog.id=binding.agent_id AND catalog.enabled AND catalog.quarantined_at IS NULL
      JOIN users principal ON principal.id=execution.company_execution_snapshot->'authority'->'actor'->>'id' AND principal.account_status='active' AND NOT principal.must_change_password
      JOIN company_flow_bindings coordinator ON coordinator.company_id=execution.company_id AND coordinator.specialist_binding_id=binding.id AND coordinator.package_install_id=package.id AND coordinator.enabled AND coordinator.detached_at IS NULL
      JOIN company_flow_binding_revisions reviewed ON reviewed.binding_id=coordinator.id AND reviewed.revision=coordinator.revision
      JOIN flow_revisions flow ON flow.id=coordinator.flow_revision_id AND flow.id=execution.flow_revision_id AND flow.resolved_revision=execution.flow_revision AND flow.package_status='Installed' AND flow.exec_trust='trusted' AND flow.manifest_digest=reviewed.snapshot->>'manifestSha256'
      JOIN node_attempts node ON node.run_id=execution.id AND node.id=NEW.knowledge_node_attempt_id AND node.node_id=execution.current_step_id AND node.node_type IN ('ai_coding','orchestrator') AND node.status IN ('Running','NeedsInput','Succeeded')
      JOIN company_specialist_bindings persona ON persona.company_id=execution.company_id AND persona.agent_id=node.knowledge_actor->>'agentId' AND persona.enabled AND persona.detached_at IS NULL
      JOIN company_specialist_binding_revisions persona_configuration ON persona_configuration.binding_id=persona.id AND persona_configuration.revision=persona.revision
      JOIN package_installs persona_package ON persona_package.id=persona.package_install_id AND persona_package.id=node.knowledge_actor->>'packageInstallId' AND persona_package.name=node.knowledge_actor->>'packageName' AND persona_package.resolved_revision=persona_configuration.snapshot->>'packageRevision' AND persona_package.package_status='Installed' AND persona_package.trust_status IN ('trusted','trusted_by_policy')
      JOIN agents persona_catalog ON persona_catalog.id=persona.agent_id AND persona_catalog.package_name=persona_package.name AND persona_catalog.enabled AND persona_catalog.quarantined_at IS NULL
      WHERE execution.id=NEW.company_run_id AND execution.company_id=NEW.company_id AND execution.project_id IS NULL AND execution.run_kind='flow'
        AND execution.company_execution_snapshot->>'schemaVersion'='2'
        AND execution.status IN ('Running','NeedsInput','NeedsInputIdle','WaitingOnChildren','HumanWorking')
        AND assignment.status NOT IN ('completed','failed','cancelled')
        AND assignment.id=execution.company_execution_snapshot->'assignment'->>'id'
        AND input.revision::text=execution.company_execution_snapshot->'assignment'->>'inputRevision'
        AND input.digest=execution.company_execution_snapshot->'assignment'->>'inputSha256'
        AND binding.id=execution.company_execution_snapshot->'specialistBinding'->>'id'
        AND binding.revision::text=execution.company_execution_snapshot->'specialistBinding'->>'revision'
        AND configuration.snapshot_digest=execution.company_execution_snapshot->'specialistBinding'->>'snapshotSha256'
        AND binding.agent_id=execution.source_agent_id AND package.resolved_revision=configuration.snapshot->>'packageRevision'
        AND coordinator.id=execution.company_execution_snapshot->'coordinatorFlowBinding'->>'id'
        AND coordinator.revision::text=execution.company_execution_snapshot->'coordinatorFlowBinding'->>'revision'
        AND reviewed.snapshot_digest=execution.company_execution_snapshot->'coordinatorFlowBinding'->>'snapshotSha256'
        AND node.knowledge_actor->'schemaVersion'='1'::jsonb
        AND persona_configuration.snapshot->>'definitionSha256'=node.knowledge_actor->>'definitionSha256'
        AND persona_configuration.snapshot->'definition'->>'kind'<>'operational'
        AND persona_configuration.snapshot->'definition'->>'mode'='session'
        AND persona_configuration.snapshot->'definition'->>'workspace'='none'
        AND NEW.agent_id=persona.agent_id AND NEW.owner_user_id=principal.id
        AND NEW.scopes <@ (configuration.snapshot->'grantActions') AND NEW.scopes <@ (persona_configuration.snapshot->'grantActions')
        AND NOT EXISTS(SELECT 1 FROM node_attempts newer WHERE newer.run_id=node.run_id AND newer.node_id=node.node_id AND newer.attempt>node.attempt)
        AND EXISTS(SELECT 1 FROM company_grants g WHERE g.company_id=NEW.company_id AND g.principal_type='user' AND g.principal_id=principal.id AND g.action='assignments:read' AND g.revoked_at IS NULL)
        AND EXISTS(SELECT 1 FROM company_grants g WHERE g.company_id=NEW.company_id AND g.principal_type='user' AND g.principal_id=principal.id AND g.action='assignments:update' AND g.revoked_at IS NULL)
    ) THEN
      RAISE EXCEPTION 'Company graph credentials require the exact current node, professional, coordinator, input and initiating authority'
        USING ERRCODE='23514', CONSTRAINT='project_tokens_company_reference_check';
    END IF;
    RETURN NEW;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM runs execution
    JOIN specialist_run_links link ON link.run_id=execution.id
    JOIN specialist_assignments assignment ON assignment.id=link.assignment_id AND assignment.company_id=execution.company_id
    JOIN specialist_input_revisions input ON input.assignment_id=assignment.id AND input.revision=link.input_revision
    LEFT JOIN specialist_work work ON work.id=link.work_id AND work.work_revision=link.work_revision
      AND work.assignment_id=assignment.id AND work.input_revision=input.revision AND work.input_sha256=input.digest
      AND work.child_run_id=execution.id AND work.reserved_run_id=execution.id AND work.parent_run_id=execution.parent_run_id
    JOIN company_specialist_bindings binding ON binding.id=(CASE WHEN link.work_id IS NULL
      THEN assignment.specialist_binding_id ELSE work.definition->'target'->'specialistBinding'->>'id' END)
      AND binding.company_id=execution.company_id AND binding.enabled AND binding.detached_at IS NULL
    JOIN company_specialist_binding_revisions configuration ON configuration.binding_id=binding.id AND configuration.revision=binding.revision
    JOIN package_installs package ON package.id=binding.package_install_id AND package.package_status='Installed' AND package.trust_status IN ('trusted','trusted_by_policy')
    JOIN agents catalog ON catalog.id=binding.agent_id AND catalog.enabled AND catalog.quarantined_at IS NULL
    JOIN users principal ON principal.id=execution.company_execution_snapshot->'authority'->'actor'->>'id' AND principal.account_status='active' AND NOT principal.must_change_password
    WHERE execution.id=NEW.company_run_id AND execution.company_id=NEW.company_id AND execution.project_id IS NULL AND execution.run_kind='agent' AND NEW.knowledge_node_attempt_id IS NULL
      AND execution.status IN ('Running','NeedsInput','NeedsInputIdle','WaitingOnChildren','HumanWorking')
      AND assignment.status NOT IN ('completed','failed','cancelled')
      AND assignment.id=execution.company_execution_snapshot->'assignment'->>'id'
      AND input.revision::numeric=(execution.company_execution_snapshot->'assignment'->>'inputRevision')::numeric
      AND input.digest=execution.company_execution_snapshot->'assignment'->>'inputSha256'
      AND binding.id=execution.company_execution_snapshot->'specialistBinding'->>'id'
      AND binding.revision::numeric=(execution.company_execution_snapshot->'specialistBinding'->>'revision')::numeric
      AND configuration.snapshot_digest=execution.company_execution_snapshot->'specialistBinding'->>'snapshotSha256'
      AND package.resolved_revision=configuration.snapshot->>'packageRevision'
      AND NEW.agent_id=binding.agent_id AND NEW.agent_id=execution.source_agent_id AND NEW.owner_user_id=principal.id
      AND (
        link.work_id IS NULL
        OR (link.role='child' AND work.decision_state='open'
          AND work.definition->'target'->>'kind'='company_agent'
          AND specialist_run_has_input(execution.id,assignment.id,input.revision,input.digest)
          AND specialist_work_target_exists(work.definition->'target',execution.company_id,NULL)
          AND configuration.snapshot->'grantActions' ? 'assignments:read'
          AND EXISTS(
            SELECT 1 FROM company_grants receiving_grant
            WHERE receiving_grant.company_id=execution.company_id AND receiving_grant.principal_type='agent'
              AND receiving_grant.principal_id=binding.agent_id AND receiving_grant.action='assignments:read'
              AND receiving_grant.revoked_at IS NULL
          ))
      )
      AND NEW.scopes <@ (configuration.snapshot->'grantActions')
      AND EXISTS(SELECT 1 FROM company_grants g WHERE g.company_id=NEW.company_id AND g.principal_type='user' AND g.principal_id=principal.id AND g.action='assignments:read' AND g.revoked_at IS NULL)
      AND EXISTS(SELECT 1 FROM company_grants g WHERE g.company_id=NEW.company_id AND g.principal_type='user' AND g.principal_id=principal.id AND g.action='assignments:update' AND g.revoked_at IS NULL)
  ) THEN
    RAISE EXCEPTION 'Company run credentials require the current exact owned execution, input, configuration and initiating authority'
      USING ERRCODE='23514', CONSTRAINT='project_tokens_company_reference_check';
  END IF;
  RETURN NEW;
END;
$$;
