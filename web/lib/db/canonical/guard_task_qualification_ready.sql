CREATE OR REPLACE FUNCTION public.guard_task_qualification_ready()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE assessment task_qualifications%ROWTYPE;
BEGIN
  IF NEW.qualification_mode='required' AND TG_OP='UPDATE'
    AND NEW.qualification_input_revision>OLD.qualification_input_revision THEN
    IF OLD.triage_status='flagged' AND OLD.triage_flag_origin IS DISTINCT FROM 'qualification' THEN
      NEW.triage_status:='flagged'; NEW.triage_flag_origin:=OLD.triage_flag_origin;
      NEW.launch_mode:=NULL; NEW.launch_armed_at:=NULL;
    ELSE
      NEW.triage_status:=NULL; NEW.triage_flag_origin:=NULL;
    END IF;
  END IF;
  IF NEW.triage_status IS DISTINCT FROM 'flagged' THEN NEW.triage_flag_origin:=NULL; END IF;
  IF NEW.qualification_mode<>'required' THEN RETURN NEW; END IF;
  IF NEW.triage_status IS DISTINCT FROM 'triaged' AND NEW.launch_mode IS DISTINCT FROM 'auto' THEN RETURN NEW; END IF;
  SELECT * INTO assessment FROM task_qualifications WHERE id=NEW.current_qualification_id
    AND task_id=NEW.id AND project_id=NEW.project_id;
  IF NOT FOUND OR assessment.publication_state<>'accepted' OR assessment.value->>'decision'<>'ready'
    OR assessment.input_revision<>NEW.qualification_input_revision OR assessment.revision<>NEW.current_qualification_revision THEN
    RAISE EXCEPTION 'required task cannot be readied or enqueued without current accepted qualification'
      USING ERRCODE='23514',CONSTRAINT='tasks_qualification_readiness_required';
  END IF;
  RETURN NEW;
END $function$;
