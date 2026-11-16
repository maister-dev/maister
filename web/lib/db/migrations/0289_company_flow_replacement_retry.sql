ALTER TABLE "agent_retry_intents" DROP CONSTRAINT "agent_retry_recipe_check";--> statement-breakpoint
ALTER TABLE "agent_retry_intents" ADD CONSTRAINT "agent_retry_recipe_check" CHECK ((jsonb_typeof("agent_retry_intents"."recipe")='object'
    AND "agent_retry_intents"."recipe"->>'agentId'="agent_retry_intents"."source_agent_id"
    AND "agent_retry_intents"."request_digest" ~ '^[a-f0-9]{64}$' AND "agent_retry_intents"."preview_fingerprint" ~ '^[a-f0-9]{64}$'
    AND pg_column_size("agent_retry_intents"."recipe")<=1048576
    AND (("agent_retry_intents"."project_id" IS NOT NULL AND "agent_retry_intents"."company_id" IS NULL
      AND "agent_retry_intents"."recipe"->'version' IN ('1'::jsonb,'2'::jsonb)
      AND ("agent_retry_intents"."recipe"->'version'='1'::jsonb OR "agent_retry_intents"."recipe"->>'strategy' IN ('pre_work_retry','fresh_qualification'))
      AND "agent_retry_intents"."recipe"->>'projectId'="agent_retry_intents"."project_id")
    OR ("agent_retry_intents"."project_id" IS NULL AND "agent_retry_intents"."company_id" IS NOT NULL
      AND "agent_retry_intents"."recipe"->'version'='3'::jsonb AND "agent_retry_intents"."recipe"->>'strategy'='pre_work_retry'
      AND "agent_retry_intents"."recipe"->'owner'=jsonb_build_object('kind','company','companyId',"agent_retry_intents"."company_id")
      AND "agent_retry_intents"."recipe" ?& ARRAY['version','strategy','owner','projectId','taskId','taskRevision','project','agentId','definition','configuration','trigger','runner','policy','contextDigest','specialistBinding','coordinatorFlowBinding','assignment']
      AND "agent_retry_intents"."recipe"-ARRAY['version','strategy','owner','projectId','taskId','taskRevision','project','agentId','definition','configuration','trigger','runner','policy','contextDigest','specialistBinding','coordinatorFlowBinding','assignment','scheduledRequestSnapshot','replacement']='{}'::jsonb
      AND (NOT ("agent_retry_intents"."recipe" ? 'replacement') OR (
        jsonb_typeof("agent_retry_intents"."recipe"->'replacement')='object'
        AND ("agent_retry_intents"."recipe"->'replacement') ?& ARRAY['sourceRunId','assignmentRevision','contextRevision','ownerEpoch','resultSha256','sourceSha256']
        AND ("agent_retry_intents"."recipe"->'replacement')-ARRAY['sourceRunId','assignmentRevision','contextRevision','ownerEpoch','resultSha256','sourceSha256','sessionsSha256']='{}'::jsonb
        AND "agent_retry_intents"."recipe"->'replacement'->>'resultSha256' ~ '^[a-f0-9]{64}$'
        AND "agent_retry_intents"."recipe"->'replacement'->>'sourceSha256' ~ '^[a-f0-9]{64}$'
        AND (NOT (("agent_retry_intents"."recipe"->'replacement') ? 'sessionsSha256') OR (
          jsonb_typeof("agent_retry_intents"."recipe"->'replacement'->'sessionsSha256')='string'
          AND "agent_retry_intents"."recipe"->'replacement'->>'sessionsSha256' ~ '^[a-f0-9]{64}$'
        ))
      ))
      AND "agent_retry_intents"."recipe"->'projectId'='null'::jsonb AND "agent_retry_intents"."recipe"->'project'='null'::jsonb
      AND "agent_retry_intents"."recipe"->'taskId'='null'::jsonb AND "agent_retry_intents"."recipe"->'taskRevision'='null'::jsonb
      AND "agent_retry_intents"."recipe"->>'contextDigest' ~ '^[a-f0-9]{64}$'
      AND (CASE WHEN jsonb_typeof(("agent_retry_intents"."recipe"->'specialistBinding'))='object' AND jsonb_typeof(("agent_retry_intents"."recipe"->'specialistBinding')->'revision')='number' THEN
    ("agent_retry_intents"."recipe"->'specialistBinding') ?& ARRAY['id','revision','snapshotSha256']
    AND ("agent_retry_intents"."recipe"->'specialistBinding')-ARRAY['id','revision','snapshotSha256']='{}'::jsonb
    AND jsonb_typeof(("agent_retry_intents"."recipe"->'specialistBinding')->'id')='string' AND char_length(("agent_retry_intents"."recipe"->'specialistBinding')->>'id') BETWEEN 1 AND 128
    AND (("agent_retry_intents"."recipe"->'specialistBinding')->>'revision')::numeric BETWEEN 1 AND 2147483647 AND mod((("agent_retry_intents"."recipe"->'specialistBinding')->>'revision')::numeric,1)=0
    AND jsonb_typeof(("agent_retry_intents"."recipe"->'specialistBinding')->'snapshotSha256')='string' AND ("agent_retry_intents"."recipe"->'specialistBinding')->>'snapshotSha256' ~ '^[a-f0-9]{64}$'
    ELSE false END) IS TRUE
      AND (("agent_retry_intents"."recipe"->'coordinatorFlowBinding')='null'::jsonb OR (CASE WHEN jsonb_typeof(("agent_retry_intents"."recipe"->'coordinatorFlowBinding'))='object' AND jsonb_typeof(("agent_retry_intents"."recipe"->'coordinatorFlowBinding')->'revision')='number' THEN
    ("agent_retry_intents"."recipe"->'coordinatorFlowBinding') ?& ARRAY['id','revision','snapshotSha256']
    AND ("agent_retry_intents"."recipe"->'coordinatorFlowBinding')-ARRAY['id','revision','snapshotSha256']='{}'::jsonb
    AND jsonb_typeof(("agent_retry_intents"."recipe"->'coordinatorFlowBinding')->'id')='string' AND char_length(("agent_retry_intents"."recipe"->'coordinatorFlowBinding')->>'id') BETWEEN 1 AND 128
    AND (("agent_retry_intents"."recipe"->'coordinatorFlowBinding')->>'revision')::numeric BETWEEN 1 AND 2147483647 AND mod((("agent_retry_intents"."recipe"->'coordinatorFlowBinding')->>'revision')::numeric,1)=0
    AND jsonb_typeof(("agent_retry_intents"."recipe"->'coordinatorFlowBinding')->'snapshotSha256')='string' AND ("agent_retry_intents"."recipe"->'coordinatorFlowBinding')->>'snapshotSha256' ~ '^[a-f0-9]{64}$'
    ELSE false END) IS TRUE)
      AND CASE WHEN jsonb_typeof(("agent_retry_intents"."recipe"->'assignment'))='object' AND jsonb_typeof(("agent_retry_intents"."recipe"->'assignment')->'inputRevision')='number' THEN
        ("agent_retry_intents"."recipe"->'assignment') ?& ARRAY['id','inputRevision','inputSha256']
        AND ("agent_retry_intents"."recipe"->'assignment')-ARRAY['id','inputRevision','inputSha256']='{}'::jsonb
        AND jsonb_typeof(("agent_retry_intents"."recipe"->'assignment')->'id')='string' AND char_length(("agent_retry_intents"."recipe"->'assignment')->>'id') BETWEEN 1 AND 128
        AND (("agent_retry_intents"."recipe"->'assignment')->>'inputRevision')::numeric BETWEEN 1 AND 2147483647 AND mod((("agent_retry_intents"."recipe"->'assignment')->>'inputRevision')::numeric,1)=0
        AND ("agent_retry_intents"."recipe"->'assignment')->>'inputSha256' ~ '^[a-f0-9]{64}$'
        ELSE false END))) IS TRUE);
