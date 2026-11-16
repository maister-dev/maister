ALTER TABLE "project_tokens" DROP CONSTRAINT "project_tokens_company_scope_check";--> statement-breakpoint
ALTER TABLE "specialist_work_decisions" DROP CONSTRAINT "specialist_work_decisions_shape_check";--> statement-breakpoint
ALTER TABLE "project_tokens" ADD CONSTRAINT "project_tokens_company_scope_check" CHECK ((("project_tokens"."company_id" IS NULL AND "project_tokens"."company_run_id" IS NULL) OR ("project_tokens"."company_id" IS NOT NULL AND "project_tokens"."company_run_id" IS NOT NULL AND "project_tokens"."project_id" IS NULL AND "project_tokens"."token_kind"='agent' AND "project_tokens"."agent_id" IS NOT NULL AND "project_tokens"."name"='agent-run:'||"project_tokens"."company_run_id" AND "project_tokens"."expires_at" IS NOT NULL AND "project_tokens"."librarian_turn_id" IS NULL AND jsonb_typeof("project_tokens"."scopes")='array' AND "project_tokens"."scopes"<@'["knowledge:read","knowledge:propose","assignments:read","assignments:update","assignments:accept"]'::jsonb)) IS TRUE);--> statement-breakpoint
ALTER TABLE "specialist_work_decisions" ADD CONSTRAINT "specialist_work_decisions_shape_check" CHECK ((
        "specialist_work_decisions"."work_revision">0 AND "specialist_work_decisions"."expected_revision">0 AND "specialist_work_decisions"."input_revision">0
        AND "specialist_work_decisions"."result_revision">0 AND "specialist_work_decisions"."decision" IN ('rework','accept')
        AND "specialist_work_decisions"."request_key" ~ '^[A-Za-z0-9._:-]{8,128}$'
        AND "specialist_work_decisions"."request_sha256" ~ '^[a-f0-9]{64}$'
        AND char_length("specialist_work_decisions"."reason") BETWEEN 1 AND 8000
        AND (CASE WHEN jsonb_typeof("specialist_work_decisions"."actor")='object' THEN
    "specialist_work_decisions"."actor" ?& ARRAY['kind','id','runId','attemptId']
    AND "specialist_work_decisions"."actor" - ARRAY['kind','id','runId','attemptId']='{}'::jsonb
    AND "specialist_work_decisions"."actor"->>'kind' IN ('user','agent','system')
    AND jsonb_typeof("specialist_work_decisions"."actor"->'id')='string'
    AND char_length("specialist_work_decisions"."actor"->>'id') BETWEEN 1 AND 192
    AND ("specialist_work_decisions"."actor"->'runId'='null'::jsonb OR (jsonb_typeof("specialist_work_decisions"."actor"->'runId')='string' AND char_length("specialist_work_decisions"."actor"->>'runId') BETWEEN 1 AND 128))
    AND ("specialist_work_decisions"."actor"->'attemptId'='null'::jsonb OR (jsonb_typeof("specialist_work_decisions"."actor"->'attemptId')='string' AND char_length("specialist_work_decisions"."actor"->>'attemptId') BETWEEN 1 AND 128))
    ELSE false END) IS TRUE
        AND (("specialist_work_decisions"."decision"='rework' AND "specialist_work_decisions"."actor"->>'kind'='agent')
          OR ("specialist_work_decisions"."decision"='accept' AND (
            ("specialist_work_decisions"."actor"->>'kind'='user' AND "specialist_work_decisions"."actor"->'runId'='null'::jsonb AND "specialist_work_decisions"."actor"->'attemptId'='null'::jsonb)
            OR ("specialist_work_decisions"."actor"->>'kind'='agent' AND jsonb_typeof("specialist_work_decisions"."actor"->'runId')='string')
          )))
        AND "specialist_work_decisions"."authority_snapshot"->'schemaVersion'='1'::jsonb
        AND "specialist_work_decisions"."authority_snapshot"->'actor'="specialist_work_decisions"."actor"
        AND pg_column_size("specialist_work_decisions"."authority_snapshot")<=32768
      ) IS TRUE);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION guard_specialist_work_rework_decision() RETURNS trigger LANGUAGE plpgsql AS $$
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
      AND work.decision_state='open' AND child.status='Done'
      AND (
        (NEW.decision='accept' AND NEW.actor->>'kind'='user' AND EXISTS (
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
      AND result.revision=NEW.result_revision AND result.validity='valid' AND result.first_collected_at IS NOT NULL
      AND result.schema_ref=work.definition->'objectiveInput'->'expectedResult'->>'schemaRef'
      AND result.schema_version::text=work.definition->'objectiveInput'->'expectedResult'->>'schemaVersion'
      AND result.schema_sha256=work.definition->'objectiveInput'->'expectedResult'->>'sha256'
  ) THEN
    RAISE EXCEPTION 'A work decision requires the exact collected result and work revision'
      USING ERRCODE='23514',CONSTRAINT='specialist_work_decision_result_required';
  END IF;
  RETURN NEW;
END $$;
