CREATE OR REPLACE FUNCTION public.validate_task_qualification_publication()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE assessment task_qualifications%ROWTYPE; owner_task tasks%ROWTYPE; source runs%ROWTYPE; result_value jsonb;
BEGIN
  SELECT * INTO assessment FROM task_qualifications WHERE id=NEW.id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT * INTO owner_task FROM tasks WHERE id=assessment.task_id;
  IF NOT FOUND OR owner_task.project_id<>assessment.project_id OR assessment.revision>owner_task.qualification_revision_counter THEN
    RAISE EXCEPTION 'qualification assessment must belong to its task and allocated revision' USING ERRCODE='23514',CONSTRAINT='task_qualification_assessment_scope';
  END IF;
  IF assessment.author_kind='agent_run' AND assessment.publication_state<>'rejected' THEN
    SELECT * INTO source FROM runs WHERE id=assessment.author_run_id;
    IF NOT FOUND OR source.project_id<>assessment.project_id OR source.task_id<>assessment.task_id OR source.agent_kind IS DISTINCT FROM 'operational' OR source.task_qualification_snapshot->>'role' IS DISTINCT FROM 'qualifier' OR source.task_qualification_snapshot->>'target' IS DISTINCT FROM assessment.evidence_target OR source.task_qualification_snapshot->>'sha' IS DISTINCT FROM assessment.evidence_sha OR coalesce(source.source_agent_id,source.agent_id) IS DISTINCT FROM assessment.author_identity OR NOT (source.result_contract->'definition'->'taskQualification'->>'role'='qualifier') IS TRUE THEN
      RAISE EXCEPTION 'qualification requires its bound declared qualifier run' USING ERRCODE='23514',CONSTRAINT='task_qualification_author_scope';
    END IF;
    IF assessment.publication_state='accepted' THEN
      IF NOT (source.operational_terminal->'successful'='true'::jsonb AND source.operational_terminal->>'validation'='valid' AND source.operational_terminal->>'integrity'='clean') IS TRUE THEN
        RAISE EXCEPTION 'agent qualification requires clean validated terminal evidence' USING ERRCODE='23514',CONSTRAINT='task_qualification_source_evidence';
      END IF;
      SELECT value INTO result_value FROM run_results WHERE run_id=source.id AND revision::text=source.operational_terminal->>'resultRevision';
      IF NOT (result_value->'references' @> jsonb_build_array(jsonb_build_object('kind','other','id',assessment.id,'state','confirmed'))) IS TRUE THEN
        RAISE EXCEPTION 'operational result must reference its qualification receipt' USING ERRCODE='23514',CONSTRAINT='task_qualification_source_reference';
      END IF;
    END IF;
  END IF;
  RETURN NULL;
END $function$;
