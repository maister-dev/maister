CREATE OR REPLACE FUNCTION public.agent_memory_immutable_history()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  RAISE EXCEPTION 'Agent memory history is immutable'
    USING ERRCODE = '23514', CONSTRAINT = 'agent_memory_immutable_history';
END;
$function$;
