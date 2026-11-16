CREATE OR REPLACE FUNCTION public.specialist_final_result_id(subject_id text, selected_input integer, selected_run text, selected_result integer)
 RETURNS text
 LANGUAGE sql
 STABLE
AS $function$
  SELECT result.id
  FROM specialist_assignments subject
  JOIN specialist_input_revisions input ON input.assignment_id=subject.id AND input.revision=selected_input
  JOIN specialist_run_links link ON link.assignment_id=subject.id AND link.run_id=selected_run
  JOIN runs source ON source.id=link.run_id
  JOIN run_results result ON result.run_id=source.id AND result.revision=selected_result
  WHERE subject.id=subject_id AND subject.input_revision=selected_input
    AND specialist_current_root_id(subject.id,selected_input)=selected_run
    AND NOT specialist_other_unsettled_root(subject.id,selected_run)
    AND link.role IN ('specialist','coordinator','continuation') AND link.work_id IS NULL
    AND source.parent_run_id IS NULL AND source.status='Done'
    AND source.project_id IS NOT DISTINCT FROM subject.project_id
    AND source.company_id IS NOT DISTINCT FROM subject.company_id
    AND source.knowledge_access->>'state'='complete'
    AND result.validity='valid' AND result.value IS NOT NULL
    AND source.result_contract->'required'='true'::jsonb
    AND input.objective_input->'expectedResult'->'required'='true'::jsonb
    AND result.schema_ref=input.objective_input->'expectedResult'->>'schemaRef'
    AND result.schema_version::text=input.objective_input->'expectedResult'->>'schemaVersion'
    AND result.schema_sha256=input.objective_input->'expectedResult'->>'sha256'
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(input.objective_input->'verification') requirement
      WHERE requirement->'required'='true'::jsonb AND (
        (requirement->>'kind'='result' AND requirement->>'referenceId' IS NOT NULL AND requirement->>'referenceId'<>result.id)
        OR (requirement->>'kind' IN ('effect','health') AND NOT specialist_stand_requirement_met(
          subject.id,input.revision,input.digest,input.objective_input,result.value,
          requirement->>'kind',requirement->>'referenceId'))
        OR requirement->>'kind' NOT IN ('result','effect','health')
      )
    )
    AND NOT EXISTS (
      SELECT 1 FROM specialist_work work LEFT JOIN runs child ON child.id=work.child_run_id
      WHERE work.assignment_id=subject.id AND work.input_revision=selected_input AND work.decision_state='open'
        AND (child.id IS NULL OR child.status NOT IN ('Done','Failed','Crashed','Abandoned'))
    )
$function$;
