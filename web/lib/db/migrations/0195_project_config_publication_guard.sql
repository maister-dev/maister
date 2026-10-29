-- Claim locks the project row in a short transaction before accepting intent.
-- Git effects run after commit; this durable fence survives connection loss.
CREATE FUNCTION project_config_guard_runtime_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.name, NEW.main_branch, NEW.branch_prefix, NEW.public_branch_template,
         NEW.default_runner_id, NEW.promotion_mode, NEW.config_export_revision)
     IS DISTINCT FROM
     ROW(OLD.name, OLD.main_branch, OLD.branch_prefix, OLD.public_branch_template,
         OLD.default_runner_id, OLD.promotion_mode, OLD.config_export_revision)
     AND EXISTS (
       SELECT 1 FROM project_config_persist_operations
       WHERE project_id = OLD.id
         AND state IN ('preparing','prepared','publishing','recovery_required')
     ) THEN
    RAISE EXCEPTION 'configuration publication requires completion or recovery before changing settings'
      USING ERRCODE = '55P03';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER project_config_runtime_guard_before_update
BEFORE UPDATE ON projects FOR EACH ROW EXECUTE FUNCTION project_config_guard_runtime_mutation();
