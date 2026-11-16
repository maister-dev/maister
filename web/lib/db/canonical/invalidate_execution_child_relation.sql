CREATE OR REPLACE FUNCTION public.invalidate_execution_child_relation()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF OLD.kind='parent_of' THEN
    UPDATE tasks SET qualification_mode='required',qualification_child_proof=NULL,
      qualification_input_revision=qualification_input_revision+1
    WHERE id=OLD.to_task_id AND qualification_mode='execution_child'
      AND qualification_child_proof->>'relationId'=OLD.id;
  END IF;
  RETURN OLD;
END $function$;
