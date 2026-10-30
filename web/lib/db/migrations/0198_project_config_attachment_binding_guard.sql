-- Bindings must be visible before an install writer enumerates affected projects.
-- KEY SHARE from the foreign key permits non-key metadata updates and is insufficient.
CREATE FUNCTION project_config_lock_attachment_installs() RETURNS trigger
LANGUAGE plpgsql AS $$
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
$$;
--> statement-breakpoint
CREATE TRIGGER project_config_attachment_before_binding_change
BEFORE INSERT OR UPDATE OR DELETE ON project_package_attachments
FOR EACH ROW EXECUTE FUNCTION project_config_lock_attachment_installs();
