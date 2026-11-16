CREATE OR REPLACE FUNCTION public.invalidate_agent_preparation()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_TABLE_NAME='runs' THEN
    IF NEW.status NOT IN ('Running','NeedsInput') OR NEW.execution_assignment_id IS DISTINCT FROM OLD.execution_assignment_id THEN
      UPDATE agent_preparation_operations SET phase=CASE WHEN NEW.status IN ('Done','Failed','Crashed','Abandoned') THEN 'cancelled' ELSE 'fenced' END,
        lease_expires_at=NULL,updated_at=clock_timestamp()
        WHERE run_id=NEW.id AND phase IN ('claimed','checkout_ready','baseline_ready','materialized');
    END IF;
  ELSIF NEW.state<>'active' THEN
    UPDATE agent_preparation_operations SET phase='fenced',lease_expires_at=NULL,updated_at=clock_timestamp()
      WHERE assignment_id=NEW.id AND phase IN ('claimed','checkout_ready','baseline_ready','materialized');
  END IF;
  RETURN NEW;
END $function$;
