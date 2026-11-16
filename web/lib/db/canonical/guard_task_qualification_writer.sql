CREATE OR REPLACE FUNCTION public.guard_task_qualification_writer()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE mode text;
BEGIN
  IF TG_TABLE_NAME='tasks' THEN
    mode:=NEW.qualification_mode;
  ELSE
    mode:=NEW.task_admission_snapshot->>'mode';
  END IF;
  IF mode IN ('required','execution_child') AND current_setting('maister.task_qualification_writer',true) IS DISTINCT FROM 'v1' THEN
    RAISE EXCEPTION 'task qualification writer v1 is required; keep incompatible writers stopped under upgrade maintenance'
      USING ERRCODE='23514',CONSTRAINT='task_qualification_writer_capability';
  END IF;
  RETURN NEW;
END $function$;
