CREATE FUNCTION project_config_install_revision() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE affected_project text;
BEGIN
  IF ROW(NEW.source_url, NEW.name, NEW.version_label, NEW.resolved_revision,
         NEW.manifest->>'sourceSubpath', NEW.package_status)
     IS DISTINCT FROM
     ROW(OLD.source_url, OLD.name, OLD.version_label, OLD.resolved_revision,
         OLD.manifest->>'sourceSubpath', OLD.package_status) THEN
    FOR affected_project IN
      SELECT DISTINCT project_id FROM project_package_attachments
      WHERE package_install_id = OLD.id ORDER BY project_id
    LOOP
      UPDATE projects SET config_export_revision = config_export_revision + 1
      WHERE id = affected_project;
    END LOOP;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER project_config_install_before_update
BEFORE UPDATE ON package_installs FOR EACH ROW EXECUTE FUNCTION project_config_install_revision();
