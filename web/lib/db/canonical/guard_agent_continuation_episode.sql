CREATE OR REPLACE FUNCTION public.guard_agent_continuation_episode()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NOT EXISTS (
    SELECT FROM execution_assignments a
    JOIN runs r ON r.id = a.run_id
    WHERE a.id = NEW.assignment_id AND a.run_id = NEW.run_id
      AND a.epoch = NEW.assignment_epoch AND r.agent_kind = 'operational'
  ) OR (NEW.preparation_id IS NOT NULL AND NOT EXISTS (
    SELECT FROM agent_preparation_operations p
    WHERE p.id = NEW.preparation_id AND p.run_id = NEW.run_id
      AND p.assignment_id = NEW.assignment_id AND p.assignment_epoch = NEW.assignment_epoch
  )) THEN
    RAISE EXCEPTION 'Continuation episode requires the exact operational assignment and preparation'
      USING ERRCODE='23514', CONSTRAINT='agent_continuation_owner';
  END IF;
  IF TG_OP = 'UPDATE' AND (
    ROW(OLD.run_id, OLD.logical_key, OLD.created_at) IS DISTINCT FROM ROW(NEW.run_id, NEW.logical_key, NEW.created_at)
    OR NEW.attempts < OLD.attempts OR NEW.settlement_attempts < OLD.settlement_attempts
    OR OLD.state = 'closed'
    OR (OLD.state = 'attention' AND NEW.state NOT IN ('attention', 'settlement', 'closed'))
    OR (OLD.state = 'settlement' AND NEW.state NOT IN ('settlement', 'attention', 'closed'))
  ) THEN
    RAISE EXCEPTION 'Continuation episode cannot regress or rewrite a closed receipt'
      USING ERRCODE='23514', CONSTRAINT='agent_continuation_transition';
  END IF;
  RETURN NEW;
END
$function$;
