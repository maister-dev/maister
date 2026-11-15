CREATE OR REPLACE FUNCTION public.set_specialist_epoch_start()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP='INSERT' OR NEW.epoch<>OLD.epoch THEN
    NEW.epoch_started_at:=NEW.renewed_at;
  ELSE
    NEW.epoch_started_at:=OLD.epoch_started_at;
  END IF;
  RETURN NEW;
END $function$;
