CREATE OR REPLACE FUNCTION public.agent_memory_require_redaction_admin()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  PERFORM 1 FROM users WHERE id = NEW.administrator_id AND role = 'admin' AND account_status = 'active' FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Agent memory redaction requires a current administrator'
      USING ERRCODE = '23514', CONSTRAINT = 'agent_memory_redaction_admin_required';
  END IF;
  RETURN NEW;
END;
$function$;
