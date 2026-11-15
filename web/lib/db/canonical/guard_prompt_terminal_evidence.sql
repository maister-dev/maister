CREATE OR REPLACE FUNCTION public.guard_prompt_terminal_evidence()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  retiring boolean := OLD.retired_at IS NULL AND NEW.retired_at IS NOT NULL;
BEGIN
  IF (OLD.receipt_evidence IS NOT NULL
      AND NEW.receipt_evidence IS DISTINCT FROM OLD.receipt_evidence
      AND NOT (retiring AND NEW.receipt_evidence IS NULL))
    OR (OLD.terminal_event_id IS NOT NULL AND NEW.terminal_event_id IS DISTINCT FROM OLD.terminal_event_id)
    OR (OLD.settled_from IS NOT NULL AND NEW.settled_from IS DISTINCT FROM OLD.settled_from)
    OR (OLD.terminal_evidence_sha256 IS NOT NULL AND (
      ROW(NEW.terminal_evidence_sha256, NEW.state, NEW.completed_at)
        IS DISTINCT FROM ROW(OLD.terminal_evidence_sha256, OLD.state, OLD.completed_at)
      OR (NEW.result IS DISTINCT FROM OLD.result AND NOT (retiring AND NEW.result IS NULL))
      OR (NEW.last_error IS DISTINCT FROM OLD.last_error AND NOT (retiring AND NEW.last_error IS NULL))
      OR (OLD.retired_at IS NOT NULL AND NEW.receipt_evidence IS DISTINCT FROM OLD.receipt_evidence)))
  THEN
    RAISE EXCEPTION 'verified prompt evidence is immutable'
      USING ERRCODE = '23514', CONSTRAINT = 'execution_commands_immutable_terminal_evidence';
  END IF;
  RETURN NEW;
END;
$function$;
