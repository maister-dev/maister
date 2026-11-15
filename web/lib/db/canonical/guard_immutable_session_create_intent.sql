CREATE OR REPLACE FUNCTION public.guard_immutable_session_create_intent()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  retiring boolean := OLD.retired_at IS NULL AND NEW.retired_at IS NOT NULL;
  compacting boolean;
BEGIN
  IF OLD.create_intent IS NULL THEN
    IF NEW.create_intent IS NOT NULL THEN
      RAISE EXCEPTION 'A private create intent must be admitted atomically with its original command'
        USING ERRCODE='23514',CONSTRAINT='execution_commands_immutable_create_intent';
    END IF;
    RETURN NEW;
  END IF;
  compacting := retiring
    AND OLD.state IN ('succeeded','failed','fenced')
    AND OLD.completed_at IS NOT NULL
    AND NEW.retired_at >= OLD.completed_at + interval '7 days'
    AND NEW.create_intent IS NULL
    AND NEW.request_canonical_json IS NULL
    AND NEW.receipt_evidence IS NULL
    AND NEW.result IS NULL AND NEW.last_error IS NULL
    AND NEW.payload = '{}'::jsonb
    AND NEW.updated_at = NEW.retired_at
    AND ROW(NEW.state,NEW.completed_at) IS NOT DISTINCT FROM ROW(OLD.state,OLD.completed_at)
    AND NOT EXISTS(SELECT 1 FROM runs r WHERE r.id=OLD.run_id
      AND r.status NOT IN ('Done','Failed','Crashed','Abandoned')
      AND NOT(r.run_kind='librarian' AND r.status='NeedsInputIdle'));
  IF ROW(NEW.id,NEW.run_id,NEW.execution_assignment_id,NEW.execution_host_id,
      NEW.assignment_epoch,NEW.kind,NEW.target_session_id,NEW.created_at,
      NEW.owner_kind,NEW.owner_ref,NEW.logical_operation_key,NEW.request_schema,NEW.request_sha256)
    IS DISTINCT FROM ROW(OLD.id,OLD.run_id,OLD.execution_assignment_id,OLD.execution_host_id,
      OLD.assignment_epoch,OLD.kind,OLD.target_session_id,OLD.created_at,
      OLD.owner_kind,OLD.owner_ref,OLD.logical_operation_key,OLD.request_schema,OLD.request_sha256)
    OR ((NEW.create_intent IS DISTINCT FROM OLD.create_intent
      OR NEW.request_canonical_json IS DISTINCT FROM OLD.request_canonical_json
      OR NEW.payload IS DISTINCT FROM OLD.payload
      OR NEW.retired_at IS DISTINCT FROM OLD.retired_at) AND NOT compacting)
  THEN
    RAISE EXCEPTION 'The admitted private create request, owner and continuation are immutable'
      USING ERRCODE='23514',CONSTRAINT='execution_commands_immutable_create_intent';
  END IF;
  RETURN NEW;
END $function$;
