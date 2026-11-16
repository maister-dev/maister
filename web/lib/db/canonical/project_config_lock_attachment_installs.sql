CREATE OR REPLACE FUNCTION public.project_config_lock_attachment_installs()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE install_ids text[];
BEGIN
  IF TG_OP = 'INSERT' THEN
    install_ids := ARRAY[NEW.package_install_id];
  ELSIF TG_OP = 'DELETE' THEN
    install_ids := ARRAY[OLD.package_install_id];
  ELSIF ROW(NEW.project_id, NEW.package_install_id, NEW.package_name)
        IS DISTINCT FROM ROW(OLD.project_id, OLD.package_install_id, OLD.package_name) THEN
    install_ids := ARRAY[OLD.package_install_id, NEW.package_install_id];
  ELSE
    RETURN NEW;
  END IF;

  -- Acquire both pin endpoints in a stable order, before the AFTER trigger locks
  -- projects. NOWAIT also refuses inverse orders held by direct SQL callers.
  PERFORM id FROM package_installs
    WHERE id = ANY(install_ids) ORDER BY id FOR SHARE NOWAIT;

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$function$;
