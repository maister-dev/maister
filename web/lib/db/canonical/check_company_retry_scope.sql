CREATE OR REPLACE FUNCTION public.check_company_retry_scope()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.company_id IS NULL THEN RETURN NEW; END IF;
  IF jsonb_typeof(NEW.recipe->'specialistBinding'->'revision') IS DISTINCT FROM 'number' OR
     jsonb_typeof(NEW.recipe->'assignment'->'inputRevision') IS DISTINCT FROM 'number' OR
     (NEW.recipe->'coordinatorFlowBinding'<>'null'::jsonb AND jsonb_typeof(NEW.recipe->'coordinatorFlowBinding'->'revision') IS DISTINCT FROM 'number') THEN
    RAISE EXCEPTION 'company retry configuration and input revisions must be numbers'
      USING ERRCODE='23514', CONSTRAINT='company_retry_reference_check';
  END IF;
  IF NEW.actor_user_id IS NULL OR NEW.actor_identity <> 'user:' || NEW.actor_user_id OR NOT EXISTS (
    SELECT 1 FROM company_specialist_bindings b
    JOIN company_specialist_binding_revisions r ON r.binding_id=b.id
      AND r.revision::numeric=(NEW.recipe->'specialistBinding'->>'revision')::numeric
    JOIN specialist_assignments a ON a.id=NEW.recipe->'assignment'->>'id'
      AND a.company_id=b.company_id AND a.project_id IS NULL AND a.specialist_binding_id=b.id
    JOIN specialist_input_revisions i ON i.assignment_id=a.id
      AND i.revision::numeric=(NEW.recipe->'assignment'->>'inputRevision')::numeric
    WHERE b.id=NEW.recipe->'specialistBinding'->>'id' AND b.company_id=NEW.company_id
      AND b.agent_id=NEW.source_agent_id AND r.snapshot_digest=NEW.recipe->'specialistBinding'->>'snapshotSha256'
      AND i.digest=NEW.recipe->'assignment'->>'inputSha256'
      AND r.snapshot->'definition'=NEW.recipe->'definition'->'parsed'
      AND r.snapshot->>'packageInstallId'=NEW.recipe->'definition'->>'packageInstallId'
      AND r.snapshot->>'packageRevision'=NEW.recipe->'definition'->>'resolvedRevision'
      AND r.snapshot->'effectiveConfiguration'=NEW.recipe->'configuration'
      AND i.standing_definition->'definition'=r.snapshot->'definition'
      AND i.scheduled_request IS NOT DISTINCT FROM NULLIF(NEW.recipe->'scheduledRequestSnapshot','null'::jsonb)
  ) THEN
    RAISE EXCEPTION 'company retry must retain its owned exact specialist configuration and assignment input'
      USING ERRCODE='23514', CONSTRAINT='company_retry_reference_check';
  END IF;
  IF NEW.recipe->'coordinatorFlowBinding'<>'null'::jsonb AND NOT EXISTS (
    SELECT 1 FROM company_flow_bindings b JOIN company_flow_binding_revisions r ON r.binding_id=b.id
      AND r.revision::numeric=(NEW.recipe->'coordinatorFlowBinding'->>'revision')::numeric
    WHERE b.id=NEW.recipe->'coordinatorFlowBinding'->>'id' AND b.company_id=NEW.company_id
      AND r.snapshot_digest=NEW.recipe->'coordinatorFlowBinding'->>'snapshotSha256'
      AND r.snapshot->>'specialistBindingId'=NEW.recipe->'specialistBinding'->>'id'
      AND (r.snapshot->>'specialistRevision')::numeric=(NEW.recipe->'specialistBinding'->>'revision')::numeric
  ) THEN
    RAISE EXCEPTION 'company retry must retain its owned exact coordinator configuration'
      USING ERRCODE='23514', CONSTRAINT='company_retry_coordinator_reference_check';
  END IF;
  RETURN NEW;
END;
$function$;
