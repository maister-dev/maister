CREATE OR REPLACE FUNCTION public.guard_native_assignment_transport()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE receipt specialist_delivery_receipts%ROWTYPE;
BEGIN
  IF TG_OP='UPDATE' AND (OLD.specialist_delivery_id IS NOT NULL OR NEW.specialist_delivery_id IS NOT NULL) THEN
    IF ROW(NEW.id,NEW.event_id,NEW.subscription_id,NEW.push_subscription_id,NEW.specialist_delivery_id,NEW.idempotency_key,NEW.created_at)
      IS DISTINCT FROM ROW(OLD.id,OLD.event_id,OLD.subscription_id,OLD.push_subscription_id,OLD.specialist_delivery_id,OLD.idempotency_key,OLD.created_at) THEN
      RAISE EXCEPTION 'Native transport identity and target are immutable'
        USING ERRCODE='23514',CONSTRAINT='native_assignment_transport_immutable';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.specialist_delivery_id IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO receipt FROM specialist_delivery_receipts WHERE id=NEW.specialist_delivery_id FOR SHARE;
  IF NOT FOUND OR NEW.event_id IS DISTINCT FROM receipt.outbox_event_id THEN
    RAISE EXCEPTION 'Native transport requires its exact frozen origin delivery intent'
      USING ERRCODE='23514',CONSTRAINT='native_assignment_transport_reference';
  END IF;
  RETURN NEW;
END $function$;
