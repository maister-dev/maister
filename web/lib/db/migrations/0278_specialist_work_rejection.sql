ALTER TABLE "specialist_work" DROP CONSTRAINT "specialist_work_shape_check";--> statement-breakpoint
ALTER TABLE "specialist_work_decisions" DROP CONSTRAINT "specialist_work_decisions_shape_check";--> statement-breakpoint
ALTER TABLE "specialist_work" ADD CONSTRAINT "specialist_work_shape_check" CHECK ((
      char_length("specialist_work"."id") BETWEEN 1 AND 128 AND "specialist_work"."work_revision">0 AND "specialist_work"."input_revision">0 AND "specialist_work"."revision">0
      AND char_length("specialist_work"."logical_work_id") BETWEEN 1 AND 128 AND "specialist_work"."logical_work_id" ~ '^[A-Za-z0-9._:-]+$'
      AND "specialist_work"."decision_state" IN ('open','clarification_requested','accepted','rejected','rework_requested','cancelled')
      AND "specialist_work"."input_sha256" ~ '^[a-f0-9]{64}$' AND "specialist_work"."definition_sha256" ~ '^[a-f0-9]{64}$'
      AND "specialist_work"."request_sha256" ~ '^[a-f0-9]{64}$' AND "specialist_work"."source_key" ~ '^[a-f0-9]{64}$'
      AND char_length("specialist_work"."reserved_run_id") BETWEEN 1 AND 128 AND "specialist_work"."reserved_run_id"<>"specialist_work"."parent_run_id"
      AND ("specialist_work"."child_run_id" IS NULL OR "specialist_work"."child_run_id"="specialist_work"."reserved_run_id")
    ) IS TRUE);--> statement-breakpoint
