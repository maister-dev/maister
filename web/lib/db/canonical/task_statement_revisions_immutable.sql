CREATE OR REPLACE FUNCTION public.task_statement_revisions_immutable()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM tasks WHERE id = OLD.task_id) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'task_statement_revisions_immutable',
    MESSAGE = 'an accepted task statement revision is immutable';
END $function$;
