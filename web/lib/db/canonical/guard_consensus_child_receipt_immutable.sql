CREATE OR REPLACE FUNCTION public.guard_consensus_child_receipt_immutable()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.task_admission_snapshot->'version'='3'::jsonb AND OLD.task_admission_snapshot->'version' IS DISTINCT FROM '3'::jsonb THEN
    RAISE EXCEPTION 'Consensus child admission is established only at creation'
      USING ERRCODE='23514',CONSTRAINT='runs_consensus_admission_immutable';
  END IF;
  IF OLD.task_admission_snapshot->'version'='3'::jsonb AND (
    OLD.task_admission_snapshot IS DISTINCT FROM NEW.task_admission_snapshot
    OR (OLD.project_id,OLD.task_id,OLD.parent_run_id,OLD.root_run_id,OLD.run_kind,OLD.agent_id,OLD.agent_workspace,OLD.persistent,OLD.workspace_mode,OLD.trigger_payload)
      IS DISTINCT FROM (NEW.project_id,NEW.task_id,NEW.parent_run_id,NEW.root_run_id,NEW.run_kind,NEW.agent_id,NEW.agent_workspace,NEW.persistent,NEW.workspace_mode,NEW.trigger_payload)) THEN
    RAISE EXCEPTION 'Consensus child admission and source are immutable'
      USING ERRCODE='23514',CONSTRAINT='runs_consensus_admission_immutable';
  END IF;
  RETURN NEW;
END $function$;
