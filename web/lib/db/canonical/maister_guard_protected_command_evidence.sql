CREATE OR REPLACE FUNCTION public.maister_guard_protected_command_evidence()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  protected_id text;
BEGIN
  SELECT c.id INTO protected_id FROM execution_commands c
  WHERE c.retired_at IS NULL
    AND CASE TG_TABLE_NAME
      WHEN 'runs' THEN c.run_id = OLD.id
      ELSE c.execution_assignment_id = OLD.id
    END
  LIMIT 1;
  IF protected_id IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      CONSTRAINT = 'execution_commands_protected_evidence',
      MESSAGE = 'protected execution command evidence blocks deletion',
      DETAIL = protected_id;
  END IF;
  RETURN OLD;
END;
$function$;
