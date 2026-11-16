CREATE OR REPLACE FUNCTION public.brain_restrict_record_on_grant()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  UPDATE brain_items SET visibility='restricted' WHERE id=NEW.record_id AND visibility <> 'restricted';
  RETURN NEW;
END $function$;
