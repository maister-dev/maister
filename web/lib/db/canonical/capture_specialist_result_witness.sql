CREATE OR REPLACE FUNCTION public.capture_specialist_result_witness()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE execution runs%ROWTYPE; subject specialist_assignments%ROWTYPE; effective specialist_input_revisions%ROWTYPE; result run_results%ROWTYPE;
BEGIN
  IF TG_OP='UPDATE' THEN
    IF NEW.assignment_result IS DISTINCT FROM OLD.assignment_result OR
      (OLD.assignment_result IS NOT NULL AND ROW(NEW.id,NEW.kind,NEW.company_id,NEW.project_id,NEW.run_id,NEW.occurred_at)
        IS DISTINCT FROM ROW(OLD.id,OLD.kind,OLD.company_id,OLD.project_id,OLD.run_id,OLD.occurred_at)) THEN
      RAISE EXCEPTION 'Native result event witnesses and routing are immutable'
        USING ERRCODE='23514',CONSTRAINT='specialist_result_event_immutable';
    END IF;
    RETURN NEW;
  END IF;
  NEW.assignment_result:=NULL;
  IF NEW.run_id IS NULL OR NEW.kind NOT IN ('run.done','run.review','run.review_opened') THEN RETURN NEW; END IF;
  SELECT * INTO execution FROM runs WHERE id=NEW.run_id FOR SHARE;
  IF NOT FOUND OR execution.knowledge_access->>'state' IS DISTINCT FROM 'complete'
    OR NOT ((NEW.kind='run.done' AND execution.status='Done') OR (NEW.kind IN ('run.review','run.review_opened') AND execution.status='Review')) THEN RETURN NEW; END IF;
  SELECT assignment.* INTO subject FROM specialist_run_links link
    JOIN specialist_assignments assignment ON assignment.id=link.assignment_id
    WHERE link.run_id=execution.id AND link.role IN ('specialist','coordinator','continuation') AND link.work_id IS NULL;
  IF NOT FOUND OR subject.company_id IS DISTINCT FROM execution.company_id OR subject.project_id IS DISTINCT FROM execution.project_id
    OR subject.company_id IS DISTINCT FROM NEW.company_id OR subject.project_id IS DISTINCT FROM NEW.project_id
    OR subject.requester->>'kind' IS DISTINCT FROM 'user' THEN RETURN NEW; END IF;
  SELECT * INTO effective FROM specialist_input_revisions input
    WHERE input.assignment_id=subject.id AND specialist_run_has_input(execution.id,subject.id,input.revision,input.digest)
    ORDER BY input.revision DESC LIMIT 1 FOR SHARE;
  IF NOT FOUND THEN RETURN NEW; END IF;
  SELECT * INTO result FROM run_results WHERE run_id=execution.id AND validity='valid' FOR SHARE;
  IF NOT FOUND OR result.schema_ref IS DISTINCT FROM execution.result_contract->>'schemaRef'
    OR result.schema_sha256 IS DISTINCT FROM execution.result_contract->>'sha256'
    OR to_jsonb(result.schema_version) IS DISTINCT FROM execution.result_contract->'schemaVersion'
    OR result.schema_ref IS DISTINCT FROM effective.objective_input->'expectedResult'->>'schemaRef'
    OR result.schema_sha256 IS DISTINCT FROM effective.objective_input->'expectedResult'->>'sha256'
    OR to_jsonb(result.schema_version) IS DISTINCT FROM effective.objective_input->'expectedResult'->'schemaVersion'
    OR NOT (execution.knowledge_access->'restrictions' @> jsonb_build_array(jsonb_build_object(
      'kind','assignment_input','assignmentId',subject.id,'inputRevision',effective.revision,'inputSha256',effective.digest))) THEN RETURN NEW; END IF;
  NEW.assignment_result:=jsonb_build_object(
    'schemaVersion',1,
    'owner',CASE WHEN subject.company_id IS NOT NULL THEN jsonb_build_object('kind','company','companyId',subject.company_id) ELSE jsonb_build_object('kind','project','projectId',subject.project_id) END,
    'assignmentId',subject.id,'inputRevision',effective.revision,'inputSha256',effective.digest,
    'requesterUserId',subject.requester->>'id','destination',subject.destination,
    'runId',execution.id,'resultRevision',result.revision,
    'resultSha256',encode(sha256(convert_to(jsonb_build_object('schemaRef',result.schema_ref,'schemaVersion',result.schema_version,'schemaSha256',result.schema_sha256,'value',result.value)::text,'UTF8')),'hex'),
    'witnessAlgorithm','postgres_jsonb_sha256_v1','schemaRef',result.schema_ref,'resultSchemaVersion',result.schema_version,'schemaSha256',result.schema_sha256,
    'sourceRestrictions',execution.knowledge_access->'restrictions');
  RETURN NEW;
END $function$;
