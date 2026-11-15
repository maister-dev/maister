CREATE OR REPLACE FUNCTION public.check_stand_successor_transfer()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM stand_operations predecessor JOIN stand_operations successor ON successor.predecessor_id=predecessor.id
    JOIN stand_resource_claims claim ON claim.operation_id=successor.id AND claim.canonical_resource_key=successor.resource_key
    WHERE predecessor.id=NEW.id AND predecessor.effect_state='unknown'
      AND successor.effect_state='not_dispatched' AND claim.unresolved
  ) THEN
    RAISE EXCEPTION 'A stand successor decision must transfer the unresolved resource claim' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END;
$function$;