ALTER TABLE "specialist_work_decisions" ADD CONSTRAINT "specialist_work_decisions_shape_check" CHECK ((
        "specialist_work_decisions"."work_revision">0 AND "specialist_work_decisions"."expected_revision">0 AND "specialist_work_decisions"."input_revision">0
        AND "specialist_work_decisions"."result_revision">0 AND "specialist_work_decisions"."decision" IN ('rework','accept','reject')
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
          OR ("specialist_work_decisions"."decision" IN ('accept','reject') AND (
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
--> statement-breakpoint
CREATE OR REPLACE FUNCTION guard_specialist_work() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  subject specialist_assignments%ROWTYPE;
  source runs%ROWTYPE;
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'Logical work and its immutable definitions must be retained'
      USING ERRCODE='23514',CONSTRAINT='specialist_work_retained';
  END IF;
  IF TG_OP='UPDATE' THEN
    IF ROW(NEW.id,NEW.work_revision,NEW.assignment_id,NEW.input_revision,NEW.input_sha256,NEW.logical_work_id,NEW.parent_run_id,
      NEW.definition,NEW.definition_sha256,NEW.actor,NEW.authority_snapshot,NEW.bounds,NEW.source_restrictions,NEW.request_sha256,NEW.source_key,NEW.reserved_run_id,NEW.created_at)
      IS DISTINCT FROM ROW(OLD.id,OLD.work_revision,OLD.assignment_id,OLD.input_revision,OLD.input_sha256,OLD.logical_work_id,OLD.parent_run_id,
      OLD.definition,OLD.definition_sha256,OLD.actor,OLD.authority_snapshot,OLD.bounds,OLD.source_restrictions,OLD.request_sha256,OLD.source_key,OLD.reserved_run_id,OLD.created_at) THEN
      RAISE EXCEPTION 'Logical work definition and original attribution are immutable'
        USING ERRCODE='23514',CONSTRAINT='specialist_work_definition_immutable';
    END IF;
    IF NEW.revision::bigint<>OLD.revision::bigint+1 THEN
      RAISE EXCEPTION 'Logical work requires the next business revision'
        USING ERRCODE='23514',CONSTRAINT='specialist_work_business_revision';
    END IF;
    IF OLD.decision_state<>'open' OR (
      NEW.decision_state NOT IN ('open','cancelled') AND NOT (
        NEW.decision_state IN ('rework_requested','accepted','rejected') AND EXISTS (
          SELECT 1 FROM specialist_work_decisions decision
          WHERE decision.work_id=OLD.id AND decision.work_revision=OLD.work_revision
            AND decision.expected_revision=OLD.revision
            AND decision.decision=CASE NEW.decision_state WHEN 'accepted' THEN 'accept' WHEN 'rejected' THEN 'reject' ELSE 'rework' END
        )
      )
    ) OR (NEW.child_run_id IS NOT DISTINCT FROM OLD.child_run_id AND NEW.decision_state IS NOT DISTINCT FROM OLD.decision_state) THEN
      RAISE EXCEPTION 'A logical work decision requires its exact decision-owning contract'
        USING ERRCODE='23514',CONSTRAINT='specialist_work_decision_required';
    END IF;
    IF OLD.child_run_id IS NOT NULL AND NEW.child_run_id IS DISTINCT FROM OLD.child_run_id THEN
      RAISE EXCEPTION 'An executed child cannot be detached or rebound'
        USING ERRCODE='23514',CONSTRAINT='specialist_work_child_immutable';
    END IF;
    IF NEW.decision_state='cancelled' AND NEW.child_run_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM runs child WHERE child.id=NEW.child_run_id AND child.status NOT IN ('Done','Failed','Crashed','Abandoned')
    ) THEN
      RAISE EXCEPTION 'Stop and observe the owned child before cancelling logical work'
        USING ERRCODE='23514',CONSTRAINT='specialist_work_child_live';
    END IF;
  ELSE
    IF NEW.revision<>1 OR NEW.decision_state<>'open' OR NEW.child_run_id IS NOT NULL
      OR (CASE WHEN NEW.work_revision=1 THEN EXISTS (
        SELECT 1 FROM specialist_work work WHERE work.id=NEW.id
          OR (work.assignment_id=NEW.assignment_id AND work.logical_work_id=NEW.logical_work_id)
      ) ELSE NOT EXISTS (
        SELECT 1 FROM specialist_work prior
        JOIN specialist_work_decisions decision ON decision.work_id=prior.id AND decision.work_revision=prior.work_revision
        WHERE prior.id=NEW.id AND prior.work_revision=NEW.work_revision-1
          AND prior.assignment_id=NEW.assignment_id AND prior.logical_work_id=NEW.logical_work_id
          AND prior.parent_run_id=NEW.parent_run_id AND prior.actor->>'id'=NEW.actor->>'id'
          AND prior.decision_state='rework_requested' AND decision.decision='rework'
          AND NEW.actor=decision.actor
          AND NEW.definition->'target'=prior.definition->'target'
          AND NEW.definition->'objectiveInput'->>'objective'=decision.reason
          AND NEW.definition->'objectiveInput'->'expectedResult'=prior.definition->'objectiveInput'->'expectedResult'
      ) END) THEN
      RAISE EXCEPTION 'A logical work request requires its initial revision or an exact preceding rework decision'
        USING ERRCODE='23514',CONSTRAINT='specialist_work_revision_unavailable';
    END IF;
    SELECT * INTO subject FROM specialist_assignments WHERE id=NEW.assignment_id;
    SELECT * INTO source FROM runs WHERE id=NEW.parent_run_id;
    IF subject.id IS NULL OR source.id IS NULL OR subject.input_revision<>NEW.input_revision
      OR subject.status NOT IN ('active','waiting_children') OR source.status<>'Running'
      OR source.project_id IS DISTINCT FROM subject.project_id OR source.company_id IS DISTINCT FROM subject.company_id
      OR source.knowledge_access->>'state' IS DISTINCT FROM 'complete'
      OR NOT specialist_run_has_input(source.id,subject.id,NEW.input_revision,NEW.input_sha256)
      OR NEW.definition->'parent'->>'rootRunId' IS DISTINCT FROM coalesce(source.root_run_id,source.id)
      OR (
        (source.run_kind='agent' AND CASE WHEN subject.company_id IS NOT NULL
          THEN source.source_agent_id ELSE source.agent_id END=NEW.actor->>'id'
          AND NEW.actor->'attemptId'='null'::jsonb)
        OR (source.run_kind='flow' AND EXISTS (
          SELECT 1 FROM node_attempts node WHERE node.id=NEW.actor->>'attemptId' AND node.run_id=source.id AND node.node_id=source.current_step_id
            AND node.status='Running' AND node.knowledge_actor->>'agentId'=NEW.actor->>'id'
            AND NOT EXISTS(SELECT 1 FROM node_attempts newer WHERE newer.run_id=node.run_id AND newer.node_id=node.node_id AND newer.attempt>node.attempt)
        ))
      ) IS NOT TRUE THEN
      RAISE EXCEPTION 'Logical work requires its exact active attributed assignment execution and input'
        USING ERRCODE='23514',CONSTRAINT='specialist_work_source_binding';
    END IF;
    IF subject.context_revision::text IS DISTINCT FROM NEW.definition->'context'->>'revision' OR (
      (subject.context_revision=0 AND NEW.definition->'context'->'contentSha256'='null'::jsonb
        AND NEW.definition->'context'->>'inputRevision'=NEW.input_revision::text AND NEW.definition->'context'->>'inputSha256'=NEW.input_sha256)
      OR (subject.context_revision>0 AND EXISTS (
        SELECT 1 FROM specialist_context_revisions context JOIN specialist_input_revisions input
          ON input.assignment_id=context.assignment_id AND input.revision=context.input_revision
        WHERE context.assignment_id=subject.id AND context.revision=subject.context_revision
          AND context.content_digest=NEW.definition->'context'->>'contentSha256'
          AND context.input_revision::text=NEW.definition->'context'->>'inputRevision' AND input.digest=NEW.definition->'context'->>'inputSha256'
      ))
    ) IS NOT TRUE THEN
      RAISE EXCEPTION 'Logical work must retain the exact available context witness without inventing history'
        USING ERRCODE='23514',CONSTRAINT='specialist_work_context_binding';
    END IF;
    IF EXISTS(SELECT 1 FROM runs WHERE id=NEW.reserved_run_id) THEN
      RAISE EXCEPTION 'A new work reservation cannot claim an existing execution'
        USING ERRCODE='23514',CONSTRAINT='specialist_work_reservation_unused';
    END IF;
  END IF;
  IF TG_OP='INSERT' OR NEW.child_run_id IS DISTINCT FROM OLD.child_run_id THEN
    SELECT * INTO subject FROM specialist_assignments WHERE id=NEW.assignment_id;
    IF specialist_work_target_exists(NEW.definition->'target',subject.company_id,subject.project_id) IS NOT TRUE THEN
      RAISE EXCEPTION 'Logical work target must match its current owned installed binding and available version witness'
        USING ERRCODE='23514',CONSTRAINT='specialist_work_target_binding';
    END IF;
  END IF;
  IF NEW.child_run_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM runs child JOIN specialist_assignments assignment ON assignment.id=NEW.assignment_id
    WHERE child.id=NEW.child_run_id AND child.id=NEW.reserved_run_id AND child.parent_run_id=NEW.parent_run_id
      AND child.root_run_id=NEW.definition->'parent'->>'rootRunId'
      AND child.project_id IS NOT DISTINCT FROM assignment.project_id AND child.company_id IS NOT DISTINCT FROM assignment.company_id
      AND CASE NEW.definition->'target'->>'kind'
        WHEN 'project_agent' THEN child.run_kind='agent' AND child.agent_id=NEW.definition->'target'->'role'->>'agentId'
          AND child.agent_activity_snapshot->>'agentId'=NEW.definition->'target'->'role'->>'agentId'
          AND child.agent_activity_snapshot->>'packageInstallId'=NEW.definition->'target'->'role'->>'packageInstallId'
          AND child.agent_activity_snapshot->>'packageRevision'=NEW.definition->'target'->'role'->>'packageRevision'
          AND child.agent_activity_snapshot->>'definitionSha256'=NEW.definition->'target'->'role'->>'definitionSha256'
        WHEN 'company_agent' THEN child.run_kind='agent' AND child.source_agent_id=NEW.definition->'target'->'role'->>'agentId'
          AND child.agent_activity_snapshot->>'agentId'=NEW.definition->'target'->'role'->>'agentId'
          AND child.agent_activity_snapshot->>'packageInstallId'=NEW.definition->'target'->'role'->>'packageInstallId'
          AND child.agent_activity_snapshot->>'packageRevision'=NEW.definition->'target'->'role'->>'packageRevision'
          AND child.agent_activity_snapshot->>'definitionSha256'=NEW.definition->'target'->'role'->>'definitionSha256'
        WHEN 'project_flow' THEN child.run_kind='flow' AND child.flow_id=NEW.definition->'target'->>'flowId'
          AND child.flow_revision_id=NEW.definition->'target'->'flow'->>'flowRevisionId'
        WHEN 'company_flow' THEN child.run_kind='flow' AND child.source_agent_id=NEW.definition->'target'->'role'->>'agentId'
          AND child.flow_revision_id=NEW.definition->'target'->'flow'->>'flowRevisionId'
        ELSE false END
  ) THEN
    RAISE EXCEPTION 'Logical work can bind only its same-owner reserved direct child'
      USING ERRCODE='23514',CONSTRAINT='specialist_work_child_binding';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION require_specialist_work_rework_continuation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.decision='accept' THEN
    IF NOT EXISTS (
      SELECT 1 FROM specialist_work work
      JOIN specialist_context_revisions history ON history.assignment_id=work.assignment_id
      WHERE work.id=NEW.work_id AND work.work_revision=NEW.work_revision AND work.decision_state='accepted'
        AND history.context->'entries' @> jsonb_build_array(jsonb_build_object(
          'entry',jsonb_build_object('kind','accepted','acceptedWork',jsonb_build_object('decisionId',NEW.id))
        ))
    ) THEN
      RAISE EXCEPTION 'Work acceptance requires its exact accepted working-context entry'
        USING ERRCODE='23514',CONSTRAINT='specialist_work_acceptance_context_required';
    END IF;
    RETURN NEW;
  ELSIF NEW.decision='reject' THEN
    IF NOT EXISTS (
      SELECT 1 FROM specialist_work work
      JOIN specialist_context_revisions history ON history.assignment_id=work.assignment_id
      WHERE work.id=NEW.work_id AND work.work_revision=NEW.work_revision AND work.decision_state='rejected'
        AND history.input_revision=NEW.input_revision AND history.actor=NEW.actor
        AND history.request_key='reject-'||NEW.id AND history.request_digest=NEW.request_sha256
        AND history.context->'entries' @> jsonb_build_array(jsonb_build_object(
          'actor',NEW.actor,'introducedRevision',history.revision,
          'entry',jsonb_build_object('id',NEW.id,'kind','decision','state','resolved','text',NEW.reason)
        ))
    ) THEN
      RAISE EXCEPTION 'Work rejection requires its exact attributed working-context entry'
        USING ERRCODE='23514',CONSTRAINT='specialist_work_rejection_context_required';
    END IF;
    RETURN NEW;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM specialist_work prior JOIN specialist_work continuation
      ON continuation.id=prior.id AND continuation.work_revision=prior.work_revision+1
    WHERE prior.id=NEW.work_id AND prior.work_revision=NEW.work_revision
      AND prior.decision_state='rework_requested'
  ) THEN
    RAISE EXCEPTION 'A rework decision requires its next retained work definition'
      USING ERRCODE='23514',CONSTRAINT='specialist_work_rework_continuation_required';
  END IF;
  RETURN NEW;
END $$;
