CREATE OR REPLACE FUNCTION public.guard_specialist_delivery_receipt()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE source domain_events%ROWTYPE;
BEGIN
  IF TG_OP<>'INSERT' THEN
    RAISE EXCEPTION 'Origin delivery identity and retained source witness are immutable'
      USING ERRCODE='23514',CONSTRAINT='specialist_delivery_receipt_immutable';
  END IF;
  IF NEW.source_event_id !~ '^[1-9][0-9]{0,15}$' THEN
    RAISE EXCEPTION 'Origin delivery event identity is invalid'
      USING ERRCODE='23514',CONSTRAINT='specialist_delivery_receipt_reference';
  END IF;
  SELECT * INTO source FROM domain_events WHERE id=NEW.source_event_id::bigint FOR SHARE;
  IF NOT FOUND OR source.assignment_result IS NULL OR source.assignment_result IS DISTINCT FROM NEW.snapshot
    OR source.run_id IS DISTINCT FROM NEW.run_id THEN
    RAISE EXCEPTION 'Origin delivery requires its exact server-captured native result event'
      USING ERRCODE='23514',CONSTRAINT='specialist_delivery_receipt_reference';
  END IF;
  RETURN NEW;
END $function$;
