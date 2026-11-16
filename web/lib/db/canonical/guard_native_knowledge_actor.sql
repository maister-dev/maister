CREATE OR REPLACE FUNCTION public.guard_native_knowledge_actor()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF OLD.knowledge_actor IS NOT NULL AND NEW.knowledge_actor IS DISTINCT FROM OLD.knowledge_actor THEN
    RAISE EXCEPTION 'Native node role attribution is immutable; start a fresh attempt for a changed identity'
      USING ERRCODE='23514', CONSTRAINT='node_attempts_knowledge_actor_immutable';
  END IF;
  RETURN NEW;
END;
$function$;
