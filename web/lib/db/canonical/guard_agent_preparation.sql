CREATE OR REPLACE FUNCTION public.guard_agent_preparation()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE owner execution_assignments%ROWTYPE; target runs%ROWTYPE;
BEGIN
  IF current_setting('maister.agent_preparation_writer',true) IS DISTINCT FROM 'v2' THEN
    RAISE EXCEPTION 'Agent preparation writer v2 required; stop incompatible writers under upgrade maintenance'
      USING ERRCODE='23514',CONSTRAINT='agent_preparation_writer_capability';
  END IF;
  IF TG_OP='UPDATE' AND NEW.phase IN ('claimed','checkout_ready','baseline_ready','materialized','handed_off') AND
    (OLD.lease_expires_at <= clock_timestamp() OR
      array_position(ARRAY['claimed','checkout_ready','baseline_ready','materialized','handed_off'],NEW.phase)
      < array_position(ARRAY['claimed','checkout_ready','baseline_ready','materialized','handed_off'],OLD.phase)) THEN
    RAISE EXCEPTION 'Expired or regressing preparation cannot publish'
      USING ERRCODE='23514',CONSTRAINT='agent_preparation_progress_fenced';
  END IF;
  IF TG_OP='UPDATE' AND (ROW(OLD.id,OLD.run_id,OLD.assignment_id,OLD.assignment_epoch,OLD.resource_id,OLD.incarnation,OLD.created_at)
      IS DISTINCT FROM ROW(NEW.id,NEW.run_id,NEW.assignment_id,NEW.assignment_epoch,NEW.resource_id,NEW.incarnation,NEW.created_at)
      OR OLD.resolved_commit IS NOT NULL AND OLD.resolved_commit IS DISTINCT FROM NEW.resolved_commit
      OR OLD.failure IS NOT NULL AND OLD.failure IS DISTINCT FROM NEW.failure
      OR OLD.phase IN ('handed_off','fenced','failed','cancelled')) THEN
    RAISE EXCEPTION 'Preparation identity and closed receipts are immutable'
      USING ERRCODE='23514',CONSTRAINT='agent_preparation_identity_immutable';
  END IF;
  IF NEW.phase IN ('claimed','checkout_ready','baseline_ready','materialized','handed_off') THEN
    IF NEW.phase<>'handed_off' AND NOT (NEW.lease_expires_at > clock_timestamp()
        AND NEW.lease_expires_at <= clock_timestamp() + interval '61 seconds') IS TRUE THEN
      RAISE EXCEPTION 'Active preparation requires a bounded current lease'
        USING ERRCODE='23514',CONSTRAINT='agent_preparation_lease_required';
    END IF;
    SELECT * INTO owner FROM execution_assignments WHERE id=NEW.assignment_id;
    SELECT * INTO target FROM runs WHERE id=NEW.run_id;
    IF NOT (owner.run_id=NEW.run_id AND owner.epoch=NEW.assignment_epoch AND owner.state='active'
        AND target.execution_assignment_id=owner.id AND target.status='Running') IS TRUE THEN
      RAISE EXCEPTION 'Preparation assignment has been fenced'
        USING ERRCODE='23514',CONSTRAINT='agent_preparation_assignment_required';
    END IF;
    IF NEW.phase IN ('baseline_ready','materialized','handed_off') AND NOT
      (target.operational_integrity_baseline IS NOT NULL AND (target.operational_integrity_baseline->>'generation')::int=NEW.generation) IS TRUE THEN
      RAISE EXCEPTION 'Preparation must reference a captured baseline generation'
        USING ERRCODE='23514',CONSTRAINT='agent_preparation_baseline_required';
    END IF;
    IF NEW.phase='handed_off' AND NOT EXISTS(SELECT 1 FROM agent_turns WHERE id=NEW.turn_id AND run_id=NEW.run_id
        AND execution_assignment_id=NEW.assignment_id AND assignment_epoch=NEW.assignment_epoch) THEN
      RAISE EXCEPTION 'Preparation handoff requires an owned generation turn'
        USING ERRCODE='23514',CONSTRAINT='agent_preparation_handoff_required';
    END IF;
    IF NEW.phase IN ('materialized','handed_off') AND NOT (NEW.generation > 0) IS TRUE THEN
      RAISE EXCEPTION 'Materialized preparation requires a trusted positive generation'
        USING ERRCODE='23514',CONSTRAINT='agent_preparation_generation_required';
    END IF;
  END IF;
  RETURN NEW;
END $function$;
