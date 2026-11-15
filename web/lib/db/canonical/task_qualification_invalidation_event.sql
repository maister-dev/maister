CREATE OR REPLACE FUNCTION public.task_qualification_invalidation_event()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF (NEW.qualification_mode<>'legacy' OR OLD.qualification_mode<>'legacy') AND (NEW.qualification_input_revision IS DISTINCT FROM OLD.qualification_input_revision OR NEW.current_qualification_id IS DISTINCT FROM OLD.current_qualification_id) THEN
    INSERT INTO domain_events(kind,project_id,task_id,actor_type,occurred_at,payload) VALUES ('task.qualification_changed',NEW.project_id,NEW.id,'system',now(),jsonb_build_object('projectId',NEW.project_id,'taskId',NEW.id,'inputRevision',NEW.qualification_input_revision,'qualificationRevision',NEW.current_qualification_revision));
  END IF;
  RETURN NEW;
END $function$;
