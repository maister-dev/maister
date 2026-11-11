-- Permit an exact result-only company Flow child and its existing node credentials.
CREATE OR REPLACE FUNCTION guard_company_agent_execution() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s jsonb;
BEGIN
  IF TG_OP='UPDATE' THEN
    IF OLD.company_execution_snapshot->'schemaVersion'='2'::jsonb
       AND ROW(NEW.flow_version,NEW.flow_revision) IS DISTINCT FROM ROW(OLD.flow_version,OLD.flow_revision) THEN
      RAISE EXCEPTION 'Company graph source version witnesses are immutable'
        USING ERRCODE='23514', CONSTRAINT='runs_company_execution_immutable';
    END IF;
    IF OLD.company_id IS NULL AND NEW.company_id IS NULL AND OLD.company_execution_snapshot IS NULL AND NEW.company_execution_snapshot IS NULL THEN RETURN NEW; END IF;
    IF (NEW.created_by_user_id IS NOT NULL AND NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id) OR ROW(NEW.company_id,NEW.company_execution_snapshot,NEW.project_id,NEW.task_id,NEW.flow_id,NEW.flow_revision_id,NEW.local_package_id,NEW.run_kind,NEW.source_agent_id,NEW.agent_kind,NEW.agent_workspace,NEW.result_contract,NEW.agent_config,NEW.execution_policy,NEW.parent_run_id,NEW.root_run_id)
      IS DISTINCT FROM ROW(OLD.company_id,OLD.company_execution_snapshot,OLD.project_id,OLD.task_id,OLD.flow_id,OLD.flow_revision_id,OLD.local_package_id,OLD.run_kind,OLD.source_agent_id,OLD.agent_kind,OLD.agent_workspace,OLD.result_contract,OLD.agent_config,OLD.execution_policy,OLD.parent_run_id,OLD.root_run_id) THEN
      RAISE EXCEPTION 'Company execution ownership and launch contracts are immutable'
        USING ERRCODE='23514', CONSTRAINT='runs_company_execution_immutable';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.company_id IS NULL THEN RETURN NEW; END IF;
  IF NEW.status <> 'Pending' THEN
    RAISE EXCEPTION 'Company execution must enter the existing Pending admission lifecycle'
      USING ERRCODE='23514', CONSTRAINT='runs_company_execution_reference_check';
  END IF;
  s := NEW.company_execution_snapshot;
  IF s->'schemaVersion' IS DISTINCT FROM '1'::jsonb AND s->'schemaVersion' IS DISTINCT FROM '2'::jsonb THEN
    RAISE EXCEPTION 'Company execution capture version is unsupported'
      USING ERRCODE='23514', CONSTRAINT='runs_company_execution_reference_check';
  END IF;
  IF jsonb_typeof(s->'assignmentRevision') IS DISTINCT FROM 'number'
     OR jsonb_typeof(s->'assignment'->'inputRevision') IS DISTINCT FROM 'number'
     OR jsonb_typeof(s->'specialistBinding'->'revision') IS DISTINCT FROM 'number'
     OR jsonb_typeof(s->'authority'->'witness'->'revision') IS DISTINCT FROM 'number' THEN
    RAISE EXCEPTION 'Company execution requires numeric configuration, input and authority revisions'
      USING ERRCODE='23514', CONSTRAINT='runs_company_execution_reference_check';
  END IF;
  IF NEW.parent_run_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM specialist_work work
      JOIN specialist_assignments assignment ON assignment.id=work.assignment_id
      JOIN specialist_input_revisions input ON input.assignment_id=assignment.id AND input.revision=work.input_revision
      JOIN runs parent ON parent.id=work.parent_run_id AND parent.company_id=assignment.company_id
      JOIN company_specialist_bindings binding ON binding.id=s->'specialistBinding'->>'id' AND binding.company_id=assignment.company_id
      JOIN company_specialist_binding_revisions reviewed ON reviewed.binding_id=binding.id AND reviewed.revision=binding.revision
      JOIN users initiator ON initiator.id=parent.company_execution_snapshot->'authority'->'actor'->>'id'
        AND initiator.account_status='active' AND NOT initiator.must_change_password
      JOIN company_grants launch_grant ON launch_grant.company_id=assignment.company_id
        AND launch_grant.principal_type='user' AND launch_grant.principal_id=initiator.id
        AND launch_grant.action='assignments:update' AND launch_grant.revoked_at IS NULL
      JOIN company_grants receiving_grant ON receiving_grant.company_id=assignment.company_id
        AND receiving_grant.principal_type='agent' AND receiving_grant.principal_id=binding.agent_id
        AND receiving_grant.action='assignments:read' AND receiving_grant.revoked_at IS NULL
      WHERE work.reserved_run_id=NEW.id AND work.child_run_id IS NULL AND work.decision_state='open'
        AND work.parent_run_id=NEW.parent_run_id AND NEW.root_run_id=coalesce(parent.root_run_id,parent.id)
        AND parent.status='Running' AND parent.project_id IS NULL
        AND assignment.company_id=NEW.company_id AND assignment.project_id IS NULL
        AND assignment.status IN ('active','waiting_children')
        AND s->'assignment'->>'id'=assignment.id AND s->'assignmentRevision'=to_jsonb(assignment.revision)
        AND s->'assignment'->'inputRevision'=to_jsonb(input.revision) AND s->'assignment'->>'inputSha256'=input.digest
        AND work.input_sha256=input.digest AND specialist_run_has_input(parent.id,assignment.id,input.revision,input.digest)
        AND work.definition->'target'->'specialistBinding'=s->'specialistBinding'
        AND specialist_work_target_exists(work.definition->'target',NEW.company_id,NULL)
        AND reviewed.snapshot->'grantActions' ? 'assignments:read'
        AND binding.agent_id=NEW.agent_id AND binding.agent_id=NEW.source_agent_id
        AND NEW.created_by_user_id=initiator.id AND s->'authority'->'actor'->>'id'=initiator.id
        AND launch_grant.id=s->'authority'->'witness'->>'authorityId'
        AND to_jsonb(launch_grant.revision)=s->'authority'->'witness'->'revision'
        AND coalesce(NEW.agent_config,'{}'::jsonb)=reviewed.snapshot->'effectiveConfiguration'
        AND NEW.execution_policy=reviewed.snapshot->'executionPolicy'
        AND NEW.agent_activity_snapshot->>'agentId'=binding.agent_id
        AND NEW.agent_activity_snapshot->>'definitionSha256'=reviewed.snapshot->>'definitionSha256'
        AND NEW.agent_activity_snapshot->>'packageInstallId'=binding.package_install_id
        AND (
          (s->'schemaVersion'='1'::jsonb AND NEW.run_kind='agent' AND work.definition->'target'->>'kind'='company_agent'
            AND reviewed.snapshot->'definition'=NEW.result_contract->'definition'
            AND binding.package_install_id=NEW.result_contract->'provenance'->>'packageInstallId')
          OR (s->'schemaVersion'='2'::jsonb AND NEW.run_kind='flow' AND work.definition->'target'->>'kind'='company_flow'
            AND work.definition->'target'->'coordinatorBinding'=s->'coordinatorFlowBinding'
            AND EXISTS (
              SELECT 1 FROM company_flow_bindings c
              JOIN company_flow_binding_revisions cr ON cr.binding_id=c.id AND cr.revision=c.revision
              JOIN flow_revisions f ON f.id=c.flow_revision_id
              WHERE c.id=s->'coordinatorFlowBinding'->>'id' AND c.company_id=NEW.company_id
                AND c.enabled AND c.detached_at IS NULL AND c.specialist_binding_id=binding.id
                AND c.package_install_id=binding.package_install_id
                AND to_jsonb(c.revision)=s->'coordinatorFlowBinding'->'revision'
                AND cr.snapshot_digest=s->'coordinatorFlowBinding'->>'snapshotSha256'
                AND cr.snapshot->'specialist'=reviewed.snapshot AND cr.snapshot->'enabled'='true'::jsonb
                AND cr.snapshot->'detachedAt'='null'::jsonb
                AND f.id=NEW.flow_revision_id AND f.package_status='Installed' AND f.exec_trust='trusted'
                AND f.flow_ref_id=reviewed.snapshot->'definition'->>'flow'
                AND f.resolved_revision=NEW.flow_revision AND f.version_label=NEW.flow_version
                AND f.manifest_digest=cr.snapshot->>'manifestSha256' AND f.manifest=cr.snapshot->'manifest'
                AND f.manifest->'execution'='{"workspace":"none","completion":"result"}'::jsonb
                AND f.manifest->'result'->'export'->'required'='true'::jsonb
                AND NEW.result_contract->>'kind'='flow_export' AND NEW.result_contract->>'flowRevisionId'=f.id
                AND NEW.result_contract->'producerNodeIds'=f.manifest->'result'->'export'->'from'
                AND NEW.result_contract->'nativeContract' IS NOT DISTINCT FROM f.manifest->'result'->'export'->'native_contract'
            ))
        )
        AND NEW.result_contract->'required'='true'::jsonb AND NEW.scheduled_request_snapshot IS NULL
        AND work.definition->'objectiveInput'->'expectedResult'->>'schemaRef'=NEW.result_contract->>'schemaRef'
        AND work.definition->'objectiveInput'->'expectedResult'->'schemaVersion'=NEW.result_contract->'schemaVersion'
        AND work.definition->'objectiveInput'->'expectedResult'->>'sha256'=NEW.result_contract->>'sha256'
    ) THEN
      RAISE EXCEPTION 'Company child execution requires its exact open work reservation, receiving role, source input and result contract'
        USING ERRCODE='23514', CONSTRAINT='runs_company_execution_reference_check';
    END IF;
    RETURN NEW;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM specialist_assignments a
    JOIN specialist_input_revisions i ON i.assignment_id=a.id AND i.revision::numeric=(s->'assignment'->>'inputRevision')::numeric
    JOIN company_specialist_bindings b ON b.id=a.specialist_binding_id AND b.company_id=a.company_id AND b.enabled AND b.detached_at IS NULL
    JOIN company_specialist_binding_revisions r ON r.binding_id=b.id AND r.revision=b.revision
    JOIN package_installs p ON p.id=b.package_install_id AND p.package_status='Installed' AND p.trust_status IN ('trusted','trusted_by_policy')
    JOIN agents role ON role.id=b.agent_id AND role.enabled AND role.quarantined_at IS NULL
    JOIN users u ON u.id=s->'authority'->'actor'->>'id' AND u.account_status='active' AND NOT u.must_change_password
    JOIN company_grants g ON g.company_id=a.company_id AND g.principal_type='user' AND g.principal_id=u.id AND g.action='assignments:update' AND g.revoked_at IS NULL
    WHERE a.id=s->'assignment'->>'id' AND a.company_id=NEW.company_id AND a.project_id IS NULL AND a.status='queued'
      AND a.revision::numeric=(s->>'assignmentRevision')::numeric
      AND a.input_revision=i.revision AND i.digest=s->'assignment'->>'inputSha256'
      AND b.id=s->'specialistBinding'->>'id' AND b.revision::numeric=(s->'specialistBinding'->>'revision')::numeric
      AND r.snapshot_digest=s->'specialistBinding'->>'snapshotSha256'
      AND b.agent_id=NEW.source_agent_id AND NEW.agent_id=NEW.source_agent_id AND NEW.created_by_user_id=u.id
      AND g.id=s->'authority'->'witness'->>'authorityId' AND g.revision::numeric=(s->'authority'->'witness'->>'revision')::numeric
      AND coalesce(NEW.agent_config,'{}'::jsonb)=r.snapshot->'effectiveConfiguration'
      AND NEW.execution_policy=r.snapshot->'executionPolicy'
      AND NEW.agent_activity_snapshot->>'agentId'=b.agent_id
      AND NEW.agent_activity_snapshot->>'definitionSha256'=r.snapshot->>'definitionSha256'
      AND NEW.agent_activity_snapshot->>'packageInstallId'=p.id
      AND i.standing_definition->'definition'=r.snapshot->'definition'
      AND p.resolved_revision=r.snapshot->>'packageRevision'
      AND i.objective_input->'expectedResult'->>'schemaRef'=NEW.result_contract->>'schemaRef'
      AND i.objective_input->'expectedResult'->'schemaVersion'=NEW.result_contract->'schemaVersion'
      AND i.objective_input->'expectedResult'->>'sha256'=NEW.result_contract->>'sha256'
      AND i.scheduled_request IS NOT DISTINCT FROM NEW.scheduled_request_snapshot
      AND (
        (s->'schemaVersion'='1'::jsonb
          AND r.snapshot->'definition'=NEW.result_contract->'definition'
          AND p.id=NEW.result_contract->'provenance'->>'packageInstallId')
        OR (s->'schemaVersion'='2'::jsonb AND NEW.run_kind='flow' AND EXISTS (
          SELECT 1 FROM company_flow_bindings c
          JOIN company_flow_binding_revisions cr ON cr.binding_id=c.id AND cr.revision=c.revision
          JOIN flow_revisions f ON f.id=c.flow_revision_id
          WHERE c.id=s->'coordinatorFlowBinding'->>'id' AND c.company_id=NEW.company_id
            AND c.enabled AND c.detached_at IS NULL AND c.specialist_binding_id=b.id AND c.package_install_id=p.id
            AND c.revision::numeric=CASE WHEN jsonb_typeof(s->'coordinatorFlowBinding'->'revision')='number'
              THEN (s->'coordinatorFlowBinding'->>'revision')::numeric ELSE NULL END
            AND cr.snapshot_digest=s->'coordinatorFlowBinding'->>'snapshotSha256'
            AND cr.snapshot->>'companyId'=NEW.company_id
            AND cr.snapshot->>'specialistBindingId'=b.id AND cr.snapshot->'specialistRevision'=to_jsonb(b.revision)
            AND cr.snapshot->'specialist'=r.snapshot AND cr.snapshot->'enabled'='true'::jsonb
            AND cr.snapshot->'detachedAt'='null'::jsonb
            AND cr.snapshot->>'packageInstallId'=p.id AND cr.snapshot->>'packageRevision'=p.resolved_revision
            AND cr.snapshot->>'flowRevisionId'=f.id AND NEW.flow_revision_id=f.id
            AND f.package_status='Installed' AND f.exec_trust='trusted'
            AND f.resolved_revision=p.resolved_revision AND NEW.flow_revision=f.resolved_revision AND NEW.flow_version=f.version_label
            AND f.manifest_digest=cr.snapshot->>'manifestSha256' AND f.manifest=cr.snapshot->'manifest'
            AND f.flow_ref_id=cr.snapshot->>'flowRefId' AND f.flow_ref_id=r.snapshot->'definition'->>'flow'
            AND f.manifest->'execution'='{"workspace":"none","completion":"result"}'::jsonb
            AND cr.snapshot->'execution'=f.manifest->'execution'
            AND f.manifest->'result'->'export'->'required'='true'::jsonb
            AND NEW.result_contract->>'kind'='flow_export' AND NEW.result_contract->>'flowRevisionId'=f.id
            AND NEW.result_contract->'required'='true'::jsonb
            AND NEW.result_contract->'producerNodeIds'=f.manifest->'result'->'export'->'from'
            AND NEW.result_contract->'nativeContract' IS NOT DISTINCT FROM f.manifest->'result'->'export'->'native_contract'
        ))
      )
  ) THEN
    RAISE EXCEPTION 'Company execution must reserve its current owned assignment, exact specialist/input/result and initiating authority'
      USING ERRCODE='23514', CONSTRAINT='runs_company_execution_reference_check';
  END IF;
  RETURN NEW;