--> statement-breakpoint
CREATE FUNCTION company_flow_retry_sessions_digest(source_id text) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT task_launch_admission_digest(jsonb_agg(jsonb_build_object(
    'sessionName',session_name,'runnerId',runner_id,'runner',runner_snapshot,
    'tier',runner_resolution_tier,'source',resolution_source,'warning',resolution_warning
  ) ORDER BY session_name)) FROM run_sessions WHERE run_id=source_id
$$;
--> statement-breakpoint
CREATE FUNCTION company_flow_retry_has_dispatch_witness(source_id text) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS(SELECT 1 FROM domain_events event WHERE event.run_id=source_id
    AND event.kind='run.failed' AND event.payload->'cause'->>'source'='graph'
    AND event.payload->>'failurePhase'='before_dispatch')
    AND NOT EXISTS (SELECT 1 FROM node_attempts WHERE run_id=source_id)
    AND NOT EXISTS (SELECT 1 FROM runs WHERE parent_run_id=source_id)
    AND NOT EXISTS (SELECT 1 FROM specialist_work WHERE parent_run_id=source_id)
    AND NOT EXISTS (SELECT 1 FROM execution_commands WHERE run_id=source_id AND kind<>'workspace.release')
    AND NOT EXISTS (SELECT 1 FROM run_session_incarnations WHERE run_id=source_id)
    AND NOT EXISTS (SELECT 1 FROM run_results WHERE run_id=source_id)
    AND NOT EXISTS (SELECT 1 FROM hitl_requests WHERE run_id=source_id)
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION guard_company_replacement_retry() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  witness jsonb := NEW.recipe->'replacement';
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.state<>'accepted' OR NEW.created_run_id IS NOT NULL OR NOT EXISTS (
      SELECT 1 FROM runs source
      JOIN specialist_run_links link ON link.run_id=source.id
      JOIN specialist_assignments subject ON subject.id=link.assignment_id
      JOIN specialist_owner_claims owner ON owner.assignment_id=subject.id AND owner.run_id=source.id
        AND owner.placement_id=source.execution_assignment_id
      LEFT JOIN run_sessions session ON session.run_id=source.id AND session.session_name='default'
      WHERE source.id=NEW.source_run_id AND source.company_id=NEW.company_id
        AND source.source_agent_id=NEW.source_agent_id
        AND source.parent_run_id IS NULL AND source.status IN ('Failed','Crashed') AND source.ended_at IS NOT NULL
        AND source.trigger_source='manual' AND source.agent_workspace='none'
        AND source.result_contract IS NOT NULL
        AND (
          (source.run_kind='agent' AND source.operational_terminal IS NOT NULL
            AND NOT (witness ? 'sessionsSha256') AND NEW.recipe->'coordinatorFlowBinding'='null'::jsonb
            AND NEW.recipe->'runner'=session.runner_snapshot AND company_retry_has_dispatch_witness(source.id))
          OR (source.run_kind='flow' AND source.operational_terminal IS NULL
            AND NEW.recipe->'coordinatorFlowBinding'=source.company_execution_snapshot->'coordinatorFlowBinding'
            AND witness->>'sessionsSha256'=company_flow_retry_sessions_digest(source.id)
            AND company_flow_retry_has_dispatch_witness(source.id)
            AND EXISTS (SELECT 1 FROM run_sessions slot WHERE slot.run_id=source.id
              AND slot.runner_snapshot=NEW.recipe->'runner' AND slot.runner_id=NEW.selected_runner_id))
        )
        AND link.assignment_id=NEW.recipe->'assignment'->>'id'
        AND subject.status='active' AND specialist_current_root_id(subject.id,subject.input_revision)=source.id
        AND NOT specialist_other_unsettled_root(subject.id,source.id)
        AND witness->'sourceRunId'=to_jsonb(source.id)
        AND witness->'ownerEpoch'=to_jsonb(owner.epoch)
        AND witness->'contextRevision'=to_jsonb(subject.context_revision)
        AND witness->'assignmentRevision'=to_jsonb(subject.revision)
        AND witness->>'resultSha256'=task_launch_admission_digest(source.result_contract)
        AND witness->>'sourceSha256'=company_retry_source_digest(source)
        AND NOT EXISTS(SELECT 1 FROM execution_assignments placement WHERE placement.run_id=source.id AND placement.state='active')
        AND NOT EXISTS(SELECT 1 FROM run_sessions bound WHERE bound.run_id=source.id AND bound.acp_session_id IS NOT NULL)
        AND NOT EXISTS(SELECT 1 FROM run_session_incarnations incarnation WHERE incarnation.run_id=source.id AND incarnation.state IN ('created','active'))
        AND NOT EXISTS(SELECT 1 FROM execution_commands command WHERE command.run_id=source.id
          AND (command.kind IN ('session.prompt','session.steer') OR (command.kind='session.create'
            AND (command.state='failed' AND command.receipt_evidence->>'phase'='rejected'
              AND command.receipt_evidence->>'inflight'='false') IS NOT TRUE)))
    ) THEN
      RAISE EXCEPTION 'Replacement retry requires the exact settled specialist Run and current owner'
        USING ERRCODE='23514',CONSTRAINT='company_retry_replacement_reference';
    END IF;
  ELSIF NEW.state='launched' AND OLD.state IS DISTINCT FROM NEW.state AND NOT EXISTS (
    SELECT 1 FROM runs source JOIN runs successor ON successor.id=NEW.created_run_id
    JOIN specialist_run_links link ON link.run_id=successor.id
    LEFT JOIN run_sessions session ON session.run_id=successor.id AND session.session_name='default'
    WHERE source.id=NEW.source_run_id AND successor.id=NEW.successor_run_id
      AND successor.company_id=NEW.company_id AND successor.parent_run_id IS NULL
      AND successor.status='Pending' AND successor.retry_of_run_id=source.id AND link.work_id IS NULL
      AND ((source.run_kind='agent' AND successor.run_kind='agent' AND link.role='continuation'
        AND session.runner_snapshot=NEW.recipe->'runner')
        OR (source.run_kind='flow' AND successor.run_kind='flow' AND link.role='coordinator'
          AND successor.company_execution_snapshot->'coordinatorFlowBinding'=NEW.recipe->'coordinatorFlowBinding'
          AND witness->>'sessionsSha256'=company_flow_retry_sessions_digest(successor.id)))
      AND link.assignment_id=NEW.recipe->'assignment'->>'id'
      AND successor.company_execution_snapshot->'assignment'=NEW.recipe->'assignment'
      AND successor.company_execution_snapshot->'specialistBinding'=NEW.recipe->'specialistBinding'
      AND successor.result_contract=source.result_contract
      AND successor.knowledge_access=source.knowledge_access
  ) THEN
    RAISE EXCEPTION 'Replacement retry must reserve the exact successor before settling its receipt'
      USING ERRCODE='23514',CONSTRAINT='company_retry_replacement_successor';
  END IF;
  RETURN NEW;
END $$;
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
    JOIN users u ON u.id=s->'authority'->'actor'->>'id' AND u.account_status='active' AND NOT u.must_change_password
    JOIN company_grants g ON g.company_id=a.company_id AND g.principal_type='user' AND g.principal_id=u.id AND g.action='assignments:update' AND g.revoked_at IS NULL
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
