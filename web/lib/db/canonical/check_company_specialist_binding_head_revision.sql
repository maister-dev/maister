CREATE OR REPLACE FUNCTION public.check_company_specialist_binding_head_revision()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE head company_specialist_bindings;
BEGIN
  SELECT * INTO head FROM company_specialist_bindings WHERE id=NEW.id;
  IF NOT EXISTS(SELECT 1 FROM company_specialist_binding_revisions WHERE binding_id=head.id AND revision=head.revision) THEN
    RAISE EXCEPTION 'Company specialist head requires its immutable configuration revision' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END;
$function$;
