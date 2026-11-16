CREATE OR REPLACE FUNCTION public.guard_stand_revision_insert()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE head stand_targets;
BEGIN
  SELECT * INTO head FROM stand_targets WHERE id=NEW.target_id FOR NO KEY UPDATE;
  IF head.id IS NULL OR head.config_revision<>NEW.revision OR head.enabled<>NEW.enabled
     OR NEW.authority->'owner'->>'companyId' IS DISTINCT FROM head.company_id
     OR NEW.authority->>'action' IS DISTINCT FROM 'targets:manage' THEN
    RAISE EXCEPTION 'Stand revision must describe its exact owned head' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$function$;
