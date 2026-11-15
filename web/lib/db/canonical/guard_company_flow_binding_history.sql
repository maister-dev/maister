CREATE OR REPLACE FUNCTION public.guard_company_flow_binding_history()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  RAISE EXCEPTION 'Accepted company Flow configuration history is immutable' USING ERRCODE='23514';
END;
$function$;
