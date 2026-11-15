CREATE OR REPLACE FUNCTION public.guard_specialist_delivery_outbox()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM webhook_events event WHERE event.id=NEW.outbox_event_id
    AND event.project_id IS NULL AND event.run_id IS NULL AND event.type='assignment.result_available'
    AND event.data=jsonb_build_object('ownerUserId',NEW.snapshot->>'requesterUserId','assignmentDeliveryId',NEW.id)) THEN
    RAISE EXCEPTION 'Origin delivery receipt and its exact private outbox intent must commit together'
      USING ERRCODE='23514',CONSTRAINT='specialist_delivery_outbox_reference';
  END IF;
  RETURN NEW;
END $function$;