END;
$$;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION check_company_agent_execution_link() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.company_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM specialist_run_links l JOIN specialist_assignments a ON a.id=l.assignment_id
    WHERE l.run_id=NEW.id AND l.assignment_id=NEW.company_execution_snapshot->'assignment'->>'id'
      AND l.input_revision::numeric=(NEW.company_execution_snapshot->'assignment'->>'inputRevision')::numeric
      AND a.company_id=NEW.company_id AND a.project_id IS NULL
      AND (
        (NEW.parent_run_id IS NULL AND (NEW.company_execution_snapshot->'schemaVersion'='1'::jsonb OR l.role='coordinator'))
        OR (NEW.parent_run_id IS NOT NULL AND l.role='child' AND EXISTS (
          SELECT 1 FROM specialist_work work WHERE work.id=l.work_id AND work.work_revision=l.work_revision
            AND work.child_run_id=NEW.id AND work.reserved_run_id=NEW.id AND work.parent_run_id=NEW.parent_run_id
            AND specialist_run_has_input(NEW.id,a.id,l.input_revision,work.input_sha256)
        ))
      )
  ) THEN
    RAISE EXCEPTION 'Company execution reservation requires its atomic immutable assignment/input link'
      USING ERRCODE='23514', CONSTRAINT='runs_company_execution_link_check';
  END IF;
  RETURN NULL;
END;
$$;

--> statement-breakpoint
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
      JOIN specialist_run_links link ON link.run_id=execution.id
      JOIN specialist_assignments assignment ON assignment.id=link.assignment_id AND assignment.company_id=execution.company_id AND assignment.project_id IS NULL
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
        AND ((link.role='coordinator' AND link.work_id IS NULL) OR (
          link.role='child' AND work.decision_state='open' AND work.definition->'target'->>'kind'='company_flow'
          AND specialist_run_has_input(execution.id,assignment.id,input.revision,input.digest)
          AND specialist_work_target_exists(work.definition->'target',execution.company_id,NULL)
          AND configuration.snapshot->'grantActions' ? 'assignments:read'
          AND EXISTS(SELECT 1 FROM company_grants g WHERE g.company_id=execution.company_id
            AND g.principal_type='agent' AND g.principal_id=binding.agent_id AND g.action='assignments:read' AND g.revoked_at IS NULL)
        ))
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
