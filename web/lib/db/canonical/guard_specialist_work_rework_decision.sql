CREATE OR REPLACE FUNCTION public.guard_specialist_work_rework_decision()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP<>'INSERT' THEN
    RAISE EXCEPTION 'Logical work decisions are immutable'
      USING ERRCODE='23514',CONSTRAINT='specialist_work_decision_immutable';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM specialist_work work
    JOIN runs child ON child.id=work.child_run_id AND child.parent_run_id=work.parent_run_id
    JOIN runs parent ON parent.id=work.parent_run_id
    JOIN run_results result ON result.id=NEW.result_id AND result.run_id=child.id
    WHERE work.id=NEW.work_id AND work.work_revision=NEW.work_revision
      AND work.input_revision=NEW.input_revision AND work.revision=NEW.expected_revision
      AND work.decision_state='open'
      AND (
        (NEW.decision IN ('accept','reject') AND NEW.actor->>'kind'='user' AND EXISTS (
          SELECT 1 FROM users author WHERE author.id=NEW.actor->>'id' AND author.account_status='active'
        )) OR (NEW.actor->>'kind'='agent' AND parent.status='Running' AND
          NEW.actor->>'runId'=work.parent_run_id AND NEW.actor->>'id'=work.actor->>'id'
          AND (
            (parent.run_kind='agent' AND NEW.actor->'attemptId'='null'::jsonb)
            OR (parent.run_kind='flow' AND EXISTS (
              SELECT 1 FROM node_attempts node
              WHERE node.id=NEW.actor->>'attemptId' AND node.run_id=parent.id AND node.node_id=parent.current_step_id
                AND node.status='Running' AND node.knowledge_actor->>'agentId'=NEW.actor->>'id'
                AND NOT EXISTS (
                  SELECT 1 FROM node_attempts newer WHERE newer.run_id=node.run_id AND newer.node_id=node.node_id AND newer.attempt>node.attempt
                )
            ))
          )
        )
      )
      AND result.revision=NEW.result_revision
      AND (
        (NEW.interruption_command_id IS NULL AND child.status='Done'
          AND result.validity='valid' AND result.first_collected_at IS NOT NULL)
        OR (NEW.interruption_command_id IS NOT NULL AND NEW.decision='rework'
          AND NEW.actor->>'kind'='agent' AND NEW.reason=work.definition->'objectiveInput'->>'objective'
          AND specialist_interrupted_child_prompt(work.id,work.work_revision,result.id)=NEW.interruption_command_id)
      )
      AND result.schema_ref=work.definition->'objectiveInput'->'expectedResult'->>'schemaRef'
      AND result.schema_version::text=work.definition->'objectiveInput'->'expectedResult'->>'schemaVersion'
      AND result.schema_sha256=work.definition->'objectiveInput'->'expectedResult'->>'sha256'
  ) THEN
    RAISE EXCEPTION 'A work decision requires the exact collected result and work revision'
      USING ERRCODE='23514',CONSTRAINT='specialist_work_decision_result_required';
  END IF;
  RETURN NEW;
END $function$;
