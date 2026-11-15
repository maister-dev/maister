CREATE OR REPLACE FUNCTION public.guard_specialist_context_insert()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE parent specialist_assignments%ROWTYPE;
DECLARE original specialist_input_revisions%ROWTYPE;
DECLARE previous_context specialist_context_revisions%ROWTYPE;
DECLARE item jsonb;
DECLARE previous_item jsonb;
BEGIN
  SELECT * INTO parent FROM specialist_assignments WHERE id=NEW.assignment_id FOR UPDATE;
  IF NOT FOUND OR NEW.base_revision<>parent.context_revision OR NEW.input_revision<>parent.input_revision
    OR parent.status IN ('completed','failed','cancelled') THEN
    RAISE EXCEPTION 'Context must append to the exact current nonterminal assignment input and context'
      USING ERRCODE='23514',CONSTRAINT='specialist_context_current_reference';
  END IF;
  SELECT * INTO original FROM specialist_input_revisions
    WHERE assignment_id=NEW.assignment_id AND revision=NEW.input_revision FOR SHARE;
  IF NOT FOUND OR NEW.context->>'inputSha256' IS DISTINCT FROM original.digest
    OR NOT (NEW.source_restrictions @> original.source_restrictions)
    OR NOT (NEW.source_restrictions @> jsonb_build_array(jsonb_build_object(
      'kind','assignment_input','assignmentId',NEW.assignment_id,'inputRevision',NEW.input_revision,'inputSha256',original.digest))) THEN
    RAISE EXCEPTION 'Context must retain its exact immutable input witness and source restrictions'
      USING ERRCODE='23514',CONSTRAINT='specialist_context_input_reference';
  END IF;
  IF NEW.base_revision>0 THEN
    SELECT * INTO previous_context FROM specialist_context_revisions WHERE assignment_id=NEW.assignment_id AND revision=NEW.base_revision FOR SHARE;
    IF NOT FOUND OR NOT (NEW.source_restrictions @> previous_context.source_restrictions) THEN
      RAISE EXCEPTION 'Context cannot erase its previously classified source restrictions'
        USING ERRCODE='23514',CONSTRAINT='specialist_context_source_retention';
    END IF;
  END IF;
  IF (SELECT count(DISTINCT value->'entry'->>'id') FROM jsonb_array_elements(NEW.context->'entries'))
    <>jsonb_array_length(NEW.context->'entries') THEN
    RAISE EXCEPTION 'Current context entry identities must be distinct'
      USING ERRCODE='23514',CONSTRAINT='specialist_context_entry_identity';
  END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(NEW.context->'entries') LOOP
    IF item->'introducedRevision'=to_jsonb(NEW.revision) THEN
      IF item->'actor' IS DISTINCT FROM NEW.actor
        OR item->'ownerEpoch' IS DISTINCT FROM COALESCE(to_jsonb(NEW.owner_epoch),'null'::jsonb) THEN
        RAISE EXCEPTION 'New context entries must retain the server-recorded revision author and ownership witness'
          USING ERRCODE='23514',CONSTRAINT='specialist_context_entry_attribution';
      END IF;
      IF item->'entry'->>'kind'='accepted' OR item->'entry'->>'state'='accepted' THEN
        IF NOT EXISTS (
          SELECT 1 FROM specialist_work_decisions decision JOIN specialist_work work
            ON work.id=decision.work_id AND work.work_revision=decision.work_revision
          JOIN run_results result ON result.id=decision.result_id AND result.run_id=work.child_run_id
          JOIN runs child ON child.id=work.child_run_id
          CROSS JOIN LATERAL (SELECT CASE
            WHEN child.result_contract->>'nativeContract'='evidence_findings_v1' THEN result.value->'findings'
            WHEN child.result_contract->>'kind'='agent_operational'
              AND child.result_contract->>'contractName'='operational_evidence_v2' THEN result.value->'findings'->'findings'
          END AS entries) original_findings
          WHERE decision.id=item->'entry'->'acceptedWork'->>'decisionId'
            AND decision.decision='accept' AND decision.actor=NEW.actor
            AND work.assignment_id=NEW.assignment_id AND decision.input_revision=NEW.input_revision
            AND work.decision_state='accepted'
            AND item->'entry'->>'kind'='accepted' AND item->'entry'->>'state'='accepted'
            AND item->'entry'->'acceptedWork'->>'workId'=work.id
            AND item->'entry'->'acceptedWork'->'workRevision'=to_jsonb(work.work_revision)
            AND item->'entry'->'acceptedWork'->>'childRunId'=work.child_run_id
            AND item->'entry'->'acceptedWork'->'resultRevision'=to_jsonb(decision.result_revision)
            AND item->'entry'->'acceptedWork'->'sourceFindings'=CASE
              WHEN jsonb_typeof(original_findings.entries)='array' THEN (
                SELECT coalesce(jsonb_agg(jsonb_build_object(
                  'childRunId',work.child_run_id,'resultRevision',decision.result_revision,'findingId',finding.value->>'id'
                ) ORDER BY finding.ordinality),'[]'::jsonb)
                FROM jsonb_array_elements(original_findings.entries) WITH ORDINALITY finding
              )
              ELSE '[]'::jsonb END
        ) THEN
          RAISE EXCEPTION 'Accepted work requires its governed exact-result decision'
            USING ERRCODE='23514',CONSTRAINT='specialist_context_acceptance_unavailable';
        END IF;
      END IF;
      IF item->'entry' ? 'supersedesEntryId' AND NOT EXISTS(
        SELECT 1 FROM jsonb_array_elements(COALESCE(previous_context.context->'entries','[]'::jsonb)) old_item
        WHERE old_item->'entry'->>'id'=item->'entry'->>'supersedesEntryId'
      ) THEN
        RAISE EXCEPTION 'A replacement must identify an entry in the exact base context'
          USING ERRCODE='23514',CONSTRAINT='specialist_context_entry_replacement';
      END IF;
    ELSIF NOT (COALESCE(previous_context.context->'entries','[]'::jsonb) @> jsonb_build_array(item)) THEN
      RAISE EXCEPTION 'Retained context entries and their authors cannot be rewritten'
        USING ERRCODE='23514',CONSTRAINT='specialist_context_entry_attribution';
    END IF;
  END LOOP;
  FOR previous_item IN SELECT value FROM jsonb_array_elements(COALESCE(previous_context.context->'entries','[]'::jsonb)) LOOP
    IF NOT (NEW.context->'entries' @> jsonb_build_array(previous_item)) AND NOT EXISTS(
      SELECT 1 FROM jsonb_array_elements(NEW.context->'entries') replacement
      WHERE replacement->'introducedRevision'=to_jsonb(NEW.revision)
        AND replacement->'entry'->>'supersedesEntryId'=previous_item->'entry'->>'id'
    ) THEN
      RAISE EXCEPTION 'Removing context requires an explicit replacement; immutable history remains retained'
        USING ERRCODE='23514',CONSTRAINT='specialist_context_entry_replacement';
    END IF;
  END LOOP;
  RETURN NEW;
END $function$;
