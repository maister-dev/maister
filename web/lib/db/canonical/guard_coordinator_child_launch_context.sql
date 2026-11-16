CREATE OR REPLACE FUNCTION public.guard_coordinator_child_launch_context()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
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
END $function$;
