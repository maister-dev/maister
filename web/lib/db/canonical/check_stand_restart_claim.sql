CREATE OR REPLACE FUNCTION public.check_stand_restart_claim()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.action='restart' AND NOT EXISTS (
    SELECT 1 FROM stand_resource_claims claim WHERE claim.operation_id=NEW.id
      AND claim.canonical_resource_key=NEW.resource_key AND claim.unresolved
  ) THEN
    RAISE EXCEPTION 'A stand restart intent requires its resource exclusion' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END;
$function$;
