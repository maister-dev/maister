CREATE OR REPLACE FUNCTION public.guard_agent_preparation_writer()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.agent_kind='operational' AND NEW.status IN ('Pending','Running')
      AND current_setting('maister.agent_preparation_writer',true) IS DISTINCT FROM 'v2' THEN
    RAISE EXCEPTION 'Agent preparation writer v2 required; stop incompatible writers under upgrade maintenance'
      USING ERRCODE='23514',CONSTRAINT='agent_preparation_writer_capability';
  END IF;
  RETURN NEW;
END $function$;
