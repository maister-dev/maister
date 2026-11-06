ALTER TABLE "runs" DROP CONSTRAINT "runs_company_agent_shape_check";--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_company_agent_shape_check" CHECK ((("runs"."company_id" IS NULL AND "runs"."company_execution_snapshot" IS NULL) OR ("runs"."company_id" IS NOT NULL AND "runs"."company_execution_snapshot" IS NOT NULL AND "runs"."project_id" IS NULL AND "runs"."task_id" IS NULL AND "runs"."flow_id" IS NULL AND "runs"."flow_revision_id" IS NULL AND "runs"."local_package_id" IS NULL AND "runs"."run_kind"='agent' AND "runs"."agent_kind"='operational' AND "runs"."agent_workspace"='none' AND "runs"."persistent"=false AND "runs"."source_agent_id" IS NOT NULL AND ("runs"."agent_id" IS NULL OR "runs"."agent_id"="runs"."source_agent_id") AND "runs"."result_contract"->'definition'->>'id'="runs"."source_agent_id" AND (jsonb_typeof("runs"."company_execution_snapshot")='object' AND "runs"."company_execution_snapshot"->'schemaVersion'='1'::jsonb
    AND "runs"."company_execution_snapshot" ?& ARRAY['schemaVersion','owner','assignmentRevision','assignment','specialistBinding','authority']
    AND "runs"."company_execution_snapshot"-ARRAY['schemaVersion','owner','assignmentRevision','assignment','specialistBinding','authority']='{}'::jsonb
    AND "runs"."company_execution_snapshot"->'owner'=jsonb_build_object('kind','company','companyId',"runs"."company_id")
    AND CASE WHEN jsonb_typeof("runs"."company_execution_snapshot"->'assignmentRevision')='number' AND jsonb_typeof(("runs"."company_execution_snapshot"->'assignment')->'inputRevision')='number' THEN
      ("runs"."company_execution_snapshot"->>'assignmentRevision')::numeric BETWEEN 1 AND 2147483647 AND mod(("runs"."company_execution_snapshot"->>'assignmentRevision')::numeric,1)=0
      AND ("runs"."company_execution_snapshot"->'assignment') ?& ARRAY['id','inputRevision','inputSha256']
      AND ("runs"."company_execution_snapshot"->'assignment')-ARRAY['id','inputRevision','inputSha256']='{}'::jsonb
      AND jsonb_typeof(("runs"."company_execution_snapshot"->'assignment')->'id')='string' AND char_length(("runs"."company_execution_snapshot"->'assignment')->>'id') BETWEEN 1 AND 128
      AND (("runs"."company_execution_snapshot"->'assignment')->>'inputRevision')::numeric BETWEEN 1 AND 2147483647 AND mod((("runs"."company_execution_snapshot"->'assignment')->>'inputRevision')::numeric,1)=0
      AND ("runs"."company_execution_snapshot"->'assignment')->>'inputSha256' ~ '^[a-f0-9]{64}$'
      ELSE false END
    AND (CASE WHEN jsonb_typeof(("runs"."company_execution_snapshot"->'specialistBinding'))='object' AND jsonb_typeof(("runs"."company_execution_snapshot"->'specialistBinding')->'revision')='number' THEN
    ("runs"."company_execution_snapshot"->'specialistBinding') ?& ARRAY['id','revision','snapshotSha256']
    AND ("runs"."company_execution_snapshot"->'specialistBinding')-ARRAY['id','revision','snapshotSha256']='{}'::jsonb
    AND jsonb_typeof(("runs"."company_execution_snapshot"->'specialistBinding')->'id')='string' AND char_length(("runs"."company_execution_snapshot"->'specialistBinding')->>'id') BETWEEN 1 AND 128
    AND (("runs"."company_execution_snapshot"->'specialistBinding')->>'revision')::numeric BETWEEN 1 AND 2147483647 AND mod((("runs"."company_execution_snapshot"->'specialistBinding')->>'revision')::numeric,1)=0
    AND jsonb_typeof(("runs"."company_execution_snapshot"->'specialistBinding')->'snapshotSha256')='string' AND ("runs"."company_execution_snapshot"->'specialistBinding')->>'snapshotSha256' ~ '^[a-f0-9]{64}$'
    ELSE false END) IS TRUE
    AND ("runs"."company_execution_snapshot"->'authority') ?& ARRAY['actor','witness'] AND ("runs"."company_execution_snapshot"->'authority')-ARRAY['actor','witness']='{}'::jsonb
    AND ("runs"."company_execution_snapshot"->'authority'->'actor') ?& ARRAY['kind','id','runId','attemptId'] AND ("runs"."company_execution_snapshot"->'authority'->'actor')-ARRAY['kind','id','runId','attemptId']='{}'::jsonb
    AND ("runs"."company_execution_snapshot"->'authority'->'actor')->>'kind'='user' AND jsonb_typeof(("runs"."company_execution_snapshot"->'authority'->'actor')->'id')='string' AND char_length(("runs"."company_execution_snapshot"->'authority'->'actor')->>'id') BETWEEN 1 AND 192
    AND ("runs"."company_execution_snapshot"->'authority'->'actor')->'runId'='null'::jsonb AND ("runs"."company_execution_snapshot"->'authority'->'actor')->'attemptId'='null'::jsonb
    AND ("runs"."company_execution_snapshot"->'authority'->'witness') ?& ARRAY['kind','owner','authorityId','revision','action'] AND ("runs"."company_execution_snapshot"->'authority'->'witness')-ARRAY['kind','owner','authorityId','revision','action']='{}'::jsonb
    AND ("runs"."company_execution_snapshot"->'authority'->'witness')->>'kind'='company_grant' AND ("runs"."company_execution_snapshot"->'authority'->'witness')->'owner'="runs"."company_execution_snapshot"->'owner' AND ("runs"."company_execution_snapshot"->'authority'->'witness')->>'action'='assignments:update'
    AND jsonb_typeof(("runs"."company_execution_snapshot"->'authority'->'witness')->'authorityId')='string' AND char_length(("runs"."company_execution_snapshot"->'authority'->'witness')->>'authorityId') BETWEEN 1 AND 128
    AND CASE WHEN jsonb_typeof(("runs"."company_execution_snapshot"->'authority'->'witness')->'revision')='number' THEN (("runs"."company_execution_snapshot"->'authority'->'witness')->>'revision')::numeric BETWEEN 1 AND 2147483647 AND mod((("runs"."company_execution_snapshot"->'authority'->'witness')->>'revision')::numeric,1)=0 ELSE false END
    AND pg_column_size("runs"."company_execution_snapshot")<=32768) IS TRUE) OR ("runs"."company_id" IS NOT NULL AND "runs"."company_execution_snapshot" IS NOT NULL AND "runs"."project_id" IS NULL AND "runs"."task_id" IS NULL AND "runs"."flow_id" IS NULL AND "runs"."local_package_id" IS NULL AND "runs"."run_kind"='flow' AND "runs"."agent_kind" IS NULL AND "runs"."agent_workspace"='none' AND "runs"."persistent"=false AND "runs"."source_agent_id" IS NOT NULL AND ("runs"."agent_id" IS NULL OR "runs"."agent_id"="runs"."source_agent_id") AND "runs"."flow_revision_id" IS NOT NULL AND "runs"."result_contract"->>'kind'='flow_export' AND "runs"."result_contract"->'required'='true'::jsonb AND "runs"."result_contract"->>'flowRevisionId'="runs"."flow_revision_id" AND "runs"."result_contract"->>'sha256' ~ '^[a-f0-9]{64}$' AND jsonb_typeof("runs"."result_contract"->'schema')='object' AND (jsonb_typeof("runs"."company_execution_snapshot")='object' AND "runs"."company_execution_snapshot"->'schemaVersion'='2'::jsonb
    AND "runs"."company_execution_snapshot" ?& ARRAY['executionKind','coordinatorFlowBinding']
    AND "runs"."company_execution_snapshot"->>'executionKind'='flow'
    AND (CASE WHEN jsonb_typeof(("runs"."company_execution_snapshot"->'coordinatorFlowBinding'))='object' AND jsonb_typeof(("runs"."company_execution_snapshot"->'coordinatorFlowBinding')->'revision')='number' THEN
    ("runs"."company_execution_snapshot"->'coordinatorFlowBinding') ?& ARRAY['id','revision','snapshotSha256']
    AND ("runs"."company_execution_snapshot"->'coordinatorFlowBinding')-ARRAY['id','revision','snapshotSha256']='{}'::jsonb
    AND jsonb_typeof(("runs"."company_execution_snapshot"->'coordinatorFlowBinding')->'id')='string' AND char_length(("runs"."company_execution_snapshot"->'coordinatorFlowBinding')->>'id') BETWEEN 1 AND 128
    AND (("runs"."company_execution_snapshot"->'coordinatorFlowBinding')->>'revision')::numeric BETWEEN 1 AND 2147483647 AND mod((("runs"."company_execution_snapshot"->'coordinatorFlowBinding')->>'revision')::numeric,1)=0
    AND jsonb_typeof(("runs"."company_execution_snapshot"->'coordinatorFlowBinding')->'snapshotSha256')='string' AND ("runs"."company_execution_snapshot"->'coordinatorFlowBinding')->>'snapshotSha256' ~ '^[a-f0-9]{64}$'
    ELSE false END) IS TRUE
    AND (jsonb_typeof((("runs"."company_execution_snapshot"-ARRAY['executionKind','coordinatorFlowBinding']) || '{"schemaVersion":1}'::jsonb))='object' AND (("runs"."company_execution_snapshot"-ARRAY['executionKind','coordinatorFlowBinding']) || '{"schemaVersion":1}'::jsonb)->'schemaVersion'='1'::jsonb
    AND (("runs"."company_execution_snapshot"-ARRAY['executionKind','coordinatorFlowBinding']) || '{"schemaVersion":1}'::jsonb) ?& ARRAY['schemaVersion','owner','assignmentRevision','assignment','specialistBinding','authority']
    AND (("runs"."company_execution_snapshot"-ARRAY['executionKind','coordinatorFlowBinding']) || '{"schemaVersion":1}'::jsonb)-ARRAY['schemaVersion','owner','assignmentRevision','assignment','specialistBinding','authority']='{}'::jsonb
    AND (("runs"."company_execution_snapshot"-ARRAY['executionKind','coordinatorFlowBinding']) || '{"schemaVersion":1}'::jsonb)->'owner'=jsonb_build_object('kind','company','companyId',"runs"."company_id")
    AND CASE WHEN jsonb_typeof((("runs"."company_execution_snapshot"-ARRAY['executionKind','coordinatorFlowBinding']) || '{"schemaVersion":1}'::jsonb)->'assignmentRevision')='number' AND jsonb_typeof(((("runs"."company_execution_snapshot"-ARRAY['executionKind','coordinatorFlowBinding']) || '{"schemaVersion":1}'::jsonb)->'assignment')->'inputRevision')='number' THEN
      ((("runs"."company_execution_snapshot"-ARRAY['executionKind','coordinatorFlowBinding']) || '{"schemaVersion":1}'::jsonb)->>'assignmentRevision')::numeric BETWEEN 1 AND 2147483647 AND mod(((("runs"."company_execution_snapshot"-ARRAY['executionKind','coordinatorFlowBinding']) || '{"schemaVersion":1}'::jsonb)->>'assignmentRevision')::numeric,1)=0
      AND ((("runs"."company_execution_snapshot"-ARRAY['executionKind','coordinatorFlowBinding']) || '{"schemaVersion":1}'::jsonb)->'assignment') ?& ARRAY['id','inputRevision','inputSha256']
      AND ((("runs"."company_execution_snapshot"-ARRAY['executionKind','coordinatorFlowBinding']) || '{"schemaVersion":1}'::jsonb)->'assignment')-ARRAY['id','inputRevision','inputSha256']='{}'::jsonb
      AND jsonb_typeof(((("runs"."company_execution_snapshot"-ARRAY['executionKind','coordinatorFlowBinding']) || '{"schemaVersion":1}'::jsonb)->'assignment')->'id')='string' AND char_length(((("runs"."company_execution_snapshot"-ARRAY['executionKind','coordinatorFlowBinding']) || '{"schemaVersion":1}'::jsonb)->'assignment')->>'id') BETWEEN 1 AND 128
      AND (((("runs"."company_execution_snapshot"-ARRAY['executionKind','coordinatorFlowBinding']) || '{"schemaVersion":1}'::jsonb)->'assignment')->>'inputRevision')::numeric BETWEEN 1 AND 2147483647 AND mod((((("runs"."company_execution_snapshot"-ARRAY['executionKind','coordinatorFlowBinding']) || '{"schemaVersion":1}'::jsonb)->'assignment')->>'inputRevision')::numeric,1)=0
      AND ((("runs"."company_execution_snapshot"-ARRAY['executionKind','coordinatorFlowBinding']) || '{"schemaVersion":1}'::jsonb)->'assignment')->>'inputSha256' ~ '^[a-f0-9]{64}$'
      ELSE false END
    AND (CASE WHEN jsonb_typeof(((("runs"."company_execution_snapshot"-ARRAY['executionKind','coordinatorFlowBinding']) || '{"schemaVersion":1}'::jsonb)->'specialistBinding'))='object' AND jsonb_typeof(((("runs"."company_execution_snapshot"-ARRAY['executionKind','coordinatorFlowBinding']) || '{"schemaVersion":1}'::jsonb)->'specialistBinding')->'revision')='number' THEN
    ((("runs"."company_execution_snapshot"-ARRAY['executionKind','coordinatorFlowBinding']) || '{"schemaVersion":1}'::jsonb)->'specialistBinding') ?& ARRAY['id','revision','snapshotSha256']
    AND ((("runs"."company_execution_snapshot"-ARRAY['executionKind','coordinatorFlowBinding']) || '{"schemaVersion":1}'::jsonb)->'specialistBinding')-ARRAY['id','revision','snapshotSha256']='{}'::jsonb
    AND jsonb_typeof(((("runs"."company_execution_snapshot"-ARRAY['executionKind','coordinatorFlowBinding']) || '{"schemaVersion":1}'::jsonb)->'specialistBinding')->'id')='string' AND char_length(((("runs"."company_execution_snapshot"-ARRAY['executionKind','coordinatorFlowBinding']) || '{"schemaVersion":1}'::jsonb)->'specialistBinding')->>'id') BETWEEN 1 AND 128
    AND (((("runs"."company_execution_snapshot"-ARRAY['executionKind','coordinatorFlowBinding']) || '{"schemaVersion":1}'::jsonb)->'specialistBinding')->>'revision')::numeric BETWEEN 1 AND 2147483647 AND mod((((("runs"."company_execution_snapshot"-ARRAY['executionKind','coordinatorFlowBinding']) || '{"schemaVersion":1}'::jsonb)->'specialistBinding')->>'revision')::numeric,1)=0
    AND jsonb_typeof(((("runs"."company_execution_snapshot"-ARRAY['executionKind','coordinatorFlowBinding']) || '{"schemaVersion":1}'::jsonb)->'specialistBinding')->'snapshotSha256')='string' AND ((("runs"."company_execution_snapshot"-ARRAY['executionKind','coordinatorFlowBinding']) || '{"schemaVersion":1}'::jsonb)->'specialistBinding')->>'snapshotSha256' ~ '^[a-f0-9]{64}$'
    ELSE false END) IS TRUE
    AND ((("runs"."company_execution_snapshot"-ARRAY['executionKind','coordinatorFlowBinding']) || '{"schemaVersion":1}'::jsonb)->'authority') ?& ARRAY['actor','witness'] AND ((("runs"."company_execution_snapshot"-ARRAY['executionKind','coordinatorFlowBinding']) || '{"schemaVersion":1}'::jsonb)->'authority')-ARRAY['actor','witness']='{}'::jsonb
    AND ((("runs"."company_execution_snapshot"-ARRAY['executionKind','coordinatorFlowBinding']) || '{"schemaVersion":1}'::jsonb)->'authority'->'actor') ?& ARRAY['kind','id','runId','attemptId'] AND ((("runs"."company_execution_snapshot"-ARRAY['executionKind','coordinatorFlowBinding']) || '{"schemaVersion":1}'::jsonb)->'authority'->'actor')-ARRAY['kind','id','runId','attemptId']='{}'::jsonb
    AND ((("runs"."company_execution_snapshot"-ARRAY['executionKind','coordinatorFlowBinding']) || '{"schemaVersion":1}'::jsonb)->'authority'->'actor')->>'kind'='user' AND jsonb_typeof(((("runs"."company_execution_snapshot"-ARRAY['executionKind','coordinatorFlowBinding']) || '{"schemaVersion":1}'::jsonb)->'authority'->'actor')->'id')='string' AND char_length(((("runs"."company_execution_snapshot"-ARRAY['executionKind','coordinatorFlowBinding']) || '{"schemaVersion":1}'::jsonb)->'authority'->'actor')->>'id') BETWEEN 1 AND 192
    AND ((("runs"."company_execution_snapshot"-ARRAY['executionKind','coordinatorFlowBinding']) || '{"schemaVersion":1}'::jsonb)->'authority'->'actor')->'runId'='null'::jsonb AND ((("runs"."company_execution_snapshot"-ARRAY['executionKind','coordinatorFlowBinding']) || '{"schemaVersion":1}'::jsonb)->'authority'->'actor')->'attemptId'='null'::jsonb
    AND ((("runs"."company_execution_snapshot"-ARRAY['executionKind','coordinatorFlowBinding']) || '{"schemaVersion":1}'::jsonb)->'authority'->'witness') ?& ARRAY['kind','owner','authorityId','revision','action'] AND ((("runs"."company_execution_snapshot"-ARRAY['executionKind','coordinatorFlowBinding']) || '{"schemaVersion":1}'::jsonb)->'authority'->'witness')-ARRAY['kind','owner','authorityId','revision','action']='{}'::jsonb
    AND ((("runs"."company_execution_snapshot"-ARRAY['executionKind','coordinatorFlowBinding']) || '{"schemaVersion":1}'::jsonb)->'authority'->'witness')->>'kind'='company_grant' AND ((("runs"."company_execution_snapshot"-ARRAY['executionKind','coordinatorFlowBinding']) || '{"schemaVersion":1}'::jsonb)->'authority'->'witness')->'owner'=(("runs"."company_execution_snapshot"-ARRAY['executionKind','coordinatorFlowBinding']) || '{"schemaVersion":1}'::jsonb)->'owner' AND ((("runs"."company_execution_snapshot"-ARRAY['executionKind','coordinatorFlowBinding']) || '{"schemaVersion":1}'::jsonb)->'authority'->'witness')->>'action'='assignments:update'
    AND jsonb_typeof(((("runs"."company_execution_snapshot"-ARRAY['executionKind','coordinatorFlowBinding']) || '{"schemaVersion":1}'::jsonb)->'authority'->'witness')->'authorityId')='string' AND char_length(((("runs"."company_execution_snapshot"-ARRAY['executionKind','coordinatorFlowBinding']) || '{"schemaVersion":1}'::jsonb)->'authority'->'witness')->>'authorityId') BETWEEN 1 AND 128
    AND CASE WHEN jsonb_typeof(((("runs"."company_execution_snapshot"-ARRAY['executionKind','coordinatorFlowBinding']) || '{"schemaVersion":1}'::jsonb)->'authority'->'witness')->'revision')='number' THEN (((("runs"."company_execution_snapshot"-ARRAY['executionKind','coordinatorFlowBinding']) || '{"schemaVersion":1}'::jsonb)->'authority'->'witness')->>'revision')::numeric BETWEEN 1 AND 2147483647 AND mod((((("runs"."company_execution_snapshot"-ARRAY['executionKind','coordinatorFlowBinding']) || '{"schemaVersion":1}'::jsonb)->'authority'->'witness')->>'revision')::numeric,1)=0 ELSE false END
    AND pg_column_size((("runs"."company_execution_snapshot"-ARRAY['executionKind','coordinatorFlowBinding']) || '{"schemaVersion":1}'::jsonb))<=32768) IS TRUE
    AND pg_column_size("runs"."company_execution_snapshot")<=32768) IS TRUE)) IS TRUE);
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
    IF (NEW.created_by_user_id IS NOT NULL AND NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id) OR ROW(NEW.company_id,NEW.company_execution_snapshot,NEW.project_id,NEW.task_id,NEW.flow_id,NEW.flow_revision_id,NEW.local_package_id,NEW.run_kind,NEW.source_agent_id,NEW.agent_kind,NEW.agent_workspace,NEW.result_contract,NEW.agent_config,NEW.execution_policy)
      IS DISTINCT FROM ROW(OLD.company_id,OLD.company_execution_snapshot,OLD.project_id,OLD.task_id,OLD.flow_id,OLD.flow_revision_id,OLD.local_package_id,OLD.run_kind,OLD.source_agent_id,OLD.agent_kind,OLD.agent_workspace,OLD.result_contract,OLD.agent_config,OLD.execution_policy) THEN
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
      AND (NEW.company_execution_snapshot->'schemaVersion'='1'::jsonb OR l.role='coordinator')
  ) THEN
    RAISE EXCEPTION 'Company execution reservation requires its atomic immutable assignment/input link'
      USING ERRCODE='23514', CONSTRAINT='runs_company_execution_link_check';
  END IF;
  RETURN NULL;
END;
$$;
