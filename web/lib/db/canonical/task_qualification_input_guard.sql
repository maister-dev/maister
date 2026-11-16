CREATE OR REPLACE FUNCTION public.task_qualification_input_guard()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE policy text; project_base text; semantic_change boolean;
BEGIN
  SELECT coalesce(task_qualification_override,task_qualification_baseline),main_branch INTO policy,project_base FROM projects WHERE id=NEW.project_id;
  IF TG_OP='INSERT' THEN
    IF NEW.qualification_mode <> 'execution_child' AND policy='required' THEN NEW.qualification_mode:='required'; END IF;
    RETURN NEW;
  END IF;
  IF OLD.qualification_mode='required' AND NEW.qualification_mode='legacy' THEN
    RAISE EXCEPTION 'required task qualification cannot be waived' USING ERRCODE='23514',CONSTRAINT='tasks_qualification_required_monotonic';
  END IF;
  IF NEW.qualification_revision_counter < OLD.qualification_revision_counter THEN
    RAISE EXCEPTION 'qualification revision counter cannot decrease' USING ERRCODE='23514',CONSTRAINT='tasks_qualification_counter_monotonic';
  END IF;
  semantic_change := ROW(NEW.title,NEW.prompt,NEW.statement_revision,NEW.qualification_source_version,coalesce(NEW.base_branch,project_base),coalesce(NEW.target_branch,project_base)) IS DISTINCT FROM ROW(OLD.title,OLD.prompt,OLD.statement_revision,OLD.qualification_source_version,coalesce(OLD.base_branch,project_base),coalesce(OLD.target_branch,project_base));
  IF semantic_change OR NEW.qualification_input_revision > OLD.qualification_input_revision THEN
    NEW.qualification_input_revision:=OLD.qualification_input_revision+1;
    NEW.current_qualification_id:=NULL; NEW.current_qualification_revision:=NULL;
    IF OLD.qualification_mode='execution_child' THEN NEW.qualification_mode:='required'; NEW.qualification_child_proof:=NULL; END IF;
    IF NEW.qualification_mode<>'legacy' THEN NEW.launch_mode:=NULL; NEW.launch_armed_at:=NULL; NEW.queue_claimed_at:=NULL; END IF;
  ELSIF NEW.qualification_input_revision<>OLD.qualification_input_revision THEN
    RAISE EXCEPTION 'qualification input revision cannot decrease' USING ERRCODE='23514',CONSTRAINT='tasks_qualification_input_monotonic';
  END IF;
  IF OLD.qualification_mode<>NEW.qualification_mode AND NEW.qualification_mode='required' THEN
    NEW.current_qualification_id:=NULL; NEW.current_qualification_revision:=NULL;
    NEW.launch_mode:=NULL; NEW.launch_armed_at:=NULL; NEW.queue_claimed_at:=NULL;
  END IF;
  RETURN NEW;
END $function$;
