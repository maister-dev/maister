CREATE OR REPLACE FUNCTION public.guard_native_knowledge_token_binding()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.knowledge_node_attempt_id IS DISTINCT FROM OLD.knowledge_node_attempt_id
    OR (OLD.knowledge_node_attempt_id IS NOT NULL AND ROW(NEW.name,NEW.token_kind,NEW.project_id) IS DISTINCT FROM ROW(OLD.name,OLD.token_kind,OLD.project_id)) THEN
    RAISE EXCEPTION 'Native coordinator token binding is immutable; issue a new token for a fresh attempt'
      USING ERRCODE='23514', CONSTRAINT='project_tokens_knowledge_node_attempt_immutable';
  END IF;
  RETURN NEW;
END;
$function$;
