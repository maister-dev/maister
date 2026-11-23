CREATE OR REPLACE FUNCTION public.project_config_declaration_revision()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.kind = 'package' THEN
      UPDATE projects SET config_export_revision = config_export_revision + 1 WHERE id = OLD.project_id;
    END IF;
  ELSIF NEW.kind = 'package' AND (TG_OP = 'INSERT' OR
        ROW(NEW.desired->'source',NEW.desired->'version',NEW.desired->'path')
        IS DISTINCT FROM ROW(OLD.desired->'source',OLD.desired->'version',OLD.desired->'path')) THEN
    UPDATE projects SET config_export_revision = config_export_revision + 1 WHERE id = NEW.project_id;
  END IF;
  RETURN NULL;
END;
$function$;
