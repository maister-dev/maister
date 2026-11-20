ALTER TABLE "agent_schedules" ADD COLUMN "installation_review" jsonb;
--> statement-breakpoint
CREATE FUNCTION guard_installation_schedule_review() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE review jsonb := NEW.installation_review;
BEGIN
  IF TG_OP='UPDATE' THEN
    IF OLD.installation_review IS DISTINCT FROM review THEN
      RAISE EXCEPTION 'Installation schedule review is immutable' USING ERRCODE='23514',CONSTRAINT='agent_schedules_installation_review_check';
    END IF;
    RETURN NEW;
  END IF;
  IF review IS NULL THEN RETURN NEW; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM company_specialist_bindings binding
    JOIN company_specialist_binding_revisions revision ON (revision.binding_id,revision.revision)=(binding.id,binding.revision)
    JOIN users reviewer ON reviewer.id=NEW.created_by AND reviewer.account_status='active' AND NOT reviewer.must_change_password
    JOIN company_grants grant_row ON grant_row.company_id=NEW.company_id AND grant_row.principal_type='user'
      AND grant_row.principal_id=reviewer.id AND grant_row.action='assignments:update' AND grant_row.revoked_at IS NULL
    WHERE binding.id=NEW.company_specialist_binding_id AND binding.company_id=NEW.company_id AND binding.agent_id=NEW.agent_id
      AND NEW.project_id IS NULL AND NEW.company_flow_binding_id IS NULL AND NEW.stand_inspection IS NULL
      AND NEW.company_config_revision=1 AND NEW.enabled AND binding.enabled AND binding.detached_at IS NULL
      AND revision.snapshot ? 'installationGrant'
      AND review=jsonb_build_object('schemaVersion',1,
        'binding',jsonb_build_object('id',binding.id,'revision',binding.revision,'snapshotSha256',revision.snapshot_digest),
        'reviewer',jsonb_build_object(
          'actor',jsonb_build_object('kind','user','id',reviewer.id,'runId',NULL,'attemptId',NULL),
          'witness',jsonb_build_object('kind','company_grant','owner',jsonb_build_object('kind','company','companyId',NEW.company_id),
            'authorityId',grant_row.id,'revision',grant_row.revision,'action','assignments:update')))
    FOR SHARE OF binding,revision,reviewer,grant_row
  ) THEN
    RAISE EXCEPTION 'Installation schedule requires its exact reviewed binding and source authority' USING ERRCODE='23514',CONSTRAINT='agent_schedules_installation_review_check';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER agent_schedules_installation_review_guard BEFORE INSERT OR UPDATE OF installation_review ON agent_schedules
  FOR EACH ROW EXECUTE FUNCTION guard_installation_schedule_review();
