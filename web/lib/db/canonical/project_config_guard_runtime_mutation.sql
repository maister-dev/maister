CREATE OR REPLACE FUNCTION public.project_config_guard_runtime_mutation()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
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
$function$;
