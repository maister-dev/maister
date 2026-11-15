CREATE OR REPLACE FUNCTION public.guard_immutable_command_request()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF OLD.request_schema = 'maister.command.request.v2' AND (
    ROW(NEW.id, NEW.run_id, NEW.execution_assignment_id, NEW.execution_host_id,
        NEW.assignment_epoch, NEW.kind, NEW.target_session_id, NEW.created_at,
        NEW.owner_kind, NEW.owner_ref, NEW.logical_operation_key,
        NEW.request_schema, NEW.request_sha256)
    IS DISTINCT FROM
    ROW(OLD.id, OLD.run_id, OLD.execution_assignment_id, OLD.execution_host_id,
        OLD.assignment_epoch, OLD.kind, OLD.target_session_id, OLD.created_at,
        OLD.owner_kind, OLD.owner_ref, OLD.logical_operation_key,
        OLD.request_schema, OLD.request_sha256)
    OR (NEW.request_canonical_json IS DISTINCT FROM OLD.request_canonical_json
      AND NOT (OLD.retired_at IS NULL AND NEW.retired_at IS NOT NULL
        AND NEW.request_canonical_json IS NULL)))
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      CONSTRAINT = 'execution_commands_immutable_request',
      MESSAGE = 'admitted command request and owner are immutable';
  END IF;
  RETURN NEW;
END;
$function$;
