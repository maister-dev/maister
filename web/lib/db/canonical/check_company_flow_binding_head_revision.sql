CREATE OR REPLACE FUNCTION public.check_company_flow_binding_head_revision()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE head company_flow_bindings;
BEGIN
  SELECT * INTO head FROM company_flow_bindings WHERE id=NEW.id;
  IF NOT EXISTS(SELECT 1 FROM company_flow_binding_revisions WHERE binding_id=head.id AND revision=head.revision) THEN
    RAISE EXCEPTION 'Company Flow head requires its immutable configuration revision' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END;
$function$;
