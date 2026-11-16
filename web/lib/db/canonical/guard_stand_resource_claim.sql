CREATE OR REPLACE FUNCTION public.guard_stand_resource_claim()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP='DELETE' THEN
    IF OLD.unresolved THEN
      RAISE EXCEPTION 'An unresolved stand resource claim cannot be deleted' USING ERRCODE='23514';
    END IF;
    RETURN OLD;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM stand_operations operation WHERE operation.id=NEW.operation_id
      AND operation.resource_key=NEW.canonical_resource_key AND operation.action='restart'
      AND (NEW.unresolved OR operation.effect_state IN ('confirmed_applied','confirmed_not_applied'))
  ) THEN
    RAISE EXCEPTION 'Stand resource claim must name an exact restart and retain unresolved effects' USING ERRCODE='23514';
  END IF;
  IF TG_OP='UPDATE' AND (
    NEW.canonical_resource_key<>OLD.canonical_resource_key OR NEW.owner_epoch<OLD.owner_epoch
    OR ((NEW.owner_id,NEW.operation_id) IS DISTINCT FROM (OLD.owner_id,OLD.operation_id) AND NEW.owner_epoch<=OLD.owner_epoch)
    OR (OLD.unresolved AND NEW.operation_id<>OLD.operation_id AND NOT EXISTS (
      SELECT 1 FROM stand_operations successor JOIN stand_operations predecessor ON predecessor.id=successor.predecessor_id
      WHERE successor.id=NEW.operation_id AND predecessor.id=OLD.operation_id
        AND predecessor.effect_state='unknown' AND predecessor.disposition='authorized_successor'
    ))
  ) THEN
    RAISE EXCEPTION 'Stand claim ownership changes require a higher epoch on the same resource' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$function$;
