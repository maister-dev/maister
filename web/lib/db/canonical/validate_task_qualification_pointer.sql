CREATE OR REPLACE FUNCTION public.validate_task_qualification_pointer()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE owner_task tasks%ROWTYPE; assessment task_qualifications%ROWTYPE; source runs%ROWTYPE; result_value jsonb;
BEGIN
  IF TG_TABLE_NAME='tasks' THEN SELECT * INTO owner_task FROM tasks WHERE id=NEW.id;
  ELSE SELECT * INTO owner_task FROM tasks WHERE id=NEW.task_id; END IF;
  IF NOT FOUND OR owner_task.current_qualification_id IS NULL THEN RETURN NULL; END IF;
  SELECT * INTO assessment FROM task_qualifications WHERE id=owner_task.current_qualification_id;
  IF NOT FOUND OR assessment.task_id<>owner_task.id OR assessment.project_id<>owner_task.project_id OR assessment.input_revision<>owner_task.qualification_input_revision OR assessment.revision<>owner_task.current_qualification_revision OR assessment.publication_state<>'accepted' THEN
    RAISE EXCEPTION 'current task qualification must be a matching accepted assessment' USING ERRCODE='23514',CONSTRAINT='tasks_qualification_pointer_scope';
  END IF;
  RETURN NULL;
END $function$;
