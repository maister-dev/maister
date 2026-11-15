CREATE OR REPLACE FUNCTION public.validate_task_qualification_v1(v jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 IMMUTABLE
AS $function$
DECLARE c jsonb; dimensions text[] := ARRAY[]::text[]; evidence_ids text[] := ARRAY[]::text[];
BEGIN
  IF NOT (jsonb_typeof(v)='object' AND v ?& ARRAY['schemaVersion','requestType','decision','checks','reasonCodes','nextActions','evidenceRefs'] AND v->'schemaVersion'='1'::jsonb AND v->>'requestType' IN ('bug','feature','maintenance','question') AND v->>'decision' IN ('ready','needs_information','needs_review','not_actionable') AND jsonb_typeof(v->'checks')='array' AND jsonb_array_length(v->'checks')=7 AND jsonb_typeof(v->'reasonCodes')='array' AND jsonb_array_length(v->'reasonCodes')<=16 AND jsonb_typeof(v->'nextActions')='array' AND jsonb_array_length(v->'nextActions')<=16 AND jsonb_typeof(v->'evidenceRefs')='array' AND jsonb_array_length(v->'evidenceRefs')<=32) IS TRUE THEN RETURN false; END IF;
  IF (SELECT count(*) FROM jsonb_object_keys(v)) <> 7 THEN RETURN false; END IF;
  FOR c IN SELECT value FROM jsonb_array_elements(v->'evidenceRefs') LOOP
    IF NOT (jsonb_typeof(c)='object' AND c ?& ARRAY['id','kind','reference'] AND c->>'kind' IN ('repository','task','run','source','human_attestation') AND length(c->>'id') BETWEEN 1 AND 256 AND length(c->>'reference') BETWEEN 1 AND 256) IS TRUE THEN RETURN false; END IF;
    IF c->>'id'=ANY(evidence_ids) THEN RETURN false; END IF;
    evidence_ids := array_append(evidence_ids,c->>'id');
  END LOOP;
  FOR c IN SELECT value FROM jsonb_array_elements(v->'checks') LOOP
    IF NOT (jsonb_typeof(c)='object' AND c ?& ARRAY['dimension','state','rationale','evidenceIds'] AND c->>'dimension' IN ('goal_scope','acceptance','consistency','constraints_dependencies','duplicates','relevance','bug_evidence') AND c->>'state' IN ('pass','fail','unknown','not_applicable') AND length(c->>'rationale') BETWEEN 1 AND 2000 AND jsonb_typeof(c->'evidenceIds')='array' AND jsonb_array_length(c->'evidenceIds')<=32) IS TRUE THEN RETURN false; END IF;
    IF c->>'dimension'=ANY(dimensions) THEN RETURN false; END IF;
    dimensions := array_append(dimensions,c->>'dimension');
    IF c->>'state'='not_applicable' AND (c->>'dimension'<>'bug_evidence' OR v->>'requestType'='bug') THEN RETURN false; END IF;
    IF v->>'decision'='ready' AND c->>'state' NOT IN ('pass','not_applicable') THEN RETURN false; END IF;
    IF EXISTS(SELECT 1 FROM jsonb_array_elements_text(c->'evidenceIds') e(id) WHERE NOT e.id=ANY(evidence_ids)) THEN RETURN false; END IF;
  END LOOP;
  IF v->>'decision'<>'ready' AND (jsonb_array_length(v->'reasonCodes')=0 OR jsonb_array_length(v->'nextActions')=0) THEN RETURN false; END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements_text(v->'reasonCodes') r(code) WHERE r.code !~ '^[a-z][a-z0-9_]{0,255}$') OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(v->'nextActions') a(value) WHERE length(a.value) NOT BETWEEN 1 AND 2000) THEN RETURN false; END IF;
  IF v->>'decision'='ready' AND NOT EXISTS(
    SELECT 1 FROM jsonb_array_elements(v->'checks') check_entry(value), jsonb_array_elements(v->'evidenceRefs') reference_entry(value)
    WHERE check_entry.value->>'dimension'='relevance' AND reference_entry.value->>'kind'='repository' AND check_entry.value->'evidenceIds' @> jsonb_build_array(reference_entry.value->>'id')
  ) THEN RETURN false; END IF;
  IF v->>'decision'='not_actionable' AND jsonb_array_length(v->'evidenceRefs')=0 THEN RETURN false; END IF;
  RETURN true;
END $function$;
