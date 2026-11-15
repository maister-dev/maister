CREATE OR REPLACE FUNCTION public.check_company_run_domain_event()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP='UPDATE' AND (OLD.company_id IS NOT NULL OR NEW.company_id IS NOT NULL) AND
     ROW(NEW.company_id,NEW.project_id,NEW.run_id,NEW.task_id,NEW.kind) IS DISTINCT FROM
     ROW(OLD.company_id,OLD.project_id,OLD.run_id,OLD.task_id,OLD.kind) THEN
    RAISE EXCEPTION 'Company event ownership and kind are immutable'
      USING ERRCODE='23514', CONSTRAINT='domain_events_company_identity_check';
  END IF;
  IF NEW.company_id IS NOT NULL AND NEW.run_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM runs execution WHERE execution.id=NEW.run_id
      AND execution.company_id=NEW.company_id AND execution.project_id IS NULL
      AND execution.company_execution_snapshot IS NOT NULL
      AND (
        (execution.run_kind='agent' AND execution.agent_kind='operational')
        OR (
          execution.run_kind='flow' AND execution.agent_kind IS NULL
          AND execution.company_execution_snapshot->>'schemaVersion'='2'
          AND execution.company_execution_snapshot->>'executionKind'='flow'
          AND execution.agent_workspace='none' AND execution.persistent=false
          AND execution.task_id IS NULL AND execution.flow_id IS NULL
          AND execution.result_contract->>'kind'='flow_export'
          AND execution.result_contract->'required'='true'::jsonb
          AND execution.result_contract->>'flowRevisionId'=execution.flow_revision_id
        )
      )
  ) THEN
    RAISE EXCEPTION 'Company run facts require the exact retained execution owner'
      USING ERRCODE='23514', CONSTRAINT='domain_events_company_run_reference_check';
  END IF;
  RETURN NEW;
END $function$;
