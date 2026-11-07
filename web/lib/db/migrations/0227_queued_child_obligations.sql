ALTER TABLE "execution_commands" ADD COLUMN "coordinator_child_launch_context" jsonb;--> statement-breakpoint
ALTER TABLE "project_tokens" ADD COLUMN "bound_run_id" text;--> statement-breakpoint
ALTER TABLE "project_tokens" ADD COLUMN "origin_kind" text;--> statement-breakpoint
ALTER TABLE "project_tokens" ADD COLUMN "revocation_reason" text;--> statement-breakpoint
ALTER TABLE "task_launch_intents" ADD COLUMN "parent_observed_version" integer;--> statement-breakpoint
CREATE INDEX "project_tokens_run_origin_idx" ON "project_tokens" USING btree ("project_id","origin_kind","bound_run_id") WHERE "project_tokens"."bound_run_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "task_launch_intents_parent_obligations_idx" ON "task_launch_intents" USING btree ("project_id",("basis"->'parent'->>'parentRunId'),"accepted_at","id") WHERE "task_launch_intents"."basis"->>'kind'='execution_child' AND "task_launch_intents"."run_id" IS NULL AND "task_launch_intents"."original_run_id" IS NULL;--> statement-breakpoint
ALTER TABLE "execution_commands" ADD CONSTRAINT "execution_commands_coordinator_child_context_check" CHECK ("execution_commands"."coordinator_child_launch_context" IS NULL OR ("execution_commands"."kind"='session.prompt' AND "execution_commands"."owner_kind"='flow_node_attempt' AND "execution_commands"."owner_ref"->>'variant' IN ('node','permission_resume') AND jsonb_typeof("execution_commands"."coordinator_child_launch_context")='object' AND "execution_commands"."coordinator_child_launch_context"->'version'='1'::jsonb AND "execution_commands"."coordinator_child_launch_context"->>'nodeAttemptId'="execution_commands"."owner_ref"->>'nodeAttemptId' AND "execution_commands"."coordinator_child_launch_context"->'promptOrdinal'="execution_commands"."owner_ref"->'promptOrdinal' AND "execution_commands"."coordinator_child_launch_context"->>'requestSha256'="execution_commands"."request_sha256" AND jsonb_typeof("execution_commands"."coordinator_child_launch_context"->'receipts')='array' AND jsonb_array_length("execution_commands"."coordinator_child_launch_context"->'receipts') BETWEEN 1 AND 64 AND "execution_commands"."coordinator_child_launch_context"-ARRAY['version','nodeAttemptId','promptOrdinal','requestSha256','receipts']='{}'::jsonb AND octet_length("execution_commands"."coordinator_child_launch_context"::text)<=65536) IS TRUE);--> statement-breakpoint
ALTER TABLE "project_tokens" ADD CONSTRAINT "project_tokens_origin_binding_check" CHECK ((("project_tokens"."origin_kind" IS NULL AND "project_tokens"."bound_run_id" IS NULL) OR (
        "project_tokens"."bound_run_id" IS NOT NULL AND length("project_tokens"."bound_run_id") > 0 AND "project_tokens"."project_id" IS NOT NULL
        AND (("project_tokens"."origin_kind" = 'orchestrator_run' AND "project_tokens"."token_kind" = 'project' AND "project_tokens"."agent_id" IS NULL)
          OR ("project_tokens"."origin_kind" = 'agent_run' AND "project_tokens"."token_kind" = 'agent' AND "project_tokens"."agent_id" IS NOT NULL)))) IS TRUE);--> statement-breakpoint
