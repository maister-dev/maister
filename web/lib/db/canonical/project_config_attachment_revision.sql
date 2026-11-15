CREATE OR REPLACE FUNCTION public.project_config_attachment_revision()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE projects SET config_export_revision = config_export_revision + 1 WHERE id = NEW.project_id;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE projects SET config_export_revision = config_export_revision + 1 WHERE id = OLD.project_id;
  ELSIF ROW(NEW.project_id, NEW.package_install_id, NEW.package_name)
        IS DISTINCT FROM ROW(OLD.project_id, OLD.package_install_id, OLD.package_name) THEN
    UPDATE projects SET config_export_revision = config_export_revision + 1
    WHERE id IN (OLD.project_id, NEW.project_id);
  END IF;
  RETURN NULL;
END;
$function$;
