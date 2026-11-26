CREATE OR REPLACE FUNCTION public.maister_guard_isolated_execution_host()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF EXISTS (SELECT 1 FROM execution_host_losses WHERE execution_host_id = OLD.id)
    AND (NEW.retired_at IS DISTINCT FROM OLD.retired_at OR NEW.host_key IS DISTINCT FROM OLD.host_key
      OR NEW.last_boot_id IS DISTINCT FROM OLD.last_boot_id
      OR NEW.readiness IS DISTINCT FROM 'unavailable'
      OR NEW.readiness_reason IS DISTINCT FROM 'execution_host_permanently_lost')
  THEN
    RAISE EXCEPTION 'permanently isolated execution host cannot be reactivated' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;