ALTER TABLE "project_tokens" ADD CONSTRAINT "project_tokens_revocation_reason_check" CHECK ("project_tokens"."revocation_reason" IS NULL OR ("project_tokens"."revocation_reason" IN ('rotation','revoked') AND "project_tokens"."revoked_at" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "project_tokens" ADD CONSTRAINT "project_tokens_rotation_origin_check" CHECK (("project_tokens"."revocation_reason" IS DISTINCT FROM 'rotation' OR ("project_tokens"."origin_kind" = 'orchestrator_run' AND "project_tokens"."bound_run_id" IS NOT NULL AND jsonb_typeof("project_tokens"."scopes")='array' AND ("project_tokens"."scopes" ? 'runs:delegate' OR "project_tokens"."scopes" ? '*'))) IS TRUE);--> statement-breakpoint
ALTER TABLE "task_launch_intents" ADD CONSTRAINT "task_launch_intents_parent_observation_check" CHECK ("task_launch_intents"."parent_observed_version" IS NULL OR ("task_launch_intents"."parent_observed_version">0 AND "task_launch_intents"."parent_observed_version"<="task_launch_intents"."state_version" AND "task_launch_intents"."basis"->>'kind'='execution_child' AND "task_launch_intents"."run_id" IS NULL AND "task_launch_intents"."original_run_id" IS NULL AND "task_launch_intents"."state" IN ('failed','cancelled')) IS TRUE);--> statement-breakpoint
CREATE FUNCTION guard_project_token_run_origin() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.origin_kind IS NOT NULL AND NOT EXISTS(
      SELECT 1 FROM runs owner WHERE owner.id=NEW.bound_run_id AND owner.project_id=NEW.project_id
        AND ((NEW.origin_kind='orchestrator_run' AND owner.run_kind='flow')
          OR (NEW.origin_kind='agent_run' AND owner.run_kind='agent' AND owner.agent_id=NEW.agent_id))
    ) THEN
      RAISE EXCEPTION 'Machine token origin must match its actual run'
        USING ERRCODE='23514',CONSTRAINT='project_tokens_run_origin_owner';
    END IF;
  END IF;
  IF TG_OP='UPDATE' THEN
    IF ROW(NEW.origin_kind,NEW.bound_run_id) IS DISTINCT FROM ROW(OLD.origin_kind,OLD.bound_run_id)
      OR OLD.origin_kind IS NOT NULL AND ROW(NEW.project_id,NEW.token_kind,NEW.agent_id)
        IS DISTINCT FROM ROW(OLD.project_id,OLD.token_kind,OLD.agent_id) THEN
      RAISE EXCEPTION 'Machine token origin is immutable'
        USING ERRCODE='23514',CONSTRAINT='project_tokens_run_origin_immutable';
    END IF;
    IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at
      OR OLD.revocation_reason='revoked' AND NEW.revocation_reason IS DISTINCT FROM 'revoked'
      OR OLD.revocation_reason='rotation' AND NEW.revocation_reason IS NULL
      OR OLD.revoked_at IS NOT NULL AND OLD.revocation_reason IS NULL AND NEW.revocation_reason='rotation' THEN
      RAISE EXCEPTION 'Token revocation cannot be restored or reclassified as rotation'
        USING ERRCODE='23514',CONSTRAINT='project_tokens_revocation_monotonic';
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER project_tokens_run_origin_guard BEFORE INSERT OR UPDATE ON project_tokens
  FOR EACH ROW EXECUTE FUNCTION guard_project_token_run_origin();
--> statement-breakpoint
CREATE FUNCTION guard_coordinator_child_launch_context() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE receipt jsonb;
BEGIN
  IF TG_OP='UPDATE' AND NEW.coordinator_child_launch_context IS DISTINCT FROM OLD.coordinator_child_launch_context THEN
    RAISE EXCEPTION 'Coordinator child context is immutable with its original prompt'
      USING ERRCODE='23514',CONSTRAINT='execution_commands_coordinator_context_immutable';
  END IF;
  IF TG_OP='INSERT' AND NEW.coordinator_child_launch_context IS NOT NULL THEN
    IF NOT EXISTS(SELECT 1 FROM node_attempts attempt WHERE attempt.id=NEW.coordinator_child_launch_context->>'nodeAttemptId'
      AND attempt.run_id=NEW.run_id AND attempt.node_type='orchestrator'
      AND to_jsonb(attempt.action_prompt_ordinal)=NEW.coordinator_child_launch_context->'promptOrdinal') THEN
      RAISE EXCEPTION 'Child context requires its actual coordinator prompt owner'
        USING ERRCODE='23514',CONSTRAINT='execution_commands_coordinator_context_owner';
    END IF;
    FOR receipt IN SELECT value FROM jsonb_array_elements(NEW.coordinator_child_launch_context->'receipts') LOOP
      IF NOT (jsonb_typeof(receipt)='object' AND receipt ?& ARRAY['intentId','taskId','state','stateVersion','reason']
        AND receipt-ARRAY['intentId','taskId','state','stateVersion','reason']='{}'::jsonb
        AND jsonb_typeof(receipt->'intentId')='string' AND length(receipt->>'intentId') BETWEEN 1 AND 256
        AND jsonb_typeof(receipt->'taskId')='string' AND length(receipt->>'taskId') BETWEEN 1 AND 256
        AND receipt->>'state' IN ('queued','preparing','held','failed','cancelled')
        AND jsonb_typeof(receipt->'stateVersion')='number' AND receipt->>'stateVersion' ~ '^[1-9][0-9]*$'
        AND (receipt->'reason'='null'::jsonb OR receipt->>'reason' ~ '^[a-z][a-z0-9_]{0,127}$')) IS TRUE THEN
        RAISE EXCEPTION 'Coordinator child receipt must be bounded structured diagnostic data'
          USING ERRCODE='23514',CONSTRAINT='execution_commands_coordinator_context_receipt';
      END IF;
    END LOOP;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER execution_commands_coordinator_context_guard BEFORE INSERT OR UPDATE ON execution_commands
  FOR EACH ROW EXECUTE FUNCTION guard_coordinator_child_launch_context();
--> statement-breakpoint
CREATE FUNCTION guard_task_launch_parent_observation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' AND NEW.parent_observed_version IS NOT NULL THEN
    RAISE EXCEPTION 'A new accepted request has not been observed by its parent'
      USING ERRCODE='23514',CONSTRAINT='task_launch_parent_observation_initial';
  END IF;
  IF TG_OP='UPDATE' AND NEW.parent_observed_version IS DISTINCT FROM OLD.parent_observed_version THEN
    IF NEW.parent_observed_version IS NULL OR NEW.parent_observed_version IS DISTINCT FROM OLD.state_version
      OR OLD.parent_observed_version IS NOT NULL AND NEW.parent_observed_version<OLD.parent_observed_version
      OR to_jsonb(NEW)-'parent_observed_version' IS DISTINCT FROM to_jsonb(OLD)-'parent_observed_version'
      OR NOT EXISTS(SELECT 1 FROM runs parent
        JOIN node_attempts attempt ON attempt.run_id=parent.id AND attempt.node_id=parent.current_step_id
        JOIN execution_commands command ON command.id=attempt.action_completion->>'commandId'
        WHERE parent.id=OLD.basis->'parent'->>'parentRunId' AND parent.project_id=OLD.project_id
          AND parent.status='Running' AND attempt.node_type='orchestrator' AND attempt.status='Running'
          AND command.run_id=parent.id AND command.state='succeeded' AND command.application_state='applied'
          AND command.coordinator_child_launch_context->>'requestSha256'=command.request_sha256
          AND EXISTS(SELECT 1 FROM jsonb_array_elements(command.coordinator_child_launch_context->'receipts') receipt
            WHERE receipt->>'intentId'=OLD.id AND receipt->>'taskId'=OLD.task_id
              AND receipt->>'state'=OLD.state AND receipt->'stateVersion'=to_jsonb(OLD.state_version))) THEN
      RAISE EXCEPTION 'Only the exact completed coordinator input can observe this terminal request'
        USING ERRCODE='23514',CONSTRAINT='task_launch_parent_observation_owner';
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER task_launch_parent_observation_guard BEFORE INSERT OR UPDATE ON task_launch_intents
  FOR EACH ROW EXECUTE FUNCTION guard_task_launch_parent_observation();
