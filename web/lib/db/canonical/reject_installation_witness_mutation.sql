CREATE OR REPLACE FUNCTION public.reject_installation_witness_mutation()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  RAISE EXCEPTION 'Installation authority and source witnesses are immutable' USING ERRCODE='23514';
END;
$function$;