--> statement-breakpoint
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
    LEFT JOIN users u ON u.id=s->'authority'->'actor'->>'id' AND u.account_status='active' AND NOT u.must_change_password
    LEFT JOIN company_grants g ON g.company_id=a.company_id AND g.principal_type='user' AND g.principal_id=u.id AND g.action='assignments:update' AND g.revoked_at IS NULL
    WHERE a.id=s->'assignment'->>'id' AND a.company_id=NEW.company_id AND a.project_id IS NULL
      AND (
        (a.status='queued' AND NEW.retry_of_run_id IS NULL)
        OR (a.status='active' AND NEW.retry_of_run_id IS NOT NULL AND EXISTS (
          SELECT 1 FROM agent_retry_intents intent
          JOIN company_grants recovery ON recovery.company_id=NEW.company_id AND recovery.principal_type='user'
            AND recovery.principal_id=u.id AND recovery.action='assignments:recover' AND recovery.revoked_at IS NULL
          WHERE intent.company_id=NEW.company_id AND intent.actor_user_id=u.id
            AND intent.source_run_id=NEW.retry_of_run_id AND intent.successor_run_id=NEW.id
            AND intent.recipe ? 'replacement' AND intent.state='accepted'
            AND intent.recipe->'assignment'=s->'assignment'
            AND intent.recipe->'specialistBinding'=s->'specialistBinding'
            AND ((NEW.run_kind='agent' AND intent.recipe->'coordinatorFlowBinding'='null'::jsonb)
              OR (NEW.run_kind='flow' AND intent.recipe->'coordinatorFlowBinding'=s->'coordinatorFlowBinding'
                AND intent.recipe->'replacement' ? 'sessionsSha256'))
            AND intent.recipe->'replacement'->'assignmentRevision'=s->'assignmentRevision'
        ))
      )
      AND a.revision::numeric=(s->>'assignmentRevision')::numeric
      AND a.input_revision=i.revision AND i.digest=s->'assignment'->>'inputSha256'
      AND b.id=s->'specialistBinding'->>'id' AND b.revision::numeric=(s->'specialistBinding'->>'revision')::numeric
      AND r.snapshot_digest=s->'specialistBinding'->>'snapshotSha256'
      AND b.agent_id=NEW.source_agent_id AND NEW.agent_id=NEW.source_agent_id
      AND (
        (NEW.created_by_user_id=u.id AND g.id=s->'authority'->'witness'->>'authorityId'
          AND to_jsonb(g.revision)=s->'authority'->'witness'->'revision'
          AND (NOT (r.snapshot ? 'installationGrant') OR NEW.trigger_source='manual' OR NEW.retry_of_run_id IS NOT NULL))
        OR (
          s->'schemaVersion'='1'::jsonb AND NEW.run_kind='agent' AND NEW.agent_workspace='none'
          AND NEW.parent_run_id IS NULL AND NEW.retry_of_run_id IS NULL AND NEW.created_by_user_id IS NULL
          AND r.snapshot ? 'installationGrant' AND NEW.trigger_source IN ('cron','domain_event')
          AND a.requester=jsonb_build_object('kind','agent','id',NEW.agent_id,'runId',NEW.id,'attemptId',NULL)
          AND i.actor=a.requester
          AND EXISTS (
            SELECT 1 FROM agent_trigger_attempts attempt
            JOIN agent_schedules source ON source.id=attempt.schedule_id AND source.company_id=NEW.company_id AND source.project_id IS NULL
            WHERE attempt.reserved_run_id=NEW.id AND attempt.schedule_id=NEW.agent_schedule_id
              AND attempt.company_id=NEW.company_id AND attempt.project_id IS NULL
              AND attempt.source_agent_id=NEW.agent_id AND attempt.outcome IS NULL
              AND attempt.trigger_source=NEW.trigger_source AND attempt.trigger_event_id IS NOT DISTINCT FROM NEW.trigger_event_id
              AND source.enabled AND source.stand_inspection IS NULL AND source.company_flow_binding_id IS NULL
              AND source.company_specialist_binding_id=b.id AND source.agent_id=b.agent_id
              AND source.installation_review->'reviewer'=s->'authority'
              AND source.installation_review->'binding'=s->'specialistBinding'
              AND attempt.binding_snapshot->'specialistBinding'=s->'specialistBinding'
              AND attempt.binding_snapshot->'sourceRevision'=to_jsonb(source.company_config_revision)
              AND ((NEW.trigger_source='cron' AND source.trigger_type='cron'
                  AND a.origin=jsonb_build_object('kind','schedule','scheduleId',source.id,'triggerAttemptId',attempt.id)
                  AND attempt.scheduled_request_snapshot=NEW.scheduled_request_snapshot)
                OR (NEW.trigger_source='domain_event' AND source.trigger_type='event'
                  AND a.origin=jsonb_build_object('kind','event','subscriptionId',source.id,'eventId',attempt.trigger_event_id::text)
                  AND r.snapshot->'installationGrant'->'scopes' ? 'runs:read'))
            FOR SHARE OF attempt,source
          )
        )
      )
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
CREATE FUNCTION check_installation_schedule_run_authority() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.company_id IS NOT NULL AND NEW.trigger_source IN ('cron','domain_event')
    AND NEW.retry_of_run_id IS NULL AND NEW.created_by_user_id IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM agent_installation_run_authorities authority
      JOIN company_specialist_binding_revisions reviewed ON (reviewed.binding_id,reviewed.revision,reviewed.snapshot_digest)=
        (authority.binding_id,authority.binding_revision,authority.binding_digest)
      WHERE authority.run_id=NEW.id AND authority.principal=jsonb_build_object('kind','unattended','trigger',NEW.trigger_source)
        AND authority.grant_snapshot=reviewed.snapshot->'installationGrant'
        AND NEW.company_execution_snapshot->'specialistBinding'=jsonb_build_object('id',authority.binding_id,
          'revision',authority.binding_revision,'snapshotSha256',authority.binding_digest)
    )
  THEN
    RAISE EXCEPTION 'Installation trigger reservation requires its exact grant' USING ERRCODE='23514',CONSTRAINT='agent_installation_schedule_run_authority_check';
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER agent_installation_schedule_run_authority AFTER INSERT ON runs
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_installation_schedule_run_authority();
