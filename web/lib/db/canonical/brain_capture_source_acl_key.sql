CREATE OR REPLACE FUNCTION public.brain_capture_source_acl_key()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  NEW.source_acl_key := encode(sha256(convert_to(coalesce(NEW.source_restrictions,'null'::jsonb)::text,'UTF8')),'hex');
  RETURN NEW;
END $function$;
